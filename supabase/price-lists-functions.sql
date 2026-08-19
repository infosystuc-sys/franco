-- DieselPro ERP — cálculo de precios de venta e importación de listas de compra
-- Ejecutar DESPUÉS de price-lists.sql

-- ===== 1) Utilidad efectiva: la del artículo, o la global si no tiene propia.
create or replace function public.effective_markup(p_markup numeric)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(
    p_markup,
    (select value::numeric from app_settings where key = 'default_markup_percent'),
    0
  );
$$;


-- ===== 2) Precio de venta = compra del preferido × (1 + utilidad%), a 2 decimales.
-- Devuelve NULL si el artículo no tiene proveedor preferido: en ese caso no se
-- puede calcular y se conserva el precio que tenga cargado a mano.
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

  return round(v_purchase * (1 + public.effective_markup(p_markup) / 100.0), 2);
end;
$$;


-- ===== 3) Recalcular al cambiar precios o el proveedor preferido.
create or replace function public.article_suppliers_recalc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_article uuid;
  v_price numeric;
  v_markup numeric;
begin
  v_article := coalesce(new.article_id, old.article_id);

  select markup_percent into v_markup from articles where id = v_article;
  v_price := compute_sale_price(v_article, v_markup);

  if v_price is not null then
    update articles set unit_price = v_price where id = v_article;
  end if;

  return null;
end;
$$;

create trigger article_suppliers_recalc_price
after insert or update of purchase_price, is_preferred or delete on article_suppliers
for each row execute function public.article_suppliers_recalc();


-- ===== 4) Recalcular al cambiar la utilidad del artículo.
-- Es BEFORE UPDATE y modifica NEW, así no dispara otra actualización: por eso
-- el trigger anterior (que hace UPDATE articles) no entra en recursión.
create or replace function public.articles_recalc_on_markup()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_price numeric;
begin
  if new.markup_percent is distinct from old.markup_percent then
    v_price := compute_sale_price(new.id, new.markup_percent);
    if v_price is not null then
      new.unit_price := v_price;
    end if;
  end if;
  return new;
end;
$$;

create trigger articles_markup_recalc
before update on articles
for each row execute function public.articles_recalc_on_markup();


-- ===== 5) Marcar el proveedor preferido de un artículo (uno solo a la vez).
create or replace function public.set_preferred_supplier(p_article_id uuid, p_supplier_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  -- Primero se limpia el anterior: el índice único parcial no admite dos.
  update article_suppliers set is_preferred = false
  where article_id = p_article_id and is_preferred and supplier_id <> p_supplier_id;

  update article_suppliers set is_preferred = true
  where article_id = p_article_id and supplier_id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no está vinculado a este artículo.';
  end if;
end;
$$;


-- ===== 6) Recalcular todos los precios de venta.
-- Se usa al cambiar la utilidad global, que afecta a los artículos sin
-- utilidad propia.
create or replace function public.recalculate_all_sale_prices()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer := 0;
  r record;
  v_price numeric;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  for r in select id, markup_percent from articles loop
    v_price := compute_sale_price(r.id, r.markup_percent);
    if v_price is not null then
      update articles set unit_price = v_price where id = r.id and unit_price <> v_price;
      if found then v_count := v_count + 1; end if;
    end if;
  end loop;

  return v_count;
end;
$$;


-- ===== 7) Importación de una lista de precios de compra.
-- Recibe las filas del Excel ya parseadas en el navegador.
-- Las que coinciden por (proveedor, código) actualizan el precio; las demás
-- quedan en unmatched_supplier_prices para vincularlas a mano después.
-- Todo en una transacción: si algo falla, no queda una importación a medias.
create or replace function public.import_supplier_prices(
  p_supplier_id uuid,
  p_file_name text,
  p_rows jsonb
)
returns table (total_rows int, matched_rows int, unmatched_rows int, import_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_total int := 0;
  v_matched int := 0;
  v_unmatched int := 0;
  v_import_id uuid;
  r record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if not exists (select 1 from suppliers where id = p_supplier_id) then
    raise exception 'El proveedor indicado no existe.';
  end if;

  for r in
    select
      trim(item->>'code') as code,
      nullif(trim(coalesce(item->>'description', '')), '') as description,
      (item->>'price')::numeric as price
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as item
    where trim(coalesce(item->>'code', '')) <> ''
  loop
    v_total := v_total + 1;

    update article_suppliers
       set purchase_price = r.price,
           supplier_description = coalesce(r.description, supplier_description)
     where supplier_id = p_supplier_id
       and upper(supplier_code) = upper(r.code);

    if found then
      v_matched := v_matched + 1;
    else
      insert into unmatched_supplier_prices (supplier_id, supplier_code, description, purchase_price)
      values (p_supplier_id, r.code, r.description, r.price)
      on conflict (supplier_id, supplier_code) do update
        set description = coalesce(excluded.description, unmatched_supplier_prices.description),
            purchase_price = excluded.purchase_price,
            imported_at = now();
      v_unmatched := v_unmatched + 1;
    end if;
  end loop;

  insert into price_imports (supplier_id, file_name, total_rows, matched_rows, unmatched_rows)
  values (p_supplier_id, p_file_name, v_total, v_matched, v_unmatched)
  returning id into v_import_id;

  return query select v_total, v_matched, v_unmatched, v_import_id;
end;
$$;


-- ===== 8) Vincular una fila pendiente a un artículo nuestro.
-- Crea (o actualiza) el vínculo con el código y precio del proveedor y quita la
-- fila de pendientes. Si el artículo no tenía proveedor preferido, éste lo pasa
-- a ser, para que el precio de venta pueda calcularse.
create or replace function public.link_unmatched_price(
  p_unmatched_id uuid,
  p_article_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_row unmatched_supplier_prices%rowtype;
  v_has_preferred boolean;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_row from unmatched_supplier_prices where id = p_unmatched_id for update;
  if not found then
    raise exception 'La fila pendiente no existe o ya fue vinculada.';
  end if;

  select exists (
    select 1 from article_suppliers where article_id = p_article_id and is_preferred
  ) into v_has_preferred;

  insert into article_suppliers (article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred)
  values (p_article_id, v_row.supplier_id, v_row.supplier_code, v_row.description, v_row.purchase_price, not v_has_preferred)
  on conflict (article_id, supplier_id) do update
    set supplier_code = excluded.supplier_code,
        supplier_description = coalesce(excluded.supplier_description, article_suppliers.supplier_description),
        purchase_price = excluded.purchase_price;

  delete from unmatched_supplier_prices where id = p_unmatched_id;
end;
$$;
