-- ===========================================================================
-- El circuito de la cotización, sin depender de un orden fijo de estados
-- ===========================================================================
-- Migración: circuito_cotizacion_sin_orden_fijo
--
-- Los estados de OT dejaron de tener una secuencia global: cada orden arma su
-- línea de tiempo con los que se le van eligiendo. Pero cinco funciones del
-- circuito de cotización seguían preguntando "¿está en INGRESADO o COTIZADO?"
-- para decidir si todavía había algo que autorizar.
--
-- El síntoma que se vio: una orden en "desarmado y evaluacion" con su
-- presupuesto enviado no le mostraba al cliente los botones de aceptar y
-- rechazar. Esos estados que el taller agregó no tienen system_key, así que no
-- son ni INGRESADO ni COTIZADO, y la página los leía como "ya convertido".
-- Rechazar tampoco funcionaba: la orden se quedaba donde estaba.
--
-- Lo que de verdad tiene que frenar una autorización no es en qué paso está la
-- orden, sino que ya no haya nada que autorizar:
--
--   · la orden está cerrada (estado terminal), o
--   · ya se facturó.
--
-- Las dos se leen de la bandera is_terminal y de la existencia de una factura
-- viva, no de qué estados existan ni de cómo se llamen.

-- ── 1) Cotizar mueve la orden a Cotizado, siempre ─────────────────────────
-- Antes solo la movía si venía de "Ingresado". Con estados libres, cotizar una
-- orden que está en cualquier otro paso dejaba el estado sin cambiar, y la
-- línea de tiempo no registraba que se había cotizado.
create or replace function public.cotizar_desde_ot(p_work_order_id uuid, p_valid_until date default null)
returns table (quotation_id uuid, quotation_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ot work_orders%rowtype;
  v_cot quotations%rowtype;
  v_cotizado uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_ot from work_orders where id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;

  -- Dos presupuestos sobre la misma orden dejan el control de precios
  -- comparando contra el que no es.
  if v_ot.quotation_id is not null then
    raise exception 'Esa orden ya tiene una cotización enganchada.';
  end if;

  insert into quotations (customer_id, vehicle_id, component, notes, valid_until, work_order_id)
  values (v_ot.customer_id, v_ot.vehicle_id, v_ot.component, v_ot.observations,
          p_valid_until, p_work_order_id)
  returning * into v_cot;

  insert into quotation_items (quotation_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_cot.id, i.article_id, i.code, i.description, i.quantity, i.unit_price, i.subtotal
  from work_order_items i
  where i.work_order_id = p_work_order_id;

  update work_orders set quotation_id = v_cot.id where id = p_work_order_id;

  select id into v_cotizado from work_order_statuses where system_key = 'COTIZADO';
  if v_cotizado is null then
    raise exception 'Falta el estado cotizado del circuito. Revisá el ABM de estados de OT.';
  end if;

  -- Una orden ya facturada no se mueve: quedó bloqueada con una única salida,
  -- que es Retirado. Cotizarla no puede reabrirla.
  if not exists (
    select 1 from invoices i
     where i.work_order_id = p_work_order_id and i.status <> 'ANULADA'
  ) then
    update work_orders set status_id = v_cotizado where id = p_work_order_id;
  end if;

  return query select v_cot.id, v_cot.number;
end;
$$;

-- ── 2) Si todavía hay algo que autorizar ──────────────────────────────────
create or replace function public.cotizacion_sigue_decidible(p_work_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_work_order_id is null then true  -- presupuesto sin orden: siempre decidible
    else not (
      -- Orden cerrada: el trabajo terminó. Aplicar el presupuesto ahora
      -- reemplazaría los renglones de un trabajo ya hecho.
      coalesce((select s.is_terminal from work_orders w
                 join work_order_statuses s on s.id = w.status_id
                where w.id = p_work_order_id), false)
      or
      -- Ya facturada: los renglones quedaron congelados en el comprobante.
      exists (select 1 from invoices i
               where i.work_order_id = p_work_order_id and i.status <> 'ANULADA')
    )
  end;
$$;

grant execute on function public.cotizacion_sigue_decidible(uuid) to anon, authenticated;

-- ── 3) La página pública deja decidir salvo que no haya nada que decidir ──
create or replace function public.get_public_quotation(p_token uuid)
returns table (
  number text, status quotation_status, component text, notes text,
  valid_until date, created_at timestamptz, customer_name text,
  vehicle_brand text, vehicle_model text, license_plate text,
  already_converted boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    q.number, q.status, q.component, q.notes, q.valid_until, q.created_at,
    c.name, v.brand, v.model, v.license_plate,
    not public.cotizacion_sigue_decidible(q.work_order_id)
  from quotations q
  left join customers c on c.id = q.customer_id
  left join vehicles v on v.id = q.vehicle_id
  where q.public_token = p_token;
$$;

grant execute on function public.get_public_quotation(uuid) to anon, authenticated;

-- ── 4) La decisión del cliente, con el mismo criterio ─────────────────────
create or replace function public.decide_quotation(p_token uuid, p_accept boolean, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  q quotations%rowtype;
begin
  select * into q from quotations where public_token = p_token for update;

  if not found then
    return 'NO_EXISTE';
  end if;

  if q.status not in ('EMITIDA', 'ENVIADA') then
    return 'YA_RESUELTA';
  end if;

  -- Antes acá se exigía que la orden estuviera en INGRESADO o COTIZADO. Con
  -- estados libres eso bloqueaba órdenes que sí estaban esperando respuesta:
  -- cualquier estado agregado por el taller no tiene system_key y caía afuera.
  if not public.cotizacion_sigue_decidible(q.work_order_id) then
    return 'YA_CONVERTIDA';
  end if;

  if q.valid_until is not null and q.valid_until < current_date then
    return 'VENCIDA';
  end if;

  if not p_accept and coalesce(trim(p_reason), '') = '' then
    return 'FALTA_MOTIVO';
  end if;

  update quotations
     set status = case when p_accept then 'ACEPTADA'::quotation_status
                       else 'RECHAZADA'::quotation_status end,
         decided_at = now(),
         decided_by_client = true,
         rejection_reason = case when p_accept then q.rejection_reason
                                 else trim(p_reason) end
   where id = q.id;

  if p_accept then
    perform public.aplicar_cotizacion_en_ot(q.id);
  else
    perform public.rechazar_cotizacion_en_ot(q.id);
  end if;

  return case when p_accept then 'ACEPTADA' else 'RECHAZADA' end;
end;
$$;

grant execute on function public.decide_quotation(uuid, boolean, text) to anon, authenticated;

-- ── 5) Aceptar deja la orden en Autorizada, desde donde estuviera ─────────
create or replace function public.aplicar_cotizacion_en_ot(p_quotation_id uuid)
returns table (result_id uuid, result_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quotation quotations%rowtype;
  v_autorizada uuid;
begin
  select * into v_quotation from quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_quotation.status <> 'ACEPTADA' then
    raise exception 'Solo se aplican cotizaciones aceptadas (estado actual: %).', v_quotation.status;
  end if;

  if v_quotation.work_order_id is null then
    return;
  end if;

  -- Cerrada o facturada: se devuelve la orden sin tocarla. No es un error
  -- —el cliente aceptó— pero sus renglones ya no se reemplazan.
  if not public.cotizacion_sigue_decidible(v_quotation.work_order_id) then
    return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
    return;
  end if;

  if not exists (select 1 from quotation_items where quotation_id = p_quotation_id) then
    raise exception 'La cotización no tiene renglones cargados.';
  end if;

  select id into v_autorizada from work_order_statuses where system_key = 'AUTORIZADA';
  if v_autorizada is null then
    raise exception 'Falta el estado autorizada del circuito. Revisá el ABM de estados de OT.';
  end if;

  -- Reemplaza, no agrega: la orden puede llegar acá con renglones propios.
  delete from work_order_items where work_order_id = v_quotation.work_order_id;

  insert into work_order_items (
    work_order_id, article_id, code, description, quantity, unit_price, subtotal, unit_cost
  )
  select
    v_quotation.work_order_id, qi.article_id, qi.code, qi.description,
    qi.quantity, qi.unit_price, qi.subtotal,
    (
      select sp.purchase_price
        from article_suppliers sp
       where sp.article_id = qi.article_id
         and sp.is_preferred
       limit 1
    )
  from quotation_items qi
  where qi.quotation_id = p_quotation_id;

  update work_orders set status_id = v_autorizada where id = v_quotation.work_order_id;

  return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
end;
$$;

-- ── 6) Rechazar también funciona desde cualquier estado ───────────────────
-- Tenía el mismo filtro de INGRESADO/COTIZADO, así que rechazar un presupuesto
-- de una orden en cualquier otro paso no movía nada: la cotización quedaba
-- RECHAZADA y la orden seguía como si esperara respuesta.
create or replace function public.rechazar_cotizacion_en_ot(p_quotation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo uuid;
  v_rechazada uuid;
begin
  select work_order_id into v_wo from quotations where id = p_quotation_id;
  if v_wo is null then
    return;
  end if;

  if not public.cotizacion_sigue_decidible(v_wo) then
    return;
  end if;

  select id into v_rechazada from work_order_statuses where system_key = 'RECHAZADA';
  if v_rechazada is null then
    raise exception 'Falta el estado rechazada del circuito. Revisá el ABM de estados de OT.';
  end if;

  update work_orders set status_id = v_rechazada where id = v_wo;
end;
$$;
