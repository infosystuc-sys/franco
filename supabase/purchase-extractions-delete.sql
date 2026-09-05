-- ===========================================================================
-- Borrar borradores de factura leídos por IA
-- ===========================================================================
-- Migración: purchase_extractions_delete
--
-- La tabla nació sin política de borrado, así que la base rechazaba cualquier
-- delete: un borrador que no servía solo podía marcarse descartado, y tanto la
-- fila como el archivo subido quedaban para siempre.
--
-- La regla importante va acá y no en el navegador: un borrador CONFIRMADO no
-- se borra nunca. Es el único rastro que une una compra ya guardada con el
-- comprobante escaneado del que salió, y perderlo dejaría la compra sin
-- respaldo. Los demás estados —leído sin confirmar, con error, descartado— sí
-- se pueden borrar.

create policy "admin delete" on public.purchase_invoice_extractions
for delete using (is_admin() and status <> 'CONFIRMADO');
