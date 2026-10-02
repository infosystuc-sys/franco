-- Por ahora el precio de venta se carga a mano: no lo recalcula nada.
--
-- Hasta acá se recalculaba solo (compra del proveedor preferido + utilidad)
-- al importar una lista de precios, al cargar una compra, al cambiar la
-- utilidad de un artículo o la global. Se apagan los dos disparadores que lo
-- hacían; quedan en la base, deshabilitados, para volver a encenderlos con
-- "enable trigger" si se decide retomar el cálculo.
alter table public.article_suppliers disable trigger article_suppliers_recalc_price;
alter table public.articles disable trigger articles_markup_recalc;

-- El recálculo masivo (lo llamaba "Guardar y recalcular" de la utilidad
-- global) queda sin efecto: devuelve 0 sin tocar ningún precio.
create or replace function public.recalculate_all_sale_prices()
returns integer
language sql
as $$ select 0 $$;
