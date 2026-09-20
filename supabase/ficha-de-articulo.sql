-- ===========================================================================
-- La ficha del artículo: origen, rubro, familia y código secuencial
-- ===========================================================================
-- Migración: ficha_de_articulo
--
-- Correr DESPUÉS de importar-listas-por-codigo-de-fabrica.sql.
--
-- Dos cosas:
--
-- 1. LA FICHA GANA TRES DATOS.
--    El catálogo es casi todo Bosch, y lo que hacía falta para poder
--    trabajarlo no estaba: si la pieza es la original o el reemplazo, y cómo
--    se agrupa. La marca y el código de fábrica ya existían.
--
-- 2. EL CÓDIGO PASA A SER SECUENCIAL, SIN PREFIJO.
--    Venía como MD-00000042: prefijo del proveedor más una secuencia propia
--    de ese prefijo. Ese prefijo congelaba un dato que cambia —quién lo trajo
--    primero— y que deja de ser cierto en cuanto el proveedor preferido pasa
--    a ser otro. Además obligaba a inventarle dos letras a cada proveedor
--    nuevo antes de poder importarle nada, sin que sirvieran para nada
--    después: nadie parsea el código, solo se muestra.
--
--    Ahora hay UNA secuencia para todo el catálogo y el código lo pone la
--    base sola. Quien inserta ya no tiene que saber nada del proveedor.

-- ---------------------------------------------------------------------------
-- 1. Original o reemplazo
-- ---------------------------------------------------------------------------
-- El mismo número de fábrica viene en la pieza legítima y en la que la
-- reemplaza —0281002907 está como BOSCH y como NORK—. La marca ya las separa;
-- esto dice qué es cada una sin tener que saberse de memoria qué marcas
-- fabrican y cuáles hacen reemplazos.
--
-- Nulo = no se sabe, que es lo que corresponde a lo que ya está cargado.
-- Es un check y no un enum a propósito: el día que haga falta REMANUFACTURADO
-- o USADO —el tercer proveedor ya los distingue con sufijos R y UP— se agrega
-- con un alter y sin migrar el tipo.
alter table articles add column if not exists part_kind text;

alter table articles drop constraint if exists articles_part_kind_check;
alter table articles add constraint articles_part_kind_check
  check (part_kind is null or part_kind in ('ORIGINAL', 'REEMPLAZO'));

comment on column articles.part_kind is
  'ORIGINAL o REEMPLAZO. Nulo cuando no se sabe.';

-- ---------------------------------------------------------------------------
-- 2. Rubro y familia
-- ---------------------------------------------------------------------------
-- Texto libre y no tablas de catálogo: todavía no sabemos qué rubros van a
-- existir, y armar el ABM de algo que no está decidido sale más caro que
-- corregirlo después. La ficha ofrece los valores ya usados para que el mismo
-- rubro no termine escrito de diez maneras.
alter table articles add column if not exists rubro text;
alter table articles add column if not exists familia text;

comment on column articles.rubro is 'Agrupación mayor: TOBERAS, BOMBAS, INYECTORES...';
comment on column articles.familia is 'Agrupación dentro del rubro: COMMON RAIL, CONVENCIONAL...';

create index if not exists articles_rubro_idx on articles (rubro) where rubro is not null;
create index if not exists articles_familia_idx on articles (familia) where familia is not null;

-- ---------------------------------------------------------------------------
-- 3. El código secuencial
-- ---------------------------------------------------------------------------
create sequence if not exists public.articles_code_seq as bigint;

-- Arranca arriba del último código numérico que ya exista, para no chocar con
-- lo cargado. Los códigos viejos con prefijo (MD-00000007) no son numéricos,
-- no entran en la cuenta y conviven sin molestar.
do $mig$
declare
  v_max bigint;
begin
  select coalesce(max(code::bigint), 0) into v_max
  from articles
  where code ~ '^[0-9]+$';

  perform setval('public.articles_code_seq', v_max + 1, false);
end
$mig$;

-- El código lo pone la base. Quien inserta puede omitirlo, y ahí está la
-- gracia: las funciones de importación dejan de necesitar el prefijo del
-- proveedor, que era lo único que las obligaba a conocerlo.
alter table articles
  alter column code set default lpad(nextval('public.articles_code_seq')::text, 6, '0');

