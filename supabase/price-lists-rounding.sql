-- ===========================================================================
-- Precio de venta: redondeo hacia arriba a múltiplo de $10
-- ===========================================================================
-- Migración: price-lists-rounding
--
-- compute_sale_price() redondeaba a 2 decimales exactos. El pedido es otro:
-- redondeo hacia arriba, sin decimales, a un entero terminado en cero — es
-- decir, al múltiplo de $10 más cercano hacia arriba. $12.341 → $12.350,
-- $12.340 → $12.340 (ya es múltiplo, no sube de más).
--
-- Mismo criterio en el espejo TypeScript computeSalePrice() (src/lib/articles.ts),
-- que se usa para previsualizar el precio antes de guardar.
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de price-lists-functions.sql.

create or replace function public.compute_sale_price(p_article_id uuid, p_markup numeric)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_purchase numeric;
begin
  select purchase_price into v_purchase
  from article_suppliers
  where article_id = p_article_id and is_preferred
  limit 1;

  if v_purchase is null then
    return null;
  end if;

  return ceil(v_purchase * (1 + public.effective_markup(p_markup) / 100.0) / 10) * 10;
end;
$$;
