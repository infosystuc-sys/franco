-- Mismo bug que enqueue_notification (ver enqueue-notification-overload-fix.sql),
-- repetido cuatro veces en el lote de migraciones del 2026-08-30: agregar un
-- parámetro nuevo con "create or replace function" no reemplaza la función si
-- la firma de tipos cambia — crea una segunda función con el mismo nombre.
-- Quedaron dos versiones ambiguas de cada una de estas cuatro funciones.
--
-- _create_invoice: la que rompía "Emitir factura" desde una OT (issue_invoice
-- la llama con 5 args, ambiguo entre la de 5 y la de 6 con p_link_remito_id).
-- Confirmado como causa real de "function _create_invoice(...) is not unique".
--
-- issue_free_invoice, save_payment_order, save_receipt: mismo patrón. No
-- estaban dando error porque el frontend siempre pasa el parámetro nuevo por
-- nombre (p_remito_id, p_new_provisional_credit_notes, p_change) — pero es la
-- misma trampa latente que las otras, se limpian preventivamente.
--
-- En los cuatro casos la versión nueva es un superset exacto de la vieja
-- (mismo cuerpo, el parámetro nuevo ya tenía default). Se borran las viejas —
-- ya aplicado contra la base viva el 2026-08-31.
drop function public._create_invoice(uuid, uuid, jsonb, text, boolean);
drop function public.issue_free_invoice(uuid, jsonb, text, boolean);
drop function public.save_payment_order(jsonb, jsonb, jsonb);
drop function public.save_receipt(jsonb, jsonb, jsonb);
