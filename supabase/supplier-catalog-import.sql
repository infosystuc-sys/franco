-- DieselPro ERP — Importación de catálogo de proveedor
--
-- Implementa docs/superpowers/specs/2026-08-26-importacion-catalogo-proveedor-design.md.
-- Se aplica directo contra Supabase (Ludiesel) vía MCP; este archivo queda
-- como registro del esquema.

-- ===========================================================================
-- Prefijo de código por proveedor
-- ===========================================================================

alter table suppliers add column code_prefix text;

alter table suppliers
  add constraint suppliers_code_prefix_length check (code_prefix is null or length(code_prefix) = 2);

-- Uppercase y trim antes de guardar: "de" y "DE" no pueden ser dos prefijos
-- distintos, porque después se usan tal cual para armar el código del artículo.
create or replace function public.normalize_supplier_code_prefix()
returns trigger
language plpgsql
as $$
begin
  new.code_prefix := nullif(upper(trim(new.code_prefix)), '');
  return new;
end;
$$;

create trigger suppliers_normalize_code_prefix
before insert or update of code_prefix on suppliers
for each row execute function public.normalize_supplier_code_prefix();

alter table suppliers add constraint suppliers_code_prefix_key unique (code_prefix);

-- ===========================================================================
-- Marca en artículos
-- ===========================================================================

alter table articles add column brand text;

-- ===========================================================================
-- Mapeo de columnas guardado por proveedor
-- ===========================================================================
-- Índices de columna 0-based (0 = columna A del Excel). Sin "fila de inicio
-- de datos": una fila de título o separadora no tiene a la vez código y
-- precio numérico válido en las columnas mapeadas, así que cae sola en el
-- mismo descarte que ya existe para esos casos.

create table supplier_import_profiles (
  supplier_id uuid primary key references suppliers(id) on delete cascade,
  code_column int not null,
  description_column int,
  brand_column int,
  price_column int not null,
  updated_at timestamptz not null default now()
);

alter table supplier_import_profiles enable row level security;
create policy "admin select" on supplier_import_profiles for select to authenticated using (is_admin());
create policy "admin insert" on supplier_import_profiles for insert to authenticated with check (is_admin());
create policy "admin update" on supplier_import_profiles for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin delete" on supplier_import_profiles for delete to authenticated using (is_admin());

-- ===========================================================================
-- Secuencia de código de artículo, por prefijo de proveedor
-- ===========================================================================

create table article_code_sequences (
  code_prefix text primary key,
  last_number int not null default 0 check (last_number >= 0)
);

alter table article_code_sequences enable row level security;
create policy "solo admin" on article_code_sequences for select to authenticated using (is_admin());
-- Sin políticas de escritura: solo la escribe import_supplier_prices, que es security definer.

-- ===========================================================================
-- Se elimina la cola manual de códigos sin vincular
-- ===========================================================================
-- Al momento de aplicar esta migración la tabla NO estaba vacía: tenía 4116
-- filas de un proveedor (Maximiliano Diesel S.R.L.), cargadas ese mismo día
-- con el flujo viejo y todavía sin vincular a mano. Se descartaron a
-- propósito, con aprobación explícita: se recuperan re-importando el mismo
-- archivo fuente a través del flujo nuevo (Task 4 de este plan), que crea
-- los artículos solo en vez de dejarlos en una cola manual.

drop function if exists public.link_unmatched_price(uuid, uuid);
drop table if exists unmatched_supplier_prices;

-- ===========================================================================
-- import_supplier_prices: alta automática en vez de cola manual
-- ===========================================================================
-- Pasa a ser security definer porque ahora escribe article_code_sequences,
-- que no tiene política de escritura (mismo motivo que invoice_sequences).
-- Sigue revisando is_admin() como primera línea, igual que antes.

create or replace function public.import_supplier_prices(p_supplier_id uuid, p_file_name text, p_rows jsonb)
returns table(total_rows int, matched_rows int, unmatched_rows int, import_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_total int := 0;
  v_matched int := 0;
  v_created int := 0;
  v_import_id uuid;
  v_prefix text;
  v_supplier_name text;
  v_markup numeric;
  r record;
  v_article_id uuid;
  v_number int;
  v_code text;
  v_description text;
  v_unit_price numeric;
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

  select coalesce((value)::numeric, 0) into v_markup
  from app_settings where key = 'default_markup_percent';

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
       and upper(supplier_code) = upper(r.code);

    if found then
      v_matched := v_matched + 1;
    else
      insert into article_code_sequences (code_prefix, last_number)
      values (v_prefix, 1)
      on conflict (code_prefix) do update
        set last_number = article_code_sequences.last_number + 1
      returning last_number into v_number;

      v_code := v_prefix || '-' || lpad(v_number::text, 8, '0');
      v_description := coalesce(r.description, 'Sin descripción — importado de ' || v_supplier_name);
      v_unit_price := round(r.price * (1 + v_markup / 100), 2);

      insert into articles (code, description, brand, unit_price, tracks_stock, stock_quantity, active)
      values (v_code, v_description, r.brand, v_unit_price, false, 0, true)
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

comment on column price_imports.unmatched_rows is
  'Antes: códigos sin vincular en la cola manual (eliminada). Ahora: artículos creados automáticamente durante la importación. Ver supplier-catalog-import.sql.';