grant usage on sequence public.articles_code_seq to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Importar sin prefijo: lista de precios
-- ---------------------------------------------------------------------------
-- Mismo cuerpo que la versión anterior. Los únicos cambios: se fue la guarda
-- que exigía code_prefix, se fue el bloque que armaba el código a mano, y el
-- insert de articles ya no nombra la columna code.
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
  v_supplier_name text;
  r record;
  v_resuelto record;
  v_article_id uuid;
  v_is_preferred boolean;
  v_description text;
  v_vinculo uuid;
  v_fabrica text;
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
        update articles
           set description = coalesce(r.description, description),
               brand = coalesce(r.brand, brand)
         where id = v_article_id;
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
  end loop;

  insert into price_imports (supplier_id, file_name, total_rows, matched_rows, unmatched_rows)
  values (p_supplier_id, p_file_name, v_total, v_matched + v_linked, v_created)
  returning id into v_import_id;

  return query select v_total, v_matched, v_linked, v_created, v_import_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Importar sin prefijo: renglón de factura de compra
-- ---------------------------------------------------------------------------
create or replace function public.link_or_create_supplier_article(
  p_supplier_id uuid,
  p_supplier_code text,
  p_description text,
  p_purchase_price numeric,
  p_article_id uuid,
  p_marca text
)
returns table (result_article_id uuid, result_code text, result_description text, result_created boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_code text := trim(coalesce(p_supplier_code, ''));
  v_desc text := nullif(trim(coalesce(p_description, '')), '');
  v_price numeric := greatest(coalesce(p_purchase_price, 0), 0);
  v_marca text := nullif(trim(coalesce(p_marca, '')), '');
  v_supplier_name text;
  v_article uuid;
  v_owner uuid;
  v_created boolean := false;
  v_has_preferred boolean;
  v_fabrica text;
  v_como text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if v_code = '' then
    raise exception 'El renglón no tiene código de proveedor, así que no se puede vincular ni dar de alta desde acá.';
  end if;

  select name into v_supplier_name
  from suppliers where id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no existe.';
  end if;

  v_fabrica := public.codigo_de_fabrica(p_supplier_id, v_code);

  select a.article_id into v_owner
  from article_suppliers a
  where a.supplier_id = p_supplier_id
    and upper(a.supplier_code) = upper(v_code);

  if v_owner is not null and p_article_id is null then
    p_article_id := v_owner;
  end if;

  if v_owner is not null and v_owner <> p_article_id then
    raise exception 'El código % ya está asignado a otro artículo de este proveedor.', v_code;
  end if;

  if p_article_id is not null then
    if not exists (select 1 from articles where id = p_article_id) then
      raise exception 'El artículo indicado no existe.';
    end if;
    v_article := p_article_id;
  else
    select r.article_id, r.como
      into v_article, v_como
    from public.resolver_articulo_de_proveedor(p_supplier_id, v_code, v_marca) r;

    if v_como = 'AMBIGUO' then
      raise exception 'El número de fábrica % está en el catálogo con más de una marca. Indicá de qué marca es este renglón para saber a cuál corresponde.', v_fabrica;
    end if;

    if v_article is null then
      -- Sin code: lo pone el default de la columna.
      insert into articles (
        description, unit_price, tracks_stock, stock_quantity, active, factory_code, brand
      )
      values (
        coalesce(v_desc, 'Sin descripción — alta desde factura de ' || v_supplier_name),
        0, false, 0, true, v_fabrica, v_marca
      )
      returning id into v_article;

      v_created := true;
    end if;
  end if;

  -- Un artículo que ya existía pero entró sin número de fábrica lo aprende
  -- ahora: es lo que va a permitir que el próximo proveedor lo encuentre.
  if not v_created and v_fabrica is not null then
    update articles
       set factory_code = v_fabrica
     where id = v_article
       and factory_code is null;
  end if;

  select exists (
    select 1 from article_suppliers s where s.article_id = v_article and s.is_preferred
  ) into v_has_preferred;

  insert into article_suppliers (
    article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred
  )
  values (v_article, p_supplier_id, v_code, v_desc, v_price, not v_has_preferred)
  on conflict (article_id, supplier_id) do update
    set supplier_code = excluded.supplier_code,
        supplier_description = coalesce(excluded.supplier_description, article_suppliers.supplier_description),
        purchase_price = case
          when excluded.purchase_price > 0 then excluded.purchase_price
          else article_suppliers.purchase_price
        end;

  return query
    select a.id, a.code, a.description, v_created
    from articles a
    where a.id = v_article;
end;
$fn$;

grant execute on function public.import_supplier_prices(uuid, text, jsonb) to authenticated;
grant execute on function public.link_or_create_supplier_article(uuid, text, text, numeric, uuid, text) to authenticated;
