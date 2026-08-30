-- ===========================================================================
-- Retenciones pendientes: reclamo manual del comprobante por WhatsApp
-- ===========================================================================
-- Migración: retention-claims
--
-- Una cobranza con retención ya se podía cargar sin certificate_number (la
-- columna siempre fue nullable): eso no cambia acá. Lo que faltaba era una
-- forma de encontrar esas retenciones sin comprobante y reclamarle al
-- cliente, en vez de que quedaran perdidas entre todos los recibos.
--
-- El reclamo reutiliza la cola de WhatsApp que ya existe (notifications +
-- enqueue_notification): agrega un tipo de aviso nuevo y una columna para
-- saber a qué línea de retención corresponde cada mensaje. Es manual a
-- propósito — sin recordatorio automático por cron — porque así lo pidió el
-- taller: el que decide cuándo insistir es una persona, no un temporizador.
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de receipts.sql y
-- whatsapp-completo.sql.


-- ===========================================================================
-- 1) Nuevo tipo de aviso y columna de referencia
-- ===========================================================================
-- Va en su propia sentencia: un valor nuevo de enum no se puede usar en la
-- misma transacción en que se agrega (mismo motivo que 'ANULADO' en
-- receipts.sql). Acá solo se referencia dentro de cuerpos de función, que se
-- resuelven en tiempo de ejecución.
alter type notification_kind add value if not exists 'RETENCION_PENDIENTE';

alter table notifications
  add column receipt_value_id uuid references receipt_values(id) on delete cascade;

create index notifications_receipt_value_idx on notifications (receipt_value_id);


-- ===========================================================================
-- 2) enqueue_notification: agrega el parámetro p_receipt_value_id
-- ===========================================================================
create or replace function public.enqueue_notification(
  p_kind notification_kind,
  p_dedupe_key text,
  p_body text,
  p_customer_id uuid,
  p_work_order_id uuid default null,
  p_quotation_id uuid default null,
  p_media_url text default null,
  p_receipt_value_id uuid default null
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
    to_phone, body, media_url, dedupe_key, last_error, receipt_value_id
  )
  values (
    p_kind, v_status, p_work_order_id, p_quotation_id, p_customer_id,
    v_phone, p_body, p_media_url, p_dedupe_key, v_error, p_receipt_value_id
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.enqueue_notification(
  notification_kind, text, text, uuid, uuid, uuid, text, uuid
) from public, anon, authenticated;


-- ===========================================================================
-- 3) Reclamar una retención pendiente
-- ===========================================================================
-- Encola un WhatsApp al cliente pidiendo el comprobante. No hay límite de
-- veces que se puede reclamar la misma retención: cada click es un mensaje
-- nuevo (el dedupe_key lleva un sufijo propio), a diferencia de los avisos
-- automáticos que sí deduplican por evento.
create or replace function public.claim_pending_retention(p_receipt_value_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value receipt_values%rowtype;
  v_receipt receipts%rowtype;
  v_tax_name text;
  v_body text;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_value from receipt_values where id = p_receipt_value_id;
  if not found then
    raise exception 'La retención no existe.';
  end if;
  if v_value.kind <> 'RETENCION' then
    raise exception 'Ese valor no es una retención.';
  end if;
  if v_value.certificate_number is not null then
    raise exception 'Esa retención ya tiene comprobante cargado.';
  end if;

  select * into v_receipt from receipts where id = v_value.receipt_id;
  if v_receipt.status <> 'REGISTRADO' then
    raise exception 'El recibo % está anulado.', v_receipt.full_number;
  end if;

  select name into v_tax_name from tax_rates where id = v_value.tax_rate_id;

  v_body :=
    'Hola ' || v_receipt.customer_name || ', en el recibo ' || v_receipt.full_number ||
    ' del ' || to_char(v_receipt.receipt_date, 'DD/MM/YYYY') ||
    ' quedó pendiente el comprobante de la retención de ' || coalesce(v_tax_name, 'impuestos') ||
    ' por $ ' || to_char(v_value.amount, 'FM999999990.00') ||
    '. Por favor envíenoslo para nuestros registros. Gracias.';

  v_id := public.enqueue_notification(
    'RETENCION_PENDIENTE',
    'retencion:' || p_receipt_value_id::text || ':' || gen_random_uuid()::text,
    v_body,
    v_receipt.customer_id,
    null, null, null,
    p_receipt_value_id
  );

  return v_id;
end;
$$;

revoke all on function public.claim_pending_retention(uuid) from public, anon;
grant execute on function public.claim_pending_retention(uuid) to authenticated;


comment on column notifications.receipt_value_id is
  'A qué línea de retención corresponde el aviso, cuando kind = RETENCION_PENDIENTE.';
