-- ===========================================================================
-- Importación de catálogo: actualiza descripción y marca de artículos ya vinculados
-- ===========================================================================
-- Migración: supplier-catalog-import-update-existing
--
-- import_supplier_prices (supplier-catalog-import.sql) ya auto-crea el
-- artículo cuando el código no matchea con ninguno vinculado a ese proveedor
-- — eso cubre código, descripción, marca y precio para artículos NUEVOS. Lo
-- que faltaba: cuando el código SÍ matchea un artículo ya vinculado, solo se
-- actualizaba purchase_price (y supplier_description, que es la descripción
-- del VÍNCULO con el proveedor, no la del artículo). Si el proveedor le
-- corrige el nombre o la marca a un repuesto en su lista, esa corrección se
-- perdía.
--
-- Ahora, si la fila matchea y ese vínculo es el PROVEEDOR PREFERIDO del
-- artículo, también actualiza articles.description y articles.brand. Solo
-- el preferido: si el mismo artículo se compra a dos proveedores que lo
-- describen distinto, la descripción canónica del artículo no puede quedar
-- cambiando según cuál de los dos se importó último — el preferido es la
-- fuente de verdad, igual criterio que ya usa compute_sale_price() para el
-- costo.
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de supplier-catalog-import.sql.

create or replace function public.import_supplier_prices(p_supplier_id uuid, p_file_name text, p_rows jsonb)
returns table(total_rows int, matched_rows int, unmatched_rows int, import_id uuid)
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_total int := 0;
  v_matched int := 0;
  v_created int := 0;
  v_import_id uuid;
  v_prefix text;
  v_supplier_name text;
  r record;
  v_article_id uuid;
  v_is_preferred boolean;
  v_number int;
  v_code text;
  v_description text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select code_prefix, name into v_prefix, v_supplier_name
  from suppliers where id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no existe.';
  end if;
  if v_prefix is null then
    raise exception 'Este proveedor no tiene prefijo de código configurado. Definilo en Proveedores antes de importar.';
  end if;

  for r in
    select
      trim(item->>'code') as code,
      nullif(trim(coalesce(item->>'description', '')), '') as description,
      nullif(trim(coalesce(item->>'brand', '')), '') as brand,
      (item->>'price')::numeric as price
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as item
    where trim(coalesce(item->>'code', '')) <> ''
  loop
    v_total := v_total + 1;

    update article_suppliers
       set purchase_price = r.price,
           supplier_description = coalesce(r.description, supplier_description)
     where supplier_id = p_supplier_id
       and upper(supplier_code) = upper(r.code)
    returning article_id, is_preferred into v_article_id, v_is_preferred;

    if found then
      v_matched := v_matched + 1;

      -- Solo el vínculo preferido corrige la descripción/marca canónica del
      -- artículo: evita que dos proveedores del mismo repuesto se peleen
      -- por cuál nombre queda, y solo pisa si la fila trae el dato.
      if v_is_preferred and (r.description is not null or r.brand is not null) then
        update articles
           set description = coalesce(r.description, description),
               brand = coalesce(r.brand, brand)
         where id = v_article_id;
      end if;
    else
      insert into article_code_sequences (code_prefix, last_number)
      values (v_prefix, 1)
      on conflict (code_prefix) do update
        set last_number = article_code_sequences.last_number + 1
      returning last_number into v_number;

      v_code := v_prefix || '-' || lpad(v_number::text, 8, '0');
      v_description := coalesce(r.description, 'Sin descripción — importado de ' || v_supplier_name);

      -- unit_price arranca en 0: article_suppliers_recalc_price (AFTER
      -- INSERT en article_suppliers, más abajo) lo recalcula solo con
      -- compute_sale_price(), la misma fórmula que usa el resto del
      -- sistema. Calcularlo acá también sería código muerto que además
      -- rompía si faltaba la fila default_markup_percent en app_settings.
      insert into articles (code, description, brand, unit_price, tracks_stock, stock_quantity, active)
      values (v_code, v_description, r.brand, 0, false, 0, true)
      returning id into v_article_id;

      insert into article_suppliers (article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred)
      values (v_article_id, p_supplier_id, r.code, r.description, r.price, true);

      v_created := v_created + 1;
    end if;
  end loop;

  insert into price_imports (supplier_id, file_name, total_rows, matched_rows, unmatched_rows)
  values (p_supplier_id, p_file_name, v_total, v_matched, v_created)
  returning id into v_import_id;

  return query select v_total, v_matched, v_created, v_import_id;
end;
$function$;
