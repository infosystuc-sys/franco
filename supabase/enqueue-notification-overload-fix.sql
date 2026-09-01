-- Fix: enqueue_notification quedó con dos versiones ambiguas después de
-- retention-claims.sql (2026-08-30), que agregó el parámetro
-- p_receipt_value_id en vez de reemplazar la función existente
-- (create or replace solo reemplaza si la firma de tipos es idéntica;
-- agregar un parámetro crea una segunda función con el mismo nombre).
--
-- Desde esa migración, cualquier llamado que no pasara los 7-8 parámetros
-- explícitos —es decir, prácticamente todos los que hay en el código:
-- crear una OT (enqueue_work_order_created), marcarla Terminado
-- (enqueue_work_order_status), pedir autorización de cambio de precio
-- (request_price_authorization), avisar una cotización enviada— quedaba
-- ambiguo entre las dos versiones, y Postgres lo rechazaba con
-- "function enqueue_notification(...) is not unique". Como los triggers no
-- capturan la excepción, esto abortaba la transacción completa: no se podía
-- crear una OT nueva, ni cerrarla, ni pedir autorización de precio.
--
-- La versión de 8 parámetros (definida en retention-claims.sql) es un
-- superset exacto de esta de 7: mismo cuerpo, el único parámetro nuevo ya
-- default a null. Se borra la vieja sin perder nada — ya aplicado contra
-- la base viva el 2026-08-31.
drop function public.enqueue_notification(
  notification_kind, text, text, uuid, uuid, uuid, text
);
