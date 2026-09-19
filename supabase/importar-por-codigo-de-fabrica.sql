-- ===========================================================================
-- Que la importación use el código de fábrica
-- ===========================================================================
-- Migración: importar_por_codigo_de_fabrica
--
-- El código de fábrica existía (supabase/codigo-de-fabrica.sql) pero nadie lo
-- consultaba al dar de alta: link_or_create_supplier_article buscaba solo por
-- (proveedor, código del proveedor) y, si no encontraba, creaba un artículo
-- nuevo. Entonces la misma tobera Bosch entraba tres veces, una por proveedor,
-- con tres stocks y tres precios de venta — que es el problema que el código
-- de fábrica venía a resolver y nunca llegó a resolver.
--
-- Ahora, antes de crear, se pregunta si esa pieza ya está en el catálogo con
-- otro proveedor. Y se guarda de qué marca es, porque el mismo número puede
-- venir en Bosch legítimo y en su reemplazo alternativo.

-- ---------------------------------------------------------------------------
-- La versión que sabe de marcas
-- ---------------------------------------------------------------------------
-- La de cinco argumentos sigue existiendo abajo, como envoltorio: la llama la
-- lectura de facturas con IA que está desplegada hoy, y sacarla la rompería.
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
  v_prefix text;
  v_supplier_name text;
  v_number int;
  v_new_code text;
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

  select code_prefix, name into v_prefix, v_supplier_name
  from suppliers where id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no existe.';
  end if;

  -- Qué número de fábrica hay detrás de este código. Se calcula antes de las
  -- dos ramas porque el artículo elegido a mano también tiene que aprenderlo:
  -- es lo que va a hacer que el próximo proveedor lo encuentre solo.
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
    -- Acá está lo nuevo: antes de crear, ver si esta pieza ya entró por otro
    -- proveedor. El vínculo que se guarda más abajo hace que la próxima vez
    -- entre por el camino corto, sin volver a deducir nada.
    select r.article_id, r.como
      into v_article, v_como
    from public.resolver_articulo_de_proveedor(p_supplier_id, v_code, v_marca) r;

    if v_como = 'AMBIGUO' then
      raise exception 'El número de fábrica % está en el catálogo con más de una marca. Indicá de qué marca es este renglón para saber a cuál corresponde.', v_fabrica;
    end if;

    if v_article is null then
      if v_prefix is null then
        raise exception 'El proveedor % no tiene prefijo de código configurado. Definilo en Proveedores para poder dar de alta artículos desde una factura.', v_supplier_name;
      end if;

      insert into article_code_sequences (code_prefix, last_number)
      values (v_prefix, 1)
      on conflict (code_prefix) do update
        set last_number = article_code_sequences.last_number + 1
      returning last_number into v_number;

      v_new_code := v_prefix || '-' || lpad(v_number::text, 8, '0');

      insert into articles (
        code, description, unit_price, tracks_stock, stock_quantity, active,
        factory_code, brand
      )
      values (
        v_new_code,
        coalesce(v_desc, 'Sin descripción — alta desde factura de ' || v_supplier_name),
        0, false, 0, true,
        v_fabrica, v_marca
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

-- ---------------------------------------------------------------------------
-- El envoltorio de siempre
-- ---------------------------------------------------------------------------
create or replace function public.link_or_create_supplier_article(
  p_supplier_id uuid,
  p_supplier_code text,
  p_description text,
  p_purchase_price numeric,
  p_article_id uuid default null
)
returns table (result_article_id uuid, result_code text, result_description text, result_created boolean)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query
    select r.result_article_id, r.result_code, r.result_description, r.result_created
    from public.link_or_create_supplier_article(
      p_supplier_id, p_supplier_code, p_description, p_purchase_price, p_article_id, null::text
    ) r;
end;
$fn$;

grant execute on function public.link_or_create_supplier_article(uuid, text, text, numeric, uuid) to authenticated;
grant execute on function public.link_or_create_supplier_article(uuid, text, text, numeric, uuid, text) to authenticated;
