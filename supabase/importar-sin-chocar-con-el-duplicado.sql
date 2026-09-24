-- ===========================================================================
-- Importar una lista ya no aborta por un artículo duplicado en el catálogo
-- ===========================================================================
-- Migración sugerida: importar_sin_chocar
--
-- La importación moría entera con "duplicate key value violates unique
-- constraint articles_factory_code_marca_key", y no en el alta de un artículo
-- nuevo como parecía: en la MODIFICACIÓN de uno existente.
--
-- El caso real, la fila 816 de la lista de Núcleo, código 0433172213:
--
--   · el catálogo ya tenía DOS artículos con ese número de fábrica: el 000438
--     sin marca y el 000879 con marca BOSCH. Son la misma pieza cargada dos
--     veces, una con marca y otra sin;
--   · Núcleo ya tenía su código vinculado al 000438, así que la fila entra por
--     la rama del código de proveedor;
--   · esa rama, cuando el proveedor es el preferido, le copia la marca de la
--     lista al artículo;
--   · al ponerle BOSCH al 000438, su clave pasa a ser (0433172213, BOSCH), que
--     es exactamente la del 000879. El índice único lo rechaza y se cae la
--     importación entera: cinco mil filas perdidas por un duplicado viejo.
--
-- ── Qué hace ahora ─────────────────────────────────────────────────────────
-- Cuando el artículo ya existe se le actualizan los datos importados, que es
-- lo que corresponde. Pero poner la marca se saltea si con esa marca el
-- artículo pasaría a ser idéntico a otro: eso no se resuelve adivinando cuál
-- de los dos sobrevive, y menos en el medio de una importación de miles de
-- filas. El precio y la descripción se actualizan igual.
--
-- Y donde antes daba de alta a ciegas, ahora mira primero si ya existe uno con
-- esa clave y, si existe, lo usa en vez de insertar. Es la misma regla dicha
-- del otro lado: si ya está, se modifica; no se duplica.
--
-- Los casos salteados se cuentan y se devuelven, para que la pantalla los
-- muestre en vez de que queden en silencio: son duplicados del catálogo que
-- alguien tiene que unificar a mano.

drop function if exists public.import_supplier_prices(uuid, text, jsonb);

create function public.import_supplier_prices(
  p_supplier_id uuid,
  p_file_name text,
  p_rows jsonb
)
returns table(
  total_rows integer,
  matched_rows integer,
  linked_rows integer,
  unmatched_rows integer,
  conflicted_rows integer,
  import_id uuid
)
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
  v_conflictos int := 0;
  v_import_id uuid;
  v_supplier_name text;
  r record;
  v_resuelto record;
  v_article_id uuid;
  v_is_preferred boolean;
  v_description text;
  v_vinculo uuid;
  v_fabrica text;
  v_fabrica_actual text;
  v_gemelo uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select name into v_supplier_name
  from suppliers where id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no existe.';
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

    select * into v_resuelto
    from public.resolver_articulo_de_proveedor(p_supplier_id, r.code, r.brand);

    v_fabrica := v_resuelto.factory_code;

    -- AMBIGUO: el número está con más de una marca y la fila no dice cuál. Se
    -- da de alta sin número de fábrica, para no fusionar dos piezas distintas
    -- ni frenar las otras catorce mil filas.
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
        -- ¿Copiarle la marca lo dejaría idéntico a otro artículo? Pasa cuando
        -- la misma pieza está cargada dos veces, una con marca y otra sin.
        v_gemelo := null;
        if r.brand is not null then
          select a.factory_code into v_fabrica_actual from articles a where a.id = v_article_id;

          if v_fabrica_actual is not null then
            select a.id into v_gemelo
            from articles a
            where a.factory_code = v_fabrica_actual
              and a.id <> v_article_id
              and coalesce(upper(trim(a.brand)), '') = upper(trim(r.brand))
            limit 1;
          end if;
        end if;

        if v_gemelo is not null then
          -- La descripción y el precio sí se actualizan: lo único que se
          -- saltea es la marca, que es lo que produciría el choque.
          update articles
             set description = coalesce(r.description, description)
           where id = v_article_id;
          v_conflictos := v_conflictos + 1;
        else
          update articles
             set description = coalesce(r.description, description),
                 brand = coalesce(r.brand, brand)
           where id = v_article_id;
        end if;
      end if;

    elsif v_resuelto.como = 'CODIGO_FABRICA' then
      v_article_id := v_resuelto.article_id;

      -- Puede que este proveedor YA tuviera este artículo con otro código —el
      -- vínculo es único por (artículo, proveedor)—. Se le corrige el código
      -- en vez de insertar: insertar abortaría la importación por la unicidad.
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
      -- Antes insertaba a ciegas. Si otra fila de esta misma importación ya
      -- creó el artículo con esta clave, insertar de nuevo abortaba todo: se
      -- usa el que está.
      v_article_id := null;
      if v_fabrica is not null then
        select a.id into v_article_id
        from articles a
        where a.factory_code = v_fabrica
          and coalesce(upper(trim(a.brand)), '') = coalesce(upper(trim(r.brand)), '')
        limit 1;
      end if;

      if v_article_id is not null then
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
        v_description := coalesce(r.description, 'Sin descripción — importado de ' || v_supplier_name);

        -- Sin code: lo pone el default de la columna, que toma el siguiente de
        -- la secuencia global. unit_price arranca en 0 y lo recalcula
        -- article_suppliers_recalc_price al insertar el vínculo.
        insert into articles (description, brand, unit_price, tracks_stock, stock_quantity, active, factory_code)
        values (v_description, r.brand, 0, false, 0, true, v_fabrica)
        returning id into v_article_id;

        insert into article_suppliers (article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred)
        values (v_article_id, p_supplier_id, r.code, r.description, r.price, true);

        v_created := v_created + 1;
      end if;
    end if;
  end loop;

  insert into price_imports (supplier_id, file_name, total_rows, matched_rows, unmatched_rows)
  values (p_supplier_id, p_file_name, v_total, v_matched + v_linked, v_created)
  returning id into v_import_id;

  return query select v_total, v_matched, v_linked, v_created, v_conflictos, v_import_id;
end;
$function$;

revoke all on function public.import_supplier_prices(uuid, text, jsonb) from public, anon;
grant execute on function public.import_supplier_prices(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'import_supplier_prices') as versiones,
  (select prosrc like '%v_gemelo%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'import_supplier_prices') as tiene_el_guardia;
