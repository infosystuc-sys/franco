-- DieselPro ERP — WhatsApp: lo que whatsapp.sql dejó sin cuerpo
--
-- ⚠️ YA APLICADO en el proyecto Supabase "Ludiesel". Este archivo no agrega
-- nada nuevo al sistema: documenta lo que ya estaba corriendo, leído
-- directamente de la base viva el 26/08/2026 con pg_get_functiondef y
-- pg_get_triggerdef — no reconstruido de memoria a partir de los comentarios
-- de whatsapp.sql.
--
-- Por qué hacía falta:
--   whatsapp.sql describe la fase 1 y la fase 3 con comentarios ("Las
--   funciones de encolado están en la migración notifications_queue_functions:
--   enqueue_notification, claim_pending_notifications...", "Dos triggers sobre
--   work_orders: after insert → LINK_SEGUIMIENTO...") pero sin el cuerpo real.
--   Ese hueco es viejo, de antes de esta sesión: son migraciones que se
--   aplicaron directo contra Supabase sin dejar el .sql completo en el repo.
--
--   decide_quotation es la única excepción real: ya está entero en
--   quotation-rejection-reason.sql, verificado acá contra la base y
--   coincide. No se repite en este archivo.
--
-- No se incluye el secreto cron_secret (vive en la bóveda de Supabase, no en
-- ninguna tabla) ni el número de prueba cargado en whatsapp_test_phone: es
-- un teléfono real y no corresponde comitearlo al repositorio.


-- ===========================================================================
-- FASE 1 — La cola: encolar, tomar y marcar
-- ===========================================================================

-- Encola un mensaje. Si el cliente pidió no recibir mensajes o no tiene
-- teléfono válido, igual queda la fila —como DESCARTADO, con el motivo— para
-- que quede historial de que se intentó, no un silencio sin explicación.
--
-- on conflict (dedupe_key) do nothing: es la pieza que evita el mensaje
-- duplicado si alguien corrige un estado y lo vuelve a pasar.
create or replace function public.enqueue_notification(
  p_kind notification_kind,
  p_dedupe_key text,
  p_body text,
  p_customer_id uuid,
  p_work_order_id uuid default null,
  p_quotation_id uuid default null,
  p_media_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_opt_out boolean;
  v_status notification_status;
  v_error text;
  v_id uuid;
begin
  select phone_e164, whatsapp_opt_out into v_phone, v_opt_out
  from customers where id = p_customer_id;

  if v_opt_out then
    v_status := 'DESCARTADO';
    v_error := 'El cliente pidió no recibir mensajes.';
  elsif v_phone is null then
    v_status := 'DESCARTADO';
    v_error := 'El cliente no tiene un teléfono válido cargado.';
  else
    v_status := 'PENDIENTE';
  end if;

  insert into notifications (
    kind, status, work_order_id, quotation_id, customer_id,
    to_phone, body, media_url, dedupe_key, last_error
  )
  values (
    p_kind, v_status, p_work_order_id, p_quotation_id, p_customer_id,
    v_phone, p_body, p_media_url, p_dedupe_key, v_error
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.enqueue_notification(
  notification_kind, text, text, uuid, uuid, uuid, text
) from public, anon, authenticated;


-- Toma hasta p_limit mensajes pendientes para despachar y sube su contador de
-- intentos en la misma pasada. "for update skip locked" es lo que permite que
-- el despachador corra sin pisarse si alguna vez hay dos ejecuciones a la vez
-- —no debería pasar con un cron de un minuto, pero si pasa, no duplica envíos.
create or replace function public.claim_pending_notifications(p_limit int default 20)
returns table (id uuid, to_phone text, body text, media_url text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with tomadas as (
    select n.id from notifications n
    where n.status = 'PENDIENTE'
      and n.attempts < 5
    order by n.created_at
    limit p_limit
    for update skip locked
  )
  update notifications n
     set attempts = n.attempts + 1
    from tomadas
   where n.id = tomadas.id
  returning n.id, n.to_phone, n.body, n.media_url;
end;
$$;

revoke all on function public.claim_pending_notifications(int) from public, anon, authenticated;


create or replace function public.mark_notification_sent(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update notifications
     set status = 'ENVIADO', sent_at = now(), last_error = null
   where id = p_id;
$$;

revoke all on function public.mark_notification_sent(uuid) from public, anon, authenticated;


-- A los 5 intentos deja de reintentar y queda FALLIDO; antes de eso vuelve a
-- PENDIENTE para que el próximo minuto lo tome de nuevo.
create or replace function public.mark_notification_failed(p_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update notifications
     set last_error = p_error,
         status = case when attempts >= 5 then 'FALLIDO'::notification_status
                       else 'PENDIENTE'::notification_status end
   where id = p_id;
end;
$$;

revoke all on function public.mark_notification_failed(uuid, text) from public, anon, authenticated;


-- No estaba documentada en ningún archivo del repo. Deja que un admin
-- reintente o descarte un mensaje a mano desde la pantalla de la cola,
-- corrigiendo status/attempts directamente sobre la fila.
drop policy if exists "admin update" on notifications;
create policy "admin update" on notifications for update
  using (is_admin()) with check (is_admin());


-- ===========================================================================
-- FASE 2 — Presupuesto público: consulta
-- ===========================================================================
-- decide_quotation (la escritura) ya está completo en
-- quotation-rejection-reason.sql. Acá van las dos lecturas que arma la
-- pantalla pública: los datos de cabecera y los renglones.

create or replace function public.get_public_quotation(p_token uuid)
returns table (
  number text,
  status quotation_status,
  component text,
  notes text,
  valid_until date,
  created_at timestamptz,
  customer_name text,
  vehicle_brand text,
  vehicle_model text,
  license_plate text,
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
    q.work_order_id is not null
  from quotations q
  left join customers c on c.id = q.customer_id
  left join vehicles v on v.id = q.vehicle_id
  where q.public_token = p_token;
$$;

create or replace function public.get_public_quotation_items(p_token uuid)
returns table (
  code text,
  description text,
  quantity numeric,
  unit_price numeric,
  subtotal numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi
  join quotations q on q.id = qi.quotation_id
  where q.public_token = p_token
  order by qi.code;
$$;

-- Público de verdad: el cliente entra sin sesión.
grant execute on function public.get_public_quotation(uuid) to anon, authenticated;
grant execute on function public.get_public_quotation_items(uuid) to anon, authenticated;


-- ===========================================================================
-- FASE 3 — Avisos de la orden de trabajo
-- ===========================================================================

-- Arma el texto completo. Mencionar vehículo y patente es a propósito: un
-- cliente con varias unidades en el taller necesita saber de cuál le hablan.
create or replace function public.build_work_order_message(
  p_work_order_id uuid,
  p_status work_order_status,
  p_include_intro boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base text;
  v_wo record;
  v_plantilla text;
  v_vehiculo text;
begin
  select value into v_base from app_settings where key = 'public_base_url';
  select body into v_plantilla from notification_templates where status = p_status;

  select wo.number, wo.component, wo.public_token,
         trim(coalesce(v.brand,'') || ' ' || coalesce(v.model,'')) as veh,
         v.license_plate
    into v_wo
    from work_orders wo
    left join vehicles v on v.id = wo.vehicle_id
   where wo.id = p_work_order_id;

  v_vehiculo := nullif(v_wo.veh, '');
  if v_wo.license_plate is not null then
    v_vehiculo := coalesce(v_vehiculo, '') || ' (' || v_wo.license_plate || ')';
  end if;

  return
    case when p_include_intro
      then 'Hola, le compartimos el seguimiento de su reparación.' || E'\n\n'
      else '' end ||
    'Orden ' || v_wo.number ||
    coalesce(E'\n' || v_vehiculo, '') ||
    coalesce(E'\n' || v_wo.component, '') || E'\n\n' ||
    coalesce(v_plantilla, '') || E'\n\n' ||
    'Puede seguir el avance acá:' || E'\n' ||
    coalesce(v_base, '') || '/seguimiento/' || v_wo.public_token::text;
end;
$$;

-- Expone el token de seguimiento de cualquier orden: no es para llamar
-- directo, solo para que la usen los triggers de acá abajo.
revoke all on function public.build_work_order_message(
  uuid, work_order_status, boolean
) from public, anon, authenticated;


-- Al crear la orden, siempre manda el link de seguimiento. No hace falta
-- filtrar por estado: una OT nace AUTORIZADO siempre (createWorkOrder y
-- convert_quotation_to_work_order no admiten otro valor), así que esto ya
-- cubre "avisar cuando queda autorizada".
create or replace function public.enqueue_work_order_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform enqueue_notification(
    'LINK_SEGUIMIENTO',
    'ot:' || new.id::text || ':alta',
    build_work_order_message(new.id, new.status, true),
    new.customer_id,
    new.id
  );
  return null;
end;
$$;

create trigger work_orders_enqueue_created
after insert on work_orders
for each row execute function public.enqueue_work_order_created();

-- enqueue_work_order_status() —el trigger de cada cambio de estado— NO se
-- redefine acá: su versión vigente (solo avisa en TERMINADO) queda en
-- whatsapp-work-order-status-fix.sql, con la historia completa de por qué.
-- Repetirla acá crearía dos copias que se pueden desincronizar.
create trigger work_orders_enqueue_status
after update of status on work_orders
for each row execute function public.enqueue_work_order_status();


-- Cotización marcada como enviada: arma el mensaje con el total (recalculado
-- acá, con IVA 21% general — no lee tax_rates porque las cotizaciones no
-- llevan alícuota por renglón, a diferencia de las facturas) y el link para
-- aceptar o rechazar. `old.status = 'ENVIADA'` en el filtro es lo que impide
-- reenviar el aviso si se guarda la cabecera sin cambiar el estado.
create or replace function public.enqueue_quotation_sent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text;
  v_total numeric;
  v_body text;
begin
  if new.status <> 'ENVIADA' or old.status = 'ENVIADA' then
    return null;
  end if;

  select value into v_base from app_settings where key = 'public_base_url';

  select coalesce(sum(subtotal), 0) * 1.21 into v_total
  from quotation_items where quotation_id = new.id;

  v_body :=
    'Hola, le enviamos el presupuesto de su reparación.' || E'\n\n' ||
    'Presupuesto ' || new.number ||
    coalesce(' · ' || new.component, '') || E'\n' ||
    'Total: $ ' || to_char(v_total, 'FM999999990.00') ||
    coalesce(E'\n' || 'Válido hasta ' || to_char(new.valid_until, 'DD/MM/YYYY'), '') ||
    E'\n\n' ||
    'Puede verlo en detalle y aceptarlo o rechazarlo acá:' || E'\n' ||
    coalesce(v_base, '') || '/presupuesto/' || new.public_token::text;

  perform enqueue_notification(
    'COTIZACION',
    'cot:' || new.id::text || ':enviada',
    v_body,
    new.customer_id,
    null,
    new.id
  );

  return null;
end;
$$;

create trigger quotations_enqueue_sent
after update of status on quotations
for each row execute function public.enqueue_quotation_sent();


-- ===========================================================================
-- Plantillas por estado — la data, no solo la tabla
-- ===========================================================================
-- whatsapp.sql crea la tabla notification_templates pero no dejaba esta
-- carga: en una base levantada desde cero, la tabla existiría vacía y
-- build_work_order_message mandaría el mensaje sin el cuerpo específico del
-- estado (coalesce(v_plantilla, '') lo deja en blanco en vez de fallar, pero
-- el cliente recibiría un aviso incompleto).
insert into notification_templates (status, body) values
  ('AUTORIZADO',   'Su trabajo quedó autorizado y entró al taller. Le vamos a ir avisando cómo avanza.'),
  ('EN_ESPERA_REP','Estamos gestionando los repuestos necesarios para su reparación.'),
  ('EN_REPARACION','Empezamos la reparación de su componente.'),
  ('CALIBRACION',  'Terminamos la reparación y estamos calibrando y probando el componente en banco.'),
  ('TERMINADO',    'Su componente está listo para retirar. Lo esperamos en el taller.')
on conflict (status) do nothing;

comment on table notification_templates is
  'Un texto por estado de la OT. Solo AUTORIZADO (al crear la orden) y '
  'TERMINADO disparan WhatsApp hoy — ver whatsapp-work-order-status-fix.sql.'
  ' Los otros tres quedan cargados por si se reactiva un aviso intermedio.';
