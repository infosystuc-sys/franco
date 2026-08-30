-- ===========================================================================
-- Control de variación de precio en OT: autorización que bloquea el cierre
-- ===========================================================================
-- Migración: work_order_price_authorization
--
-- Requiere que antes se haya aplicado notification-kind-add-cambio-precio.sql
-- (agrega 'CAMBIO_PRECIO' al enum notification_kind; va aparte porque un
-- valor de enum recién agregado no se puede usar en la misma transacción).
--
-- Cuando el total de la OT queda distinto del total de la cotización que le
-- dio origen, el admin puede pedir autorización del cliente desde un botón
-- en la ficha. Eso manda un WhatsApp con el link de siempre (el de
-- seguimiento) y dispara un bloqueo: mientras la respuesta esté pendiente,
-- la OT no puede llegar a un estado terminal (no se puede cerrar ni
-- facturar). El resto del trabajo sigue su curso normal — el bloqueo es
-- solo sobre el cierre, no sobre seguir reparando.
--
-- Una OT sin cotización de origen (quotation_id null) no tiene precio
-- original con el cual compararse: el botón de autorización directamente
-- no aplica ahí.

alter table public.work_orders add column price_auth_status text;
alter table public.work_orders add column price_auth_requested_total numeric;
alter table public.work_orders add column price_auth_requested_at timestamptz;
alter table public.work_orders add column price_auth_decided_at timestamptz;
alter table public.work_orders add column price_auth_reason text;

alter table public.work_orders add constraint work_orders_price_auth_status_check
  check (price_auth_status is null or price_auth_status in ('PENDIENTE', 'AUTORIZADO', 'RECHAZADO'));

-- ── El bloqueo: no se puede llegar a un estado terminal con un precio sin autorizar ──
--
-- No se basa solo en el flag price_auth_status: recalcula la diferencia real
-- en el momento del cierre. Así se resuelve solo en dos direcciones —
--   * si el admin vuelve el monto al de la cotización original, no hay
--     diferencia y no hace falta autorización de nada;
--   * si ya se autorizó un monto pero el admin lo vuelve a tocar después,
--     ese nuevo monto no coincide con el autorizado y el cierre se traba
--     de nuevo, aunque price_auth_status siga diciendo AUTORIZADO.
-- Un RECHAZADO tampoco alcanza para cerrar: solo un AUTORIZADO cuyo monto
-- coincida exactamente con el total vigente destraba.

create or replace function public.block_terminal_while_price_pending()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_is_terminal boolean;
  v_quoted_total numeric;
  v_current_total numeric;
begin
  if new.status_id is distinct from old.status_id and new.quotation_id is not null then
    select is_terminal into v_is_terminal from work_order_statuses where id = new.status_id;
    if v_is_terminal then
      select coalesce(sum(subtotal), 0) into v_quoted_total
        from quotation_items where quotation_id = new.quotation_id;
      select coalesce(sum(subtotal), 0) into v_current_total
        from work_order_items where work_order_id = new.id;

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
$$;

create trigger work_orders_block_terminal_while_price_pending
before update of status_id on public.work_orders
for each row execute function block_terminal_while_price_pending();

-- ── El admin pide la autorización ───────────────────────────────────────

-- SECURITY DEFINER: enqueue_notification solo se llama hoy desde funciones
-- DEFINER (los triggers de estado), nunca directo desde una RPC corriendo
-- como el usuario autenticado — de ahí que su EXECUTE no esté abierto a
-- authenticated. El propio is_admin() de acá adentro sigue siendo el gate.
create or replace function public.request_price_authorization(p_work_order_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
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

  select coalesce(sum(subtotal), 0) into v_quoted_total
    from quotation_items where quotation_id = v_wo.quotation_id;
  select coalesce(sum(subtotal), 0) into v_current_total
    from work_order_items where work_order_id = p_work_order_id;

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
    'Hola, el costo de su reparación cambió respecto al presupuesto original.' || E'\n\n' ||
      'Orden ' || v_wo.number || E'\n' ||
      'Presupuesto original: $' || to_char(v_quoted_total, 'FM999999999.00') || E'\n' ||
      'Nuevo monto: $' || to_char(v_current_total, 'FM999999999.00') || E'\n\n' ||
      'Para poder continuar necesitamos su autorización. Puede verla y responder acá:' || E'\n' ||
      coalesce(v_base, '') || '/seguimiento/' || v_wo.public_token::text,
    v_wo.customer_id,
    p_work_order_id
  );

  return 'PENDIENTE';
end;
$$;

-- ── El cliente decide, desde el mismo link de seguimiento ──────────────

create or replace function public.decide_price_authorization(
  p_token uuid,
  p_accept boolean,
  p_reason text default null
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  wo work_orders%rowtype;
begin
  select * into wo from work_orders where public_token = p_token for update;

  if not found then
    return 'NO_EXISTE';
  end if;

  if wo.price_auth_status is distinct from 'PENDIENTE' then
    return 'YA_RESUELTA';
  end if;

  if not p_accept and coalesce(trim(p_reason), '') = '' then
    return 'FALTA_MOTIVO';
  end if;

  update work_orders
     set price_auth_status = case when p_accept then 'AUTORIZADO' else 'RECHAZADO' end,
         price_auth_decided_at = now(),
         price_auth_reason = case when p_accept then wo.price_auth_reason else trim(p_reason) end
   where id = wo.id;

  return case when p_accept then 'AUTORIZADO' else 'RECHAZADO' end;
end;
$$;

grant execute on function public.decide_price_authorization(uuid, boolean, text) to anon, authenticated;

-- ── El portal público necesita ver el estado de la autorización ────────

drop function public.get_public_work_order(uuid);

create or replace function public.get_public_work_order(p_token uuid)
returns table(
  number text, status_id uuid, component text, vehicle_brand text, vehicle_model text,
  license_plate text, vehicle_type text, vehicle_year integer, engine_brand text,
  engine_model text, injection_system text, employee_name text, customer_name text,
  price_auth_status text, price_auth_requested_total numeric
)
language sql
stable security definer
set search_path to 'public'
as $$
  select
    wo.number, wo.status_id, wo.component,
    v.brand, v.model, v.license_plate, v.vehicle_type, v.year,
    v.engine_brand, v.engine_model, v.injection_system,
    e.name, c.name,
    wo.price_auth_status, wo.price_auth_requested_total
  from work_orders wo
  left join vehicles v  on v.id = wo.vehicle_id
  left join employees e on e.id = wo.employee_id
  left join customers c on c.id = wo.customer_id
  where wo.public_token = p_token;
$$;

grant execute on function public.get_public_work_order(uuid) to anon, authenticated;
