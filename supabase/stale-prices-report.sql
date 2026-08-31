-- ===========================================================================
-- Alerta de precios desactualizados
-- ===========================================================================
-- Migración: stale-prices-report
--
-- article_suppliers.updated_at ya se actualiza solo cuando cambia el precio
-- de compra (trigger existente) — cubre los artículos con proveedor
-- preferido. Los que no tienen proveedor preferido llevan el precio de
-- venta a mano, y articles no tenía ninguna columna que dijera hace cuánto
-- no se toca ese precio: se agrega articles.price_updated_at, tocada SOLO
-- cuando cambia unit_price (no en cualquier UPDATE de articles — stock,
-- marca o estado no son "el precio cambió", y mezclarlo ensuciaría la
-- señal).
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de price-lists-functions.sql.


-- ===========================================================================
-- 1) articles.price_updated_at: cuándo cambió unit_price por última vez
-- ===========================================================================
-- Para lo ya cargado no hay forma de saber la fecha real del último cambio
-- de precio — se usa created_at como mejor aproximación disponible ("hasta
-- donde se sabe, no cambió desde que se creó"), en vez de resetear todo a
-- hoy, que mentiría mostrando "0 días" en artículos viejos sin proveedor
-- preferido.
alter table articles add column price_updated_at timestamptz;
update articles set price_updated_at = created_at where price_updated_at is null;
alter table articles alter column price_updated_at set not null;
alter table articles alter column price_updated_at set default now();

create or replace function public.articles_track_price_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.unit_price is distinct from old.unit_price then
    new.price_updated_at := now();
  end if;
  return new;
end;
$$;

-- BEFORE UPDATE, después de articles_markup_recalc en orden alfabético: si
-- esa recalcula unit_price por la utilidad, esta ya ve el valor nuevo y
-- registra el cambio en la misma pasada.
create trigger articles_price_updated_at
before update on articles
for each row execute function public.articles_track_price_change();


-- ===========================================================================
-- 2) Informe: artículos con precio sin cambiar, ordenados de más viejo a más nuevo
-- ===========================================================================
-- Sin parámetro de días a propósito: lista todo ordenado por antigüedad, el
-- taller decide su propio umbral mirando la columna o filtrando en Excel —
-- mismo criterio que report_stock_valued(), que tampoco lleva período.
create or replace function public.report_stale_prices()
returns table (
  code text,
  description text,
  proveedor text,
  precio_compra numeric,
  precio_venta numeric,
  actualizado date,
  dias_sin_cambiar int
)
language sql
stable
as $$
  select
    a.code,
    a.description,
    coalesce(s.name, '— sin proveedor preferido —'),
    sp.purchase_price,
    a.unit_price,
    coalesce(sp.updated_at, a.price_updated_at)::date,
    (current_date - coalesce(sp.updated_at, a.price_updated_at)::date)::int
  from articles a
  left join article_suppliers sp on sp.article_id = a.id and sp.is_preferred
  left join suppliers s on s.id = sp.supplier_id
  where a.active
  order by 7 desc;
$$;

revoke all on function public.report_stale_prices() from public, anon;
grant execute on function public.report_stale_prices() to authenticated;
