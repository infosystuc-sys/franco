-- ===========================================================================
-- Que la importación de listas pase la marca al resolver
-- ===========================================================================
-- Migración: importar_listas_pasan_marca
--
-- Correr DESPUÉS de codigo-de-fabrica-multiple.sql.
--
-- import_supplier_prices ya resolvía por código de fábrica. Lo que le falta,
-- ahora que el artículo se identifica por (número de fábrica, marca), es
-- PASAR la marca: llamaba a resolver_articulo_de_proveedor con dos argumentos
-- y el resolvedor tenía que adivinar.
--
-- Con dos artículos bajo el mismo número —el Bosch legítimo y su reemplazo—
-- adivinar significaba engancharse al primero que apareciera. Ahora el
-- resolvedor devuelve AMBIGUO en ese caso, y esta función tiene que saber qué
-- hacer con eso o la importación se cae por la unicidad del índice.
--
-- Todo lo demás queda EXACTAMENTE igual que en la función que está viva: los
-- cinco contadores, el arreglo del vínculo que ya existía con otro código, y
-- el criterio de que solo el proveedor preferido corrige la descripción
-- canónica. Este archivo es un parche sobre eso, no una reescritura.

create or replace function public.import_supplier_prices(p_supplier_id uuid, p_file_name text, p_rows jsonb)
returns table(total_rows integer, matched_rows integer, linked_rows integer, unmatched_rows integer, import_id uuid)
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_total int := 0;
  v_matched int := 0;
  v_linked int := 0;
  v_created int := 0;
  v_import_id uuid;
  v_prefix text;
  v_supplier_name text;
  r record;
  v_resuelto record;
  v_article_id uuid;
  v_is_preferred boolean;
  v_number int;
  v_code text;
  v_description text;
  v_vinculo uuid;
  v_fabrica text;
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

    -- LO ÚNICO QUE CAMBIA: se le pasa la marca de la fila. Con ella, el
    -- resolvedor busca el par exacto (número de fábrica, marca) y distingue la
    -- tobera Bosch de su reemplazo, que llevan el mismo número.
    select * into v_resuelto
    from public.resolver_articulo_de_proveedor(p_supplier_id, r.code, r.brand);

    v_fabrica := v_resuelto.factory_code;

    -- AMBIGUO solo puede pasar cuando la fila NO trae marca y el número está
    -- en el catálogo con más de una. No se adivina ni se aborta la importación
    -- entera por una fila: se da de alta sin número de fábrica —así no choca
    -- con el índice único ni se fusiona con la pieza equivocada— y queda como
    -- artículo suelto, a revisar. La forma de que no pase es mapear la columna
    -- de marca al importar.
    if v_resuelto.como = 'AMBIGUO' then
      v_resuelto.como := 'NO_ENCONTRADO';
      v_fabrica := null;
    end if;

    if v_resuelto.como = 'CODIGO_PROVEEDOR' then
      update article_suppliers
         set purchase_price = r.price,
             supplier_description = coalesce(r.description, supplier_description)
       where supplier_id = p_supplier_id
         and upper(supplier_code) = upper(r.code)
      returning article_id, is_preferred into v_article_id, v_is_preferred;

      v_matched := v_matched + 1;

      if v_is_preferred and (r.description is not null or r.brand is not null) then
        update articles
           set description = coalesce(r.description, description),
               brand = coalesce(r.brand, brand)
         where id = v_article_id;
      end if;

    elsif v_resuelto.como = 'CODIGO_FABRICA' then
      -- La pieza ya existe, cargada por otro proveedor: se le suma este con el
      -- código que usa él, en vez de duplicar el artículo.
      v_article_id := v_resuelto.article_id;

      -- Puede que este proveedor YA tuviera este artículo con otro código —el
      -- vínculo es único por (artículo, proveedor)—. En ese caso se le corrige
      -- el código, no se inserta uno nuevo: insertar abortaría la importación
      -- entera por la unicidad.
      select id into v_vinculo
      from article_suppliers
      where article_id = v_article_id and supplier_id = p_supplier_id;

      if v_vinculo is not null then
        update article_suppliers
           set supplier_code = r.code,
               supplier_description = coalesce(r.description, supplier_description),
               purchase_price = r.price
         where id = v_vinculo;
      else
        insert into article_suppliers (
          article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred
        )
        values (v_article_id, p_supplier_id, r.code, r.description, r.price, false);
      end if;

      v_linked := v_linked + 1;

    else
      insert into article_code_sequences (code_prefix, last_number)
      values (v_prefix, 1)
      on conflict (code_prefix) do update
        set last_number = article_code_sequences.last_number + 1
      returning last_number into v_number;

      v_code := v_prefix || '-' || lpad(v_number::text, 8, '0');
      v_description := coalesce(r.description, 'Sin descripción — importado de ' || v_supplier_name);

      -- El código de fábrica se guarda ahora: es lo que va a permitir que el
      -- próximo proveedor que traiga esta misma pieza la reconozca.
      insert into articles (code, description, brand, unit_price, tracks_stock, stock_quantity, active, factory_code)
      values (v_code, v_description, r.brand, 0, false, 0, true, v_fabrica)
      returning id into v_article_id;

      insert into article_suppliers (article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred)
      values (v_article_id, p_supplier_id, r.code, r.description, r.price, true);

      v_created := v_created + 1;
    end if;
  end loop;

  insert into price_imports (supplier_id, file_name, total_rows, matched_rows, unmatched_rows)
  values (p_supplier_id, p_file_name, v_total, v_matched + v_linked, v_created)
  returning id into v_import_id;

  return query select v_total, v_matched, v_linked, v_created, v_import_id;
end;
$function$;

grant execute on function public.import_supplier_prices(uuid, text, jsonb) to authenticated;
