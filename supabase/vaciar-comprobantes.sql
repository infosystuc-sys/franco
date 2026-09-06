-- ===========================================================================
-- La app queda sin comprobantes para probar los circuitos nuevos
-- ===========================================================================
-- Migraciones: vaciar_comprobantes + stock_sin_comprobantes
--
-- Se van los comprobantes; se quedan los maestros (clientes, proveedores,
-- vehículos, artículos, empleados, estados de OT, medios de pago) y el
-- aprendizaje del catálogo: los códigos con que cada proveedor llama a cada
-- artículo, que es lo que hace que la lectura por IA reconozca una factura.
--
-- Dos cosas que hay que saber antes de repetir esto:
--
--   * El orden no es negociable. Media docena de claves foráneas están en
--     RESTRICT, así que borrar de arriba hacia abajo hace que la base rechace
--     todo. Se empieza por lo que apunta y se termina por lo apuntado.
--
--   * De los saldos, el único que hay que corregir a mano es el stock de las
--     compras. Caja, banco y cuenta corriente son calculados —no hay columna
--     guardada— así que se corrigen solos. El stock que descontaron las
--     órdenes vuelve solo, por el disparador de sus renglones. El que
--     sumaron las compras NO: save_purchase_invoice lo suma imperativamente
--     y no hay nada del otro lado que lo reste.

-- ── 1) Los avisos se callan ────────────────────────────────────────────────
-- Soltar el vínculo entre cotización y orden es un UPDATE, y esta base manda
-- WhatsApp de verdad: los teléfonos de los clientes de prueba son reales.
alter table quotations disable trigger quotations_enqueue_sent;
alter table work_orders disable trigger work_orders_enqueue_status;

-- ── 2) El vínculo circular se suelta ───────────────────────────────────────
-- work_orders.quotation_id y quotations.work_order_id se apuntan en RESTRICT
-- mutuo: sin soltar uno, ninguna de las dos tablas se puede borrar.
update quotations set work_order_id = null where work_order_id is not null;

-- ── 3) Cobranzas y pagos ───────────────────────────────────────────────────
-- Van primero: son los que retienen facturas, cheques y tesorería.
delete from receipts;              -- arrastra imputaciones, valores y cambios
delete from payment_orders;        -- arrastra imputaciones y valores
delete from provisional_credit_notes;
delete from third_party_checks;    -- ya sin valores que los referencien

-- ── 4) Ventas ──────────────────────────────────────────────────────────────
delete from remitos;               -- apunta a facturas
delete from invoices;              -- apunta a órdenes de trabajo

-- ── 5) Compras ─────────────────────────────────────────────────────────────
delete from purchase_invoice_extractions;  -- borradores leídos por IA
delete from purchase_invoices;

-- ── 6) Recepciones del circuito viejo ──────────────────────────────────────
delete from vehicle_intakes;       -- apuntan a cotizaciones

-- ── 7) Órdenes de trabajo y cotizaciones ───────────────────────────────────
-- Al borrar los renglones, work_order_items_stock devuelve al inventario lo
-- que cada orden había descontado.
delete from work_orders;
delete from quotations;

-- ── 8) Tesorería ───────────────────────────────────────────────────────────
-- Recién ahora: recibos, pagos y cheques la referenciaban en RESTRICT.
delete from treasury_movements;

-- ── 9) Avisos huérfanos ────────────────────────────────────────────────────
delete from notifications;

-- ── 10) La numeración vuelve a empezar ─────────────────────────────────────
-- Es una base de prueba: leer OT-1 y COT-1 mientras se recorre el circuito
-- vale más que conservar la idea de que hubo actividad previa.
select setval('work_order_number_seq', 1, false);
select setval('quotation_number_seq', 1, false);
update invoice_sequences set last_number = 0;
update remito_sequences set last_number = 0;
update receipt_sequence set last_number = 0;
update payment_order_sequence set last_number = 0;
update treasury_sequences set last_number = 0;
update provisional_credit_note_sequence set last_number = 0;

-- ── 11) Los avisos vuelven ─────────────────────────────────────────────────
alter table quotations enable trigger quotations_enqueue_sent;
alter table work_orders enable trigger work_orders_enqueue_status;

-- ── 12) El inventario deja de contar la mercadería comprada ────────────────
-- Sin esto el stock quedaría contando una mercadería que ya no tiene respaldo
-- en ningún comprobante. Las dos compras con artículos de stock fueron
-- FACTURA con movimiento de inventario, 1 unidad cada una.
--
-- Verificado contra el valor de partida (stock − comprado + consumido):
--   BOS-093  40   (sin compras; la OT le devolvió 5)
--   BOS-201   8   (9 tras la devolución, −1 de la compra)
--   DEL-442  25   (sin compras; la OT le devolvió 1)
--   FIL-010  60   (61 tras la devolución, −1 de la compra)
--
-- Los demás artículos tocados no llevan stock (tracks_stock = false), así que
-- adjust_article_stock nunca los movió: mano de obra, calibración y los MD-*
-- que nacieron de la factura de Maximiliano.
update articles set stock_quantity = stock_quantity - 1 where code = 'BOS-201';
update articles set stock_quantity = stock_quantity - 1 where code = 'FIL-010';
