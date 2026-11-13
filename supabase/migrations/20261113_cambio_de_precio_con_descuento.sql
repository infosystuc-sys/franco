-- El cambio de precio de una OT cuenta el descuento.
--
-- Hasta ahora, para saber si el precio de la OT cambió respecto al
-- presupuesto se comparaba solo la suma de los renglones. Agregar o sacar un
-- renglón cambiaba esa suma y se le pedía autorización al cliente con el monto
-- nuevo; cambiar el descuento (porcentaje o monto fijo) no la cambiaba, así
-- que el cliente nunca se enteraba.
--
-- Ahora las dos puntas se comparan con su descuento: el presupuesto con el
-- suyo y la OT con el suyo. Eso vale para pedir la autorización, para darla
-- desde el taller y para el bloqueo que no deja cerrar la orden sin autorizar.

create or replace function public.total_de_la_cotizacion(p_quotation_id uuid)
returns numeric
language sql
stable
set search_path = public
as $$
  select round(s.bruto - case
           when q.discount_percent is not null then round(s.bruto * q.discount_percent / 100, 2)
           when q.discount_fixed is not null then q.discount_fixed
           else 0 end, 2)
    from quotations q,
         lateral (select coalesce(sum(subtotal), 0) as bruto
                    from quotation_items where quotation_id = q.id) s
   where q.id = p_quotation_id;
$$;

create or replace function public.total_de_la_orden(p_work_order_id uuid)
returns numeric
language sql
stable
set search_path = public
as $$
  select round(s.bruto - case
           when w.discount_percent is not null then round(s.bruto * w.discount_percent / 100, 2)
           when w.discount_fixed is not null then w.discount_fixed
           else 0 end, 2)
    from work_orders w,
         lateral (select coalesce(sum(subtotal), 0) as bruto
                    from work_order_items where work_order_id = w.id) s
   where w.id = p_work_order_id;
$$;

-- Pedirle la autorización al cliente -----------------------------------------
create or replace function public.request_price_authorization(p_work_order_id uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_wo work_orders%rowtype;
  v_quoted_total numeric;
  v_current_total numeric;
  v_base text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_wo from work_orders where id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;
  if v_wo.quotation_id is null then
    raise exception 'Esta orden no nació de una cotización: no hay precio original con el cual compararla.';
  end if;

  v_quoted_total := total_de_la_cotizacion(v_wo.quotation_id);
  v_current_total := total_de_la_orden(p_work_order_id);

  if v_current_total = v_quoted_total then
    raise exception 'El monto de la OT no cambió respecto a la cotización original: no hay nada que autorizar.';
  end if;

  update work_orders
     set price_auth_status = 'PENDIENTE',
         price_auth_requested_total = v_current_total,
         price_auth_requested_at = now(),
         price_auth_decided_at = null,
         price_auth_reason = null
   where id = p_work_order_id;

  select value into v_base from app_settings where key = 'public_base_url';

  perform enqueue_notification(
    'CAMBIO_PRECIO',
    'ot:' || p_work_order_id::text || ':precio:' || v_current_total::text,
    aplicar_plantilla('ot_cambio_precio', jsonb_build_object(
      'cliente', (select name from customers where id = v_wo.customer_id),
      'orden', v_wo.number,
      'presupuesto_original', to_char(v_quoted_total, 'FM999999999.00'),
      'nuevo_monto', to_char(v_current_total, 'FM999999999.00'),
      'link', coalesce(v_base, '') || '/seguimiento/' || v_wo.public_token::text
    )),
    v_wo.customer_id,
    p_work_order_id
  );

  return 'PENDIENTE';
end;
$function$;

-- Darla por autorizada desde el taller -----------------------------------------
create or replace function public.autorizar_cambio_de_precio_en_el_taller(p_work_order_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_wo work_orders%rowtype;
  v_quoted_total numeric;
  v_current_total numeric;
  v_quien text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_wo from work_orders where id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;
  if v_wo.quotation_id is null then
    raise exception 'Esta orden no nació de una cotización: no hay precio original con el cual compararla.';
  end if;

  v_quoted_total := total_de_la_cotizacion(v_wo.quotation_id);
  v_current_total := total_de_la_orden(p_work_order_id);

  if v_current_total = v_quoted_total then
    raise exception 'El monto de la OT no cambió respecto a la cotización original: no hay nada que autorizar.';
  end if;

  select email into v_quien from auth.users where id = auth.uid();

  update work_orders
     set price_auth_status = 'AUTORIZADO',
         price_auth_requested_total = v_current_total,
         price_auth_requested_at = coalesce(price_auth_requested_at, now()),
         price_auth_decided_at = now(),
         price_auth_reason = 'Autorizado desde el taller' || coalesce(' por ' || v_quien, '')
   where id = p_work_order_id;
end;
$$;

-- No dejar cerrar la orden con un precio sin autorizar --------------------------
-- El descuento se lee de NEW: puede estar cambiando en este mismo update.
create or replace function public.block_terminal_while_price_pending()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_is_terminal boolean;
  v_era_terminal boolean;
  v_quoted_total numeric;
  v_bruto numeric;
  v_current_total numeric;
begin
  if new.status_id is distinct from old.status_id and new.quotation_id is not null then
    select is_terminal into v_is_terminal from work_order_statuses where id = new.status_id;
    select is_terminal into v_era_terminal from work_order_statuses where id = old.status_id;

    if v_is_terminal and not coalesce(v_era_terminal, false) then
      v_quoted_total := total_de_la_cotizacion(new.quotation_id);
      select coalesce(sum(subtotal), 0) into v_bruto
        from work_order_items where work_order_id = new.id;
      v_current_total := round(v_bruto - case
          when new.discount_percent is not null then round(v_bruto * new.discount_percent / 100, 2)
          when new.discount_fixed is not null then new.discount_fixed
          else 0 end, 2);

      if v_current_total <> v_quoted_total
         and (new.price_auth_status is distinct from 'AUTORIZADO'
              or new.price_auth_requested_total is distinct from v_current_total)
      then
        raise exception 'No se puede cerrar la OT: el monto cambió respecto al presupuesto original y no está autorizado por el cliente.';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

-- Las órdenes ya autorizadas con un descuento guardaron el monto sin
-- descontar: se les actualiza al monto con descuento, para que no vuelvan a
-- pedir autorización por un cambio que el cliente ya aprobó.
update work_orders w
   set price_auth_requested_total = total_de_la_orden(w.id)
 where w.price_auth_status = 'AUTORIZADO'
   and (w.discount_percent is not null or w.discount_fixed is not null)
   and w.price_auth_requested_total = (select coalesce(sum(subtotal), 0) from work_order_items where work_order_id = w.id);

notify pgrst, 'reload schema';
