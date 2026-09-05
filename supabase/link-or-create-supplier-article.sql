-- ===========================================================================
-- Vincular o dar de alta un artículo desde un renglón de factura
-- ===========================================================================
-- Migración: link_or_create_supplier_article
--
-- La lectura con IA matchea los renglones contra article_suppliers por el
-- código que imprime el proveedor. Cuando no encuentra nada, hasta ahora la
-- única salida era elegir el artículo a mano — y ese trabajo se perdía: el
-- código del proveedor no quedaba guardado, así que la factura siguiente del
-- mismo proveedor volvía a no matchear el mismo renglón, para siempre.
--
-- Esta función cierra las dos puntas en un solo lugar:
--   * con p_article_id, vincula el renglón a un artículo que ya existe y
--     GUARDA el código del proveedor, que es lo que hace que la próxima vez
--     entre solo;
--   * sin p_article_id, da de alta el artículo con el mismo mecanismo que la
--     importación de listas de precios (código interno generado con el
--     prefijo del proveedor) y lo vincula.
--
-- El precio de venta no se calcula acá: al insertar en article_suppliers, el
-- disparador article_suppliers_recalc_price ya lo deriva del precio de compra
-- y la utilidad configurada.

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
as $$
declare
  v_code text := trim(coalesce(p_supplier_code, ''));
  v_desc text := nullif(trim(coalesce(p_description, '')), '');
  v_price numeric := greatest(coalesce(p_purchase_price, 0), 0);
  v_prefix text;
  v_supplier_name text;
  v_number int;
  v_new_code text;
  v_article uuid;
  v_owner uuid;
  v_created boolean := false;
  v_has_preferred boolean;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  -- Sin código no hay nada que aprender: el renglón se podría vincular igual,
  -- pero la próxima factura volvería a no reconocerlo, que es justo el
  -- problema que esta función existe para resolver.
  if v_code = '' then
    raise exception 'El renglón no tiene código de proveedor, así que no se puede vincular ni dar de alta desde acá.';
  end if;

  select code_prefix, name into v_prefix, v_supplier_name
  from suppliers where id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no existe.';
  end if;

  -- ¿Ese código ya tiene dueño en este proveedor? El índice único
  -- (supplier_id, upper(supplier_code)) garantiza que sea uno solo.
  select a.article_id into v_owner
  from article_suppliers a
  where a.supplier_id = p_supplier_id
    and upper(a.supplier_code) = upper(v_code);

  -- Pedir el alta de un código que ya existe no es un error: es que el
  -- artículo se creó después de que la IA leyera el comprobante (otra factura,
  -- otro renglón, otra sesión). Se vincula al que ya está en vez de frenar al
  -- usuario para que haga a mano lo que acá se sabe hacer.
  if v_owner is not null and p_article_id is null then
    p_article_id := v_owner;
  end if;

  -- Lo que sí es un error es querer atar ese código a OTRO artículo: dejaría
  -- dos disputándose el mismo código, y el índice único lo rechazaría con un
  -- mensaje que no le dice nada a quien está cargando la factura.
  if v_owner is not null and v_owner <> p_article_id then
    raise exception 'El código % ya está asignado a otro artículo de este proveedor.', v_code;
  end if;

  if p_article_id is not null then
    if not exists (select 1 from articles where id = p_article_id) then
      raise exception 'El artículo indicado no existe.';
    end if;
    v_article := p_article_id;
  else
    if v_prefix is null then
      raise exception 'El proveedor % no tiene prefijo de código configurado. Definilo en Proveedores para poder dar de alta artículos desde una factura.', v_supplier_name;
    end if;

    -- Mismo generador que usa la importación de listas de precios, para que
    -- el catálogo no termine con dos criterios de numeración según por dónde
    -- entró el artículo.
    insert into article_code_sequences (code_prefix, last_number)
    values (v_prefix, 1)
    on conflict (code_prefix) do update
      set last_number = article_code_sequences.last_number + 1
    returning last_number into v_number;

    v_new_code := v_prefix || '-' || lpad(v_number::text, 8, '0');

    insert into articles (code, description, unit_price, tracks_stock, stock_quantity, active)
    values (
      v_new_code,
      coalesce(v_desc, 'Sin descripción — alta desde factura de ' || v_supplier_name),
      0, false, 0, true
    )
    returning id into v_article;

    v_created := true;
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
        -- Un renglón sin precio legible no tiene por qué borrar el precio de
        -- compra que ya estaba cargado.
        purchase_price = case
          when excluded.purchase_price > 0 then excluded.purchase_price
          else article_suppliers.purchase_price
        end;

  return query
    select a.id, a.code, a.description, v_created
    from articles a
    where a.id = v_article;
end;
$$;

grant execute on function public.link_or_create_supplier_article(uuid, text, text, numeric, uuid) to authenticated;
