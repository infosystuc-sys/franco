-- DieselPro ERP — WhatsApp: cola de mensajes y presupuesto público
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (migraciones
-- phone_normalization, notifications_queue, notifications_queue_functions,
-- quotation_public_token_and_decision y enqueue_quotation_on_sent).
-- Queda como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-19-whatsapp-facturacion-design.md

-- ===========================================================================
-- FASE 1 — Cimientos
-- ===========================================================================

-- Teléfono en formato E.164 para WhatsApp: 5491155550001
-- Evolution API necesita solo dígitos, con el 9 de celular argentino y sin el
-- 15 local. Los teléfonos se cargan como texto libre; si no se puede
-- normalizar devuelve null y la app avisa, en vez de que el mensaje no llegue.
create or replace function public.normalize_ar_phone(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
begin
  if p_raw is null then return null; end if;

  d := regexp_replace(p_raw, '\D', '', 'g');
  if d = '' then return null; end if;

  if left(d, 2) = '00' then d := substr(d, 3); end if;      -- salida internacional
  if left(d, 2) = '54' then d := substr(d, 3); end if;      -- país
  d := regexp_replace(d, '^0+', '');                        -- 011 -> 11

  -- El 9 de celular se saca y se repone al final, así da igual que venga o no.
  if left(d, 1) = '9' and length(d) = 11 then d := substr(d, 2); end if;

  -- El 15 local va después del código de área, que mide de 2 a 4 dígitos.
  if length(d) = 12 then
    if substr(d, 3, 2) = '15' then d := substr(d, 1, 2) || substr(d, 5);
    elsif substr(d, 4, 2) = '15' then d := substr(d, 1, 3) || substr(d, 6);
    elsif substr(d, 5, 2) = '15' then d := substr(d, 1, 4) || substr(d, 7);
    end if;
  end if;

  if length(d) <> 10 then return null; end if;              -- área + abonado
  return '549' || d;
end;
$$;

alter table customers
  add column phone_e164 text,
  add column whatsapp_opt_out boolean not null default false;

create or replace function public.sync_customer_phone()
returns trigger language plpgsql as $$
begin
  new.phone_e164 := public.normalize_ar_phone(new.phone);
  return new;
end;
$$;

create trigger customers_sync_phone
before insert or update of phone on customers
for each row execute function public.sync_customer_phone();

update customers set phone = phone;  -- normalizar lo ya cargado


-- Cola de mensajes. El trigger que detecta el cambio NO llama a WhatsApp:
-- deja la fila acá. Un proceso aparte la despacha y reintenta. Si Evolution
-- está caído, el mensaje sale cuando vuelve en vez de perderse.
create type notification_kind as enum ('LINK_SEGUIMIENTO','CAMBIO_ESTADO','COTIZACION','FACTURA');
create type notification_status as enum ('PENDIENTE','ENVIADO','FALLIDO','DESCARTADO');

create table notifications (
  id uuid primary key default gen_random_uuid(),
  kind notification_kind not null,
  status notification_status not null default 'PENDIENTE',
  work_order_id uuid references work_orders(id) on delete cascade,
  quotation_id uuid references quotations(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  -- Teléfono y texto se congelan al encolar.
  to_phone text,
  body text not null,
  media_url text,
  attempts int not null default 0,
  last_error text,
  -- Impide mandar dos veces lo mismo si alguien corrige y repite un estado.
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index notifications_pendientes_idx on notifications (created_at) where status = 'PENDIENTE';
create index notifications_work_order_idx on notifications (work_order_id);
create index notifications_quotation_idx on notifications (quotation_id);

alter table notifications enable row level security;
create policy "authenticated read" on notifications for select to authenticated using (true);

-- Interruptores. Viven en la base para poder apagar el envío sin desplegar.
insert into app_settings (key, value) values
  ('whatsapp_enabled', 'false'),
  ('whatsapp_test_mode', 'true'),
  ('whatsapp_test_phone', ''),
  ('public_base_url', 'http://localhost:4000');

-- Las funciones de encolado y despacho están en la migración
-- notifications_queue_functions: enqueue_notification, claim_pending_notifications,
-- mark_notification_sent y mark_notification_failed.


-- ===========================================================================
-- FASE 2 — Presupuesto público
-- ===========================================================================

-- Token propio, igual criterio que el de las órdenes: COT-1007 es correlativo.
alter table quotations
  add column public_token uuid not null default gen_random_uuid(),
  add column decided_at timestamptz,
  add column decided_by_client boolean not null default false;

create unique index quotations_public_token_key on quotations (public_token);

-- decide_quotation es la ÚNICA escritura que puede hacer alguien sin sesión.
-- Todas las guardas están en la base y no en la interfaz: cambiar el HTML no
-- alcanza para saltearlas.
--   NO_EXISTE     token que no corresponde a ninguna cotización
--   YA_RESUELTA   ya fue aceptada o rechazada
--   YA_CONVERTIDA ya generó una orden de trabajo
--   VENCIDA       pasó la fecha de validez
--
-- Aceptar NO convierte en orden de trabajo: el cliente aprueba el presupuesto,
-- el taller decide cuándo abre la orden y descuenta el stock.


-- ===========================================================================
-- FASE 3 — Avisos de la orden de trabajo
-- ===========================================================================

-- Los textos viven en la base para poder corregir una redacción sin desplegar.
create table notification_templates (
  status work_order_status primary key,
  body text not null
);

-- build_work_order_message arma el texto completo. Menciona el vehículo y la
-- patente a propósito: un cliente con varias unidades en el taller necesita
-- saber de cuál le están hablando.

-- Dos triggers sobre work_orders:
--   after insert          -> LINK_SEGUIMIENTO
--   after update of status -> CAMBIO_ESTADO
-- El dedupe_key del segundo lleva el estado destino, así que corregir un
-- estado y volver a avanzarlo NO genera un segundo mensaje al cliente.


-- ===========================================================================
-- Permisos de las funciones internas
-- ===========================================================================
-- Postgres otorga EXECUTE a public por defecto: revocar de anon y
-- authenticated no alcanza, hay que revocar de public.
--
-- claim_pending_notifications devuelve el teléfono y el texto de cada mensaje
-- y sube el contador de intentos. Sin esto, cualquiera podía leer la cola y
-- dejar los avisos sin enviar.
revoke execute on function public.claim_pending_notifications(int) from public;
revoke execute on function public.mark_notification_sent(uuid) from public;
revoke execute on function public.mark_notification_failed(uuid, text) from public;
revoke execute on function public.enqueue_notification(
  notification_kind, text, text, uuid, uuid, uuid, text
) from public, anon, authenticated;
-- build_work_order_message expone el token de seguimiento de cualquier orden.
revoke execute on function public.build_work_order_message(
  uuid, work_order_status, boolean
) from public, anon, authenticated;
