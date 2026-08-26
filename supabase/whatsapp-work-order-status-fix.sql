-- DieselPro ERP — WhatsApp: la OT solo avisa en Autorizado y Terminado
--
-- ⚠️ YA APLICADO directo en el proyecto Supabase "Ludiesel" vía MCP, el
-- 26/08/2026 (migración work_order_status_notifications_only_terminado).
-- No hace falta volver a correrlo. Queda como registro del esquema.
--
-- Por qué existe este archivo:
--   whatsapp.sql documenta la fase 3 (avisos de la OT) solo con comentarios
--   —"Dos triggers sobre work_orders: after insert → LINK_SEGUIMIENTO, after
--   update of status → CAMBIO_ESTADO"— sin el cuerpo real de las funciones.
--   Ese hueco ya existía antes de este cambio; este archivo cierra la parte
--   que se tocó, con la definición leída y verificada contra la base viva,
--   no reconstruida de memoria.
--
-- Qué cambió:
--   enqueue_work_order_status() —el trigger que dispara en cada cambio de
--   estado— avisaba por WhatsApp en los 5 estados. Ahora solo en TERMINADO.
--   Autorizado ya se cubría aparte, con enqueue_work_order_created() al
--   crear la orden (no se tocó). Los tres estados intermedios —espera de
--   repuestos, en reparación, calibración— eran operativos del taller: no
--   le agregaban nada al cliente que el link de seguimiento no mostrara ya,
--   y sumaban a 5 WhatsApp por reparación en vez de 2.
--
--   No se tocaron las plantillas (notification_templates sigue con las 5,
--   por si algún día se quiere reactivar un aviso intermedio) ni la cola,
--   ni el despachador, ni el trigger de creación.

create or replace function public.enqueue_work_order_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = old.status then
    return null;
  end if;

  -- Solo TERMINADO avisa. Autorizado ya se cubre en enqueue_work_order_created
  -- (al crear la OT). Los tres estados intermedios (espera de repuestos, en
  -- reparación, calibración) son operativos del taller: no le aportan nada al
  -- cliente que el link de seguimiento no muestre ya, y eran 5 WhatsApp por
  -- reparación en vez de 2.
  if new.status <> 'TERMINADO' then
    return null;
  end if;

  perform enqueue_notification(
    'CAMBIO_ESTADO',
    'ot:' || new.id::text || ':estado:' || new.status::text,
    build_work_order_message(new.id, new.status, false),
    new.customer_id,
    new.id
  );
  return null;
end;
$function$;
