-- Descuento en la cotización (porcentaje o monto fijo), igual que en la OT y
-- la factura, y que viaja: la cotización que sale de una OT trae el descuento
-- de la orden, y al aceptarse (o al engancharse a una orden) se lo pasa a la
-- OT, de donde lo toma la factura.

alter table public.quotations
  add column if not exists discount_percent numeric(5,2)
    check (discount_percent is null or (discount_percent > 0 and discount_percent < 100)),
  add column if not exists discount_fixed numeric(14,2)
    check (discount_fixed is null or discount_fixed > 0);

-- La cotización que nace de una OT hereda su descuento.
create or replace function public.heredar_descuento_de_la_orden()
returns trigger
language plpgsql
as $$
begin
  if new.work_order_id is not null and new.discount_percent is null and new.discount_fixed is null then
    select w.discount_percent, w.discount_fixed
      into new.discount_percent, new.discount_fixed
      from public.work_orders w
     where w.id = new.work_order_id;
  end if;
  return new;
end;
$$;

drop trigger if exists quotations_heredar_descuento on public.quotations;
create trigger quotations_heredar_descuento
  before insert on public.quotations
  for each row execute function public.heredar_descuento_de_la_orden();

-- Al aceptarse la cotización, o al engancharla a una orden que todavía no
-- tiene descuento, el descuento pasa a la OT (y de ahí a la factura).
create or replace function public.pasar_descuento_a_la_orden()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.work_order_id is null then
    return null;
  end if;

  if tg_op = 'UPDATE' and new.status = 'ACEPTADA' and old.status is distinct from 'ACEPTADA' then
    update work_orders
       set discount_percent = new.discount_percent,
           discount_fixed = new.discount_fixed
     where id = new.work_order_id;
  elsif tg_op = 'UPDATE' and new.work_order_id is distinct from old.work_order_id
        and (new.discount_percent is not null or new.discount_fixed is not null) then
    update work_orders
       set discount_percent = new.discount_percent,
           discount_fixed = new.discount_fixed
     where id = new.work_order_id
       and discount_percent is null and discount_fixed is null;
  end if;
  return null;
end;
$$;

drop trigger if exists quotations_pasar_descuento on public.quotations;
create trigger quotations_pasar_descuento
  after update of status, work_order_id on public.quotations
  for each row execute function public.pasar_descuento_a_la_orden();

-- El total del mensaje de "autorizar presupuesto" descuenta el descuento.
do $$
declare
  v_def text;
  v_nuevo text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'enviar_cotizacion_para_autorizar';
  v_def := replace(v_def, chr(13), '');
  if position('descuento_de_la_cotizacion' in v_def) > 0 then
    return;
  end if;
  v_nuevo := replace(v_def,
    '  select coalesce(sum(subtotal), 0) * 1.21 into v_total
  from quotation_items where quotation_id = q.id;',
    '  -- descuento_de_la_cotizacion
  select coalesce(sum(subtotal), 0) into v_total
  from quotation_items where quotation_id = q.id;
  v_total := round((v_total - case
      when q.discount_percent is not null then round(v_total * q.discount_percent / 100, 2)
      when q.discount_fixed is not null then q.discount_fixed
      else 0 end) * 1.21, 2);');
  if v_nuevo = v_def then
    raise exception 'No se encontró el cálculo del total en enviar_cotizacion_para_autorizar';
  end if;
  execute v_nuevo;
end $$;

-- Duplicar una cotización copia también su descuento.
do $$
declare
  v_def text;
  v_nuevo text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'duplicate_quotation';
  v_def := replace(v_def, chr(13), '');
  if position('discount_percent' in v_def) > 0 then
    return;
  end if;
  v_nuevo := replace(v_def,
    '  insert into quotations (status, customer_id, vehicle_id, component, notes, valid_until)
  select ''EMITIDA'', q.customer_id, q.vehicle_id, q.component, q.notes, current_date + 15',
    '  insert into quotations (status, customer_id, vehicle_id, component, notes, valid_until, discount_percent, discount_fixed)
  select ''EMITIDA'', q.customer_id, q.vehicle_id, q.component, q.notes, current_date + 15, q.discount_percent, q.discount_fixed');
  if v_nuevo = v_def then
    raise exception 'No se encontró el alta en duplicate_quotation';
  end if;
  execute v_nuevo;
end $$;

-- El alta suelta recibe el descuento.
drop function if exists public.crear_cotizacion(uuid, uuid, text, text, date, uuid, jsonb);
create function public.crear_cotizacion(
  p_customer_id uuid,
  p_vehicle_id uuid,
  p_component text,
  p_notes text,
  p_valid_until date,
  p_customer_sector_id uuid,
  p_items jsonb,
  p_discount_percent numeric default null,
  p_discount_fixed numeric default null
)
returns table(quotation_id uuid, quotation_number text, quotation_public_token uuid)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_number text;
  v_token uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if not exists (select 1 from customers where id = p_customer_id) then
    raise exception 'El cliente no existe.';
  end if;
  if p_vehicle_id is not null and not exists (
    select 1 from vehicles where id = p_vehicle_id and customer_id = p_customer_id
  ) then
    raise exception 'Ese equipo no es del cliente elegido.';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La cotización no tiene renglones cargados.';
  end if;

  insert into quotations (status, customer_id, vehicle_id, component, notes, valid_until, customer_sector_id,
                          discount_percent, discount_fixed)
  values (
    'EMITIDA', p_customer_id, p_vehicle_id,
    nullif(trim(coalesce(p_component, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    coalesce(p_valid_until, current_date + 15),
    p_customer_sector_id,
    p_discount_percent, p_discount_fixed
  )
  returning id, number, public_token into v_id, v_number, v_token;

  insert into quotation_items (quotation_id, article_id, code, description, quantity, unit_price, subtotal)
  select
    v_id,
    nullif(item->>'article_id', '')::uuid,
    nullif(trim(coalesce(item->>'code', '')), ''),
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    round((item->>'quantity')::numeric * (item->>'unit_price')::numeric, 2)
  from jsonb_array_elements(p_items) as item;

  return query select v_id, v_number, v_token;
end;
$$;
grant execute on function public.crear_cotizacion(uuid, uuid, text, text, date, uuid, jsonb, numeric, numeric) to authenticated;

-- El link público muestra el descuento.
drop function if exists public.get_public_quotation(uuid);
create function public.get_public_quotation(p_token uuid)
 RETURNS TABLE(number text, status quotation_status, component text, notes text, valid_until date,
   created_at timestamp with time zone, customer_name text, vehicle_brand text, vehicle_model text,
   license_plate text, already_converted boolean, discount_percent numeric, discount_fixed numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    q.number, q.status, q.component, q.notes, q.valid_until, q.created_at,
    c.name, v.brand, v.model, v.license_plate,
    not public.cotizacion_sigue_decidible(q.work_order_id),
    q.discount_percent, q.discount_fixed
  from quotations q
  left join customers c on c.id = q.customer_id
  left join vehicles v on v.id = q.vehicle_id
  where q.public_token = p_token;
$function$;
grant execute on function public.get_public_quotation(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
