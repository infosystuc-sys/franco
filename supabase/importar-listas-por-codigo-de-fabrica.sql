-- ===========================================================================
-- Que la importación de listas de precios use el código de fábrica
-- ===========================================================================
-- Migración: importar_listas_por_codigo_de_fabrica
--
-- Correr DESPUÉS de codigo-de-fabrica-multiple.sql.
--
-- Hay dos puertas por donde entra un artículo y las dos hay que tapar:
--
--   * la factura de compra leída con IA  -> link_or_create_supplier_article,
--     ya cubierta en importar-por-codigo-de-fabrica.sql;
--   * la lista de precios               -> import_supplier_prices, que es
--     ESTA, y es por donde van a entrar las listas de Maximiliano y Núcleo.
--
-- Tal como estaba, import_supplier_prices buscaba solo por (proveedor, código
-- del proveedor) y, si no encontraba, creaba el artículo. Como Núcleo lista la
-- tobera 0433172037 y Maximiliano la misma tobera como B0433172037, importar
-- las dos listas creaba DOS artículos para la misma pieza, con dos stocks y
-- dos precios de venta. Justo lo que el código de fábrica viene a evitar.
--
-- Ahora, antes de crear, se pregunta si esa pieza ya está en el catálogo.
--
-- La firma no cambia a propósito: cambiar el tipo de retorno obliga a soltar
-- la función, y eso deja un hueco en el que PostgREST no la encuentra. Las
-- filas que se enganchan por código de fábrica se cuentan como "matched" —
-- que es lo que son: no hubo que crear nada.

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
  v_fabrica text;
  v_como text;
  v_has_preferred boolean;
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

      continue;
    end if;

    -- ── Lo nuevo: ¿esta pieza ya entró por otro proveedor? ──────────────
    select res.article_id, res.como, res.factory_code
      into v_article_id, v_como, v_fabrica
    from public.resolver_articulo_de_proveedor(p_supplier_id, r.code, r.brand) res;

    -- AMBIGUO: el número está en el catálogo con más de una marca y esta fila
    -- no dice cuál es. No se adivina ni se aborta la importación entera por
    -- una fila: se da de alta sin número de fábrica, para no fusionar dos
    -- piezas distintas ni frenar las otras 14.000 filas. Queda como artículo
    -- suelto, a revisar.
    if v_como = 'AMBIGUO' then
      v_article_id := null;
      v_fabrica := null;
    end if;

    if v_article_id is not null then
      -- Ya existe: se le cuelga este proveedor con su código y su precio. El
      -- vínculo es lo que hace que la próxima importación entre por el camino
      -- corto de arriba, sin volver a deducir nada.
      select exists (
        select 1 from article_suppliers s
        where s.article_id = v_article_id and s.is_preferred
      ) into v_has_preferred;

      insert into article_suppliers (
        article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred
      )
      values (v_article_id, p_supplier_id, r.code, r.description, r.price, not v_has_preferred)
      on conflict (article_id, supplier_id) do update
        set supplier_code = excluded.supplier_code,
            supplier_description = coalesce(excluded.supplier_description, article_suppliers.supplier_description),
            purchase_price = excluded.purchase_price;

      -- Un artículo que había entrado sin número de fábrica lo aprende ahora.
      if v_fabrica is not null then
        update articles
           set factory_code = v_fabrica
         where id = v_article_id
           and factory_code is null;
      end if;

      v_matched := v_matched + 1;
      continue;
    end if;

    -- ── No está: se da de alta, guardando de qué pieza y de qué marca es ──
    insert into article_code_sequences (code_prefix, last_number)
    values (v_prefix, 1)
    on conflict (code_prefix) do update
      set last_number = article_code_sequences.last_number + 1
    returning last_number into v_number;

    v_code := v_prefix || '-' || lpad(v_number::text, 8, '0');
    v_description := coalesce(r.description, 'Sin descripción — importado de ' || v_supplier_name);

    -- unit_price arranca en 0: article_suppliers_recalc_price (AFTER INSERT
    -- en article_suppliers, más abajo) lo recalcula solo con
    -- compute_sale_price(), la misma fórmula que usa el resto del sistema.
    insert into articles (
      code, description, brand, unit_price, tracks_stock, stock_quantity, active, factory_code
    )
    values (v_code, v_description, r.brand, 0, false, 0, true, v_fabrica)
    returning id into v_article_id;

    insert into article_suppliers (article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred)
    values (v_article_id, p_supplier_id, r.code, r.description, r.price, true);

    v_created := v_created + 1;
  end loop;

  insert into price_imports (supplier_id, file_name, total_rows, matched_rows, unmatched_rows)
  values (p_supplier_id, p_file_name, v_total, v_matched, v_created)
  returning id into v_import_id;

  return query select v_total, v_matched, v_created, v_import_id;
end;
$function$;

grant execute on function public.import_supplier_prices(uuid, text, jsonb) to authenticated;
