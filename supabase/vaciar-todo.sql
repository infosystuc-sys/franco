-- ===========================================================================
-- La app queda vacía: comprobantes, artículos, clientes y vehículos
-- ===========================================================================
-- Migración: vaciar_todo
--
-- Extiende supabase/vaciar-comprobantes.sql, que dejaba los maestros. Esta vez
-- se van también los artículos, los clientes y los vehículos.
--
-- SE QUEDAN, porque no se pidió borrarlos:
--   proveedores (con sus prefijos F, B, C y NU recién configurados),
--   empleados y mecánicos, medios de pago, bancos, alícuotas, conceptos de
--   gasto, estados de OT, marcas y modelos de vehículo, datos del taller,
--   usuarios y plantillas de aviso.
--
-- ESTO NO SE PUEDE DESHACER. Correrlo entero, de una sola vez.
--
-- Tres cosas que hay que saber:
--
--   * El orden no es negociable. Media docena de claves foráneas están en
--     RESTRICT: borrar de arriba hacia abajo hace que la base rechace todo.
--     Se empieza por lo que apunta y se termina por lo apuntado.
--
--   * Esta base manda WhatsApp de verdad y los teléfonos de los clientes de
--     prueba son reales. Soltar el vínculo entre cotización y orden es un
--     UPDATE que dispararía avisos, así que los disparadores se apagan y se
--     vuelven a encender al final.
--
--   * Las fotos siguen en Supabase Storage. Esto borra las filas que las
--     nombran, no los archivos: Supabase no deja borrar storage.objects desde
--     SQL. Hay que vaciar los buckets work-order-photos y vehicle-photos
--     desde el panel, en Storage.

-- ── 1) Los avisos se callan ────────────────────────────────────────────────
alter table quotations disable trigger quotations_enqueue_sent;
alter table work_orders disable trigger work_orders_enqueue_status;

-- ── 2) El vínculo circular se suelta ───────────────────────────────────────
-- work_orders.quotation_id y quotations.work_order_id se apuntan en RESTRICT
-- mutuo: sin soltar uno, ninguna de las dos tablas se puede borrar.
update quotations set work_order_id = null where work_order_id is not null;

-- ── 3) Cobranzas y pagos ───────────────────────────────────────────────────
-- Van primero: son los que retienen facturas, cheques y tesorería.
delete from receipts where id is not null;              -- arrastra imputaciones, valores y cambios
delete from payment_orders where id is not null;        -- arrastra imputaciones y valores
delete from provisional_credit_notes where id is not null;
delete from third_party_checks where id is not null;    -- ya sin valores que los referencien

-- ── 4) Ventas ──────────────────────────────────────────────────────────────
delete from remitos where id is not null;               -- apunta a facturas
delete from invoices where id is not null;              -- apunta a órdenes de trabajo

-- ── 5) Compras ─────────────────────────────────────────────────────────────
delete from purchase_invoice_extractions where id is not null;  -- borradores leídos por IA
delete from purchase_invoices where id is not null;

-- ── 6) Recepciones del circuito viejo ──────────────────────────────────────
delete from vehicle_intakes where id is not null;       -- apuntan a cotizaciones

-- ── 7) Lo que cuelga de la orden y no se va con ella ───────────────────────
-- La cuenta corriente del mecánico apunta a la orden que la generó. No existía
-- cuando se escribió vaciar-comprobantes.sql, así que acá va explícita.
delete from mechanic_account_entries where id is not null;
delete from yard_reservations where id is not null;

-- ── 8) Órdenes de trabajo y cotizaciones ───────────────────────────────────
delete from work_orders where id is not null;
delete from quotations where id is not null;

-- ── 9) Tesorería ───────────────────────────────────────────────────────────
-- Recién ahora: recibos, pagos y cheques la referenciaban en RESTRICT.
delete from treasury_movements where id is not null;

-- ── 10) Avisos huérfanos ───────────────────────────────────────────────────
-- Antes de los clientes: los nombran.
delete from notifications where id is not null;

-- ── 11) El catálogo ────────────────────────────────────────────────────────
-- Los componentes de combo van primero: apuntan a artículos en RESTRICT, que
-- es justo lo que impide sacar del catálogo una pieza que forma parte de un
-- combo. El resto ya no tiene renglones que lo referencien.
delete from article_components where combo_article_id is not null;
delete from article_suppliers where article_id is not null;
delete from unmatched_supplier_prices where id is not null;
delete from price_imports where id is not null;
delete from articles where id is not null;

-- ── 12) Vehículos y clientes ───────────────────────────────────────────────
-- Las fotos y las piezas cuelgan del vehículo; los vehículos, del cliente.
delete from vehicle_photos where id is not null;
delete from vehicle_parts where id is not null;
delete from vehicles where id is not null;
delete from customers where id is not null;

-- ── 13) La numeración vuelve a empezar ─────────────────────────────────────
select setval('work_order_number_seq', 1, false);
select setval('quotation_number_seq', 1, false);
select setval('articles_code_seq', 1, false);
update invoice_sequences set last_number = 0 where last_number <> 0;
update remito_sequences set last_number = 0 where last_number <> 0;
update receipt_sequence set last_number = 0 where last_number <> 0;
update payment_order_sequence set last_number = 0 where last_number <> 0;
update treasury_sequences set last_number = 0 where last_number <> 0;
update provisional_credit_note_sequence set last_number = 0 where last_number <> 0;
delete from article_code_sequences where code_prefix is not null;

-- ── 14) Los avisos vuelven ─────────────────────────────────────────────────
alter table quotations enable trigger quotations_enqueue_sent;
alter table work_orders enable trigger work_orders_enqueue_status;

-- ── 15) Qué quedó ──────────────────────────────────────────────────────────
-- Las tres primeras tienen que dar 0; las otras, lo que había.
select 'articulos' as tabla, count(*) from articles
union all select 'clientes', count(*) from customers
union all select 'ordenes', count(*) from work_orders
union all select 'facturas', count(*) from invoices
union all select 'PROVEEDORES (se quedan)', count(*) from suppliers
union all select 'EMPLEADOS (se quedan)', count(*) from technicians
union all select 'MEDIOS DE PAGO (se quedan)', count(*) from payment_methods
union all select 'ESTADOS DE OT (se quedan)', count(*) from work_order_statuses;
