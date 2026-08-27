-- DieselPro ERP — WhatsApp: reabrir una OT terminada y volver a terminarla
-- manda un segundo aviso
--
-- ⚠️ YA APLICADO directo en el proyecto Supabase "Ludiesel" vía MCP, el
-- 26/08/2026 (migración work_order_status_notify_allows_reopen).
-- No hace falta volver a correrlo. Queda como registro del esquema.
--
-- Qué pasaba:
--   Al agregar la reapertura de OT terminadas (src/pages/WorkOrderDetails.tsx,
--   commit "OT: permitir reabrir una orden terminada"), una orden puede pasar
--   por TERMINADO más de una vez. enqueue_work_order_status() (ver
--   whatsapp-work-order-status-fix.sql) armaba siempre la misma dedupe_key:
--   'ot:<id>:estado:TERMINADO'. enqueue_notification inserta con
--   "on conflict (dedupe_key) do nothing" —pensado para no reenviar si se
--   corrige un estado por error y se vuelve a avanzar— así que la segunda vez
--   que la orden llegaba a TERMINADO, el insert se descartaba en silencio: el
--   cliente nunca se enteraba de que el trabajo estaba listo otra vez.
--
-- Qué cambió:
--   La dedupe_key ahora lleva un número de secuencia por cada vez que la
--   orden llega a TERMINADO, contando cuántos avisos de ese tipo ya existen
--   para esa orden. La primera vez conserva exactamente la key de siempre
--   ('...:estado:TERMINADO', sin sufijo) para no dejar huérfanas las filas ya
--   enviadas; de la segunda en adelante suma ':2', ':3', etc.

create or replace function public.enqueue_work_order_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_base_key text;
  v_seq int;
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

  v_base_key := 'ot:' || new.id::text || ':estado:' || new.status::text;

  select count(*) + 1 into v_seq
  from notifications
  where dedupe_key = v_base_key or dedupe_key like v_base_key || ':%';

  perform enqueue_notification(
    'CAMBIO_ESTADO',
    case when v_seq = 1 then v_base_key else v_base_key || ':' || v_seq::text end,
    build_work_order_message(new.id, new.status, false),
    new.customer_id,
    new.id
  );
  return null;
end;
$function$;
