-- Cotizaciones sueltas: se emiten sin orden de trabajo. El equipo (vehículo o
-- pieza) pasa a ser opcional: un presupuesto puede ser por un trabajo o un
-- repuesto sin que nada haya entrado todavía al taller. Quien las deje así
-- puede engancharlas después a una OT (link_quotation_to_work_order).
alter table public.quotations alter column vehicle_id drop not null;

create or replace function public.crear_cotizacion(
  p_customer_id uuid,
  p_vehicle_id uuid,
  p_component text,
  p_notes text,
  p_valid_until date,
  p_customer_sector_id uuid,
  p_items jsonb
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

  insert into quotations (status, customer_id, vehicle_id, component, notes, valid_until, customer_sector_id)
  values (
    'EMITIDA', p_customer_id, p_vehicle_id,
    nullif(trim(coalesce(p_component, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    coalesce(p_valid_until, current_date + 15),
    p_customer_sector_id
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

grant execute on function public.crear_cotizacion(uuid, uuid, text, text, date, uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
