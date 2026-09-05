-- ===========================================================================
-- El cliente vuelve a poder responder el presupuesto
-- ===========================================================================
-- Migración: reception_quotation_public_decision
--
-- Con el circuito nuevo la cotización nace enganchada a la orden, porque la
-- orden existe desde que se recibió el vehículo. Eso rompió dos cosas del
-- canal del cliente, que se habían escrito cuando "tener orden" significaba
-- "ya se convirtió":
--
--   * get_public_quotation informaba already_converted = "tiene orden", así
--     que el link mostraba "El trabajo ya está en marcha" y escondía los
--     botones de aceptar y rechazar. Toda cotización del circuito nuevo era
--     irrespondible.
--   * decide_quotation cortaba con YA_CONVERTIDA por el mismo motivo, y
--     además solo cambiaba el estado de la cotización: la decisión del
--     cliente no movía la orden. Aceptar dejaba la orden en "Cotizado" para
--     siempre, ocupando lugar en la playa, sin renglones y sin stock
--     descontado, y el taller no se enteraba.
--
-- Lo que de verdad significa "ya se resolvió" ahora es que la orden pasó de
-- la etapa de presupuesto: no que exista.

-- 1) El trabajo de aplicar la cotización, sin el guard de admin -------------
-- Lo comparten dos caminos con permisos opuestos: el admin desde la pantalla
-- interna, y el cliente desde el link público (que corre como anónimo). Tener
-- la lógica en un solo lugar es lo que evita que las dos ramas se separen.
create or replace function public.aplicar_cotizacion_en_ot(p_quotation_id uuid)
returns table (result_id uuid, result_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quotation quotations%rowtype;
  v_autorizada uuid;
  v_estado_actual text;
begin
  select * into v_quotation from quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_quotation.status <> 'ACEPTADA' then
    raise exception 'Solo se aplican cotizaciones aceptadas (estado actual: %).', v_quotation.status;
  end if;

  -- Sin orden enganchada no hay nada que hacer todavía: es el presupuesto que
  -- se hizo antes de que el vehículo llegara.
  if v_quotation.work_order_id is null then
    return;
  end if;

  select s.label into v_estado_actual
  from work_orders w join work_order_statuses s on s.id = w.status_id
  where w.id = v_quotation.work_order_id;

  -- Aplicar dos veces no duplica nada: si la orden ya pasó de Autorizada
  -- porque el trabajo arrancó, no se vuelven a copiar renglones ni a
  -- descontar stock, y el estado no retrocede.
  if v_estado_actual not in ('Ingresado', 'Cotizado') then
    return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
    return;
  end if;

  if not exists (select 1 from quotation_items where quotation_id = p_quotation_id) then
    raise exception 'La cotización no tiene renglones cargados.';
  end if;

  select id into v_autorizada from work_order_statuses where label = 'Autorizada';
  if v_autorizada is null then
    raise exception 'Falta el estado "Autorizada" en el ABM de estados de OT.';
  end if;

  insert into work_order_items (work_order_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_quotation.work_order_id, qi.article_id, qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi
  where qi.quotation_id = p_quotation_id;

  update work_orders set status_id = v_autorizada where id = v_quotation.work_order_id;

  return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
end;
$$;

-- El envoltorio para la pantalla interna: mismo trabajo, con el guard de rol.
create or replace function public.apply_quotation_to_work_order(p_quotation_id uuid)
returns table (result_id uuid, result_number text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  return query select * from public.aplicar_cotizacion_en_ot(p_quotation_id);
end;
$$;

-- 2) Rechazar mueve la orden, venga de donde venga -------------------------
create or replace function public.rechazar_cotizacion_en_ot(p_quotation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo uuid;
  v_rechazada uuid;
  v_estado_actual text;
begin
  select work_order_id into v_wo from quotations where id = p_quotation_id;
  if v_wo is null then
    return;
  end if;

  select s.label into v_estado_actual
  from work_orders w join work_order_statuses s on s.id = w.status_id where w.id = v_wo;

  -- Solo se rechaza lo que todavía está esperando respuesta. Una orden que ya
  -- está en reparación no se cae porque alguien rechace un presupuesto viejo:
  -- tiene renglones cargados y stock descontado.
  if v_estado_actual not in ('Ingresado', 'Cotizado') then
    return;
  end if;

  select id into v_rechazada from work_order_statuses where label = 'Rechazada';
  if v_rechazada is null then
    raise exception 'Falta el estado "Rechazada" en el ABM de estados de OT.';
  end if;

  update work_orders set status_id = v_rechazada where id = v_wo;
end;
$$;

-- 3) El link público vuelve a dejar decidir --------------------------------
-- "Ya está en marcha" pasa a significar que la orden salió de la etapa de
-- presupuesto, no que exista.
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
    coalesce(s.label not in ('Ingresado', 'Cotizado'), false)
  from quotations q
  left join customers c on c.id = q.customer_id
  left join vehicles v on v.id = q.vehicle_id
  left join work_orders w on w.id = q.work_order_id
  left join work_order_statuses s on s.id = w.status_id
  where q.public_token = p_token;
$$;

create or replace function public.decide_quotation(p_token uuid, p_accept boolean, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  q quotations%rowtype;
  v_estado_ot text;
begin
  select * into q from quotations where public_token = p_token for update;

  if not found then
    return 'NO_EXISTE';
  end if;

  if q.status not in ('EMITIDA', 'ENVIADA') then
    return 'YA_RESUELTA';
  end if;

  -- Tener orden ya no significa "convertida": con el circuito nuevo la orden
  -- existe desde que se recibió el vehículo. Lo que cierra la puerta es que
  -- esa orden ya haya pasado de la etapa de presupuesto.
  if q.work_order_id is not null then
    select s.label into v_estado_ot
    from work_orders w join work_order_statuses s on s.id = w.status_id
    where w.id = q.work_order_id;

    if v_estado_ot is not null and v_estado_ot not in ('Ingresado', 'Cotizado') then
      return 'YA_CONVERTIDA';
    end if;
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

  -- La decisión del cliente mueve la orden, igual que si la hubiera tomado el
  -- taller desde la pantalla interna. Sin esto, aceptar dejaba la orden en
  -- "Cotizado" para siempre, ocupando lugar y sin que nadie se enterara.
  if p_accept then
    perform public.aplicar_cotizacion_en_ot(q.id);
  else
    perform public.rechazar_cotizacion_en_ot(q.id);
  end if;

  return case when p_accept then 'ACEPTADA' else 'RECHAZADA' end;
end;
$$;

-- 4) La RPC del circuito viejo se retira -----------------------------------
-- convert_quotation_to_work_order CREABA una orden. Con el circuito nuevo la
-- orden ya existe, así que invocarla dejaría una orden duplicada. El cliente
-- JS que la llamaba se borró, pero la función seguía viva y con permiso para
-- cualquier admin.
drop function if exists public.convert_quotation_to_work_order(uuid);

grant execute on function public.aplicar_cotizacion_en_ot(uuid) to authenticated;
grant execute on function public.rechazar_cotizacion_en_ot(uuid) to authenticated;
