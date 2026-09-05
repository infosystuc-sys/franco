-- ===========================================================================
-- Los estados del circuito se identifican por clave, no por su nombre
-- ===========================================================================
-- Migración: work_order_status_system_key
--
-- El ABM de estados es del usuario: puede renombrarlos y reordenarlos. Por eso
-- el proyecto ya había reemplazado las comparaciones contra el texto literal
-- por columnas de marca (is_initial, is_terminal, frees_yard).
--
-- El circuito de recepción reintrodujo cinco comparaciones por nombre
-- ('Ingresado', 'Cotizado', 'Autorizada', 'Rechazada'), y con ellas volvió el
-- problema: renombrar "Rechazada" dejaba la orden en "Cotizado" ocupando lugar
-- para siempre, y renombrar "Cotizado" hacía que cada clic en Cotizar dejara
-- una cotización huérfana. Todo en silencio, porque el update simplemente no
-- encontraba a quién aplicar.
--
-- system_key es el identificador estable de los estados que el sistema
-- necesita reconocer. El nombre sigue siendo del usuario.

alter table public.work_order_statuses add column system_key text;

create unique index work_order_statuses_system_key_idx
  on public.work_order_statuses(system_key) where system_key is not null;

comment on column public.work_order_statuses.system_key is
  'Identificador estable para los estados que el circuito reconoce. El label es del usuario y puede cambiar; esto no.';

update public.work_order_statuses set system_key = case label
  when 'Ingresado'  then 'INGRESADO'
  when 'Cotizado'   then 'COTIZADO'
  when 'Autorizada' then 'AUTORIZADA'
  when 'Rechazada'  then 'RECHAZADA'
end
where label in ('Ingresado', 'Cotizado', 'Autorizada', 'Rechazada');

-- ── Las funciones pasan a resolver por clave ────────────────────────────────

create or replace function public.aplicar_cotizacion_en_ot(p_quotation_id uuid)
returns table (result_id uuid, result_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quotation quotations%rowtype;
  v_autorizada uuid;
  v_clave_actual text;
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

  select s.system_key into v_clave_actual
  from work_orders w join work_order_statuses s on s.id = w.status_id
  where w.id = v_quotation.work_order_id;

  -- Aplicar dos veces no duplica nada: si la orden ya arrancó el trabajo, no
  -- se vuelven a copiar renglones ni a descontar stock.
  if v_clave_actual is distinct from 'INGRESADO' and v_clave_actual is distinct from 'COTIZADO' then
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

  insert into work_order_items (work_order_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_quotation.work_order_id, qi.article_id, qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi
  where qi.quotation_id = p_quotation_id;

  update work_orders set status_id = v_autorizada where id = v_quotation.work_order_id;

  return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
end;
$$;

create or replace function public.rechazar_cotizacion_en_ot(p_quotation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo uuid;
  v_rechazada uuid;
  v_clave_actual text;
begin
  select work_order_id into v_wo from quotations where id = p_quotation_id;
  if v_wo is null then
    return;
  end if;

  select s.system_key into v_clave_actual
  from work_orders w join work_order_statuses s on s.id = w.status_id where w.id = v_wo;

  -- Solo se rechaza lo que todavía espera respuesta: una orden en reparación
  -- tiene renglones cargados y stock descontado, no se cae por un presupuesto
  -- viejo que alguien rechaza tarde.
  if v_clave_actual is distinct from 'INGRESADO' and v_clave_actual is distinct from 'COTIZADO' then
    return;
  end if;

  select id into v_rechazada from work_order_statuses where system_key = 'RECHAZADA';
  if v_rechazada is null then
    raise exception 'Falta el estado rechazada del circuito. Revisá el ABM de estados de OT.';
  end if;

  update work_orders set status_id = v_rechazada where id = v_wo;
end;
$$;

create or replace function public.link_quotation_to_work_order(
  p_quotation_id uuid,
  p_work_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cotizado uuid;
  v_otra uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if exists (select 1 from quotations where id = p_quotation_id and work_order_id is not null
             and work_order_id <> p_work_order_id) then
    raise exception 'Esa cotización ya está enganchada a otra orden de trabajo.';
  end if;

  -- Y al revés: una orden con dos presupuestos encima deja el control de
  -- precios comparando contra el que no es, y la orden no se puede cerrar
  -- nunca sin autorización.
  select quotation_id into v_otra from work_orders where id = p_work_order_id;
  if v_otra is not null and v_otra <> p_quotation_id then
    raise exception 'Esa orden ya tiene una cotización enganchada.';
  end if;

  select id into v_cotizado from work_order_statuses where system_key = 'COTIZADO';
  if v_cotizado is null then
    raise exception 'Falta el estado cotizado del circuito. Revisá el ABM de estados de OT.';
  end if;

  update quotations set work_order_id = p_work_order_id where id = p_quotation_id;
  update work_orders set quotation_id = p_quotation_id where id = p_work_order_id;

  -- Solo avanza si todavía está en la recepción.
  update work_orders w
  set status_id = v_cotizado
  from work_order_statuses s
  where w.id = p_work_order_id and s.id = w.status_id and s.system_key = 'INGRESADO';
end;
$$;

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
    coalesce(s.system_key is distinct from 'INGRESADO' and s.system_key is distinct from 'COTIZADO', false)
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
  v_clave_ot text;
begin
  select * into q from quotations where public_token = p_token for update;

  if not found then
    return 'NO_EXISTE';
  end if;

  if q.status not in ('EMITIDA', 'ENVIADA') then
    return 'YA_RESUELTA';
  end if;

  -- Tener orden ya no significa "convertida": la orden existe desde que se
  -- recibió el vehículo. Lo que cierra la puerta es que ya haya arrancado.
  if q.work_order_id is not null then
    select s.system_key into v_clave_ot
    from work_orders w join work_order_statuses s on s.id = w.status_id
    where w.id = q.work_order_id;

    if v_clave_ot is distinct from 'INGRESADO' and v_clave_ot is distinct from 'COTIZADO' then
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

  if p_accept then
    perform public.aplicar_cotizacion_en_ot(q.id);
  else
    perform public.rechazar_cotizacion_en_ot(q.id);
  end if;

  return case when p_accept then 'ACEPTADA' else 'RECHAZADA' end;
end;
$$;
