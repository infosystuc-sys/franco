-- DieselPro ERP — listas de precios de compra y venta
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (vía MCP, migraciones
-- price_lists_purchase_and_sale y price_calculation_and_import_functions).
-- Este archivo y price-lists-functions.sql quedan como registro del esquema;
-- volver a ejecutarlos dará errores de "already exists".
--
-- Orden en una base vacía: schema.sql → auth.sql → articles.sql →
--   quotations.sql → price-lists.sql → price-lists-functions.sql
--
-- Modelo:
--   COMPRA: article_suppliers guarda, por cada par artículo↔proveedor, el
--     código propio del proveedor y su precio. Un artículo puede tener varios
--     proveedores; uno de ellos se marca como preferido.
--   VENTA: articles.unit_price se calcula como
--     precio de compra del proveedor preferido × (1 + utilidad%)
--     La utilidad sale de articles.markup_percent, o del valor global
--     app_settings.default_markup_percent si el artículo no tiene el suyo.
--   Los precios son NETOS (sin IVA); el IVA se suma al total de la OT/cotización.

-- ===== 1) Configuración global del taller (clave/valor)
create table app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value) values ('default_markup_percent', '40');

alter table app_settings enable row level security;
create policy "read all" on app_settings for select using (true);
create policy "admin update" on app_settings for update using (is_admin()) with check (is_admin());
create policy "admin insert" on app_settings for insert with check (is_admin());


-- ===== 2) Utilidad por artículo. NULL = usa el porcentaje global.
alter table articles
  add column markup_percent numeric check (markup_percent is null or markup_percent >= 0);

comment on column articles.unit_price is
  'Precio de VENTA (neto, sin IVA). Se calcula como precio de compra del proveedor preferido + utilidad.';


-- ===== 3) Lista de precios de COMPRA: un artículo puede tener varios
-- proveedores, cada uno con su propio código y precio.
create table article_suppliers (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  -- Código con el que el proveedor identifica el artículo. Es la clave que
  -- permite reconocer las filas al importar su Excel.
  supplier_code text not null,
  supplier_description text,
  purchase_price numeric not null default 0 check (purchase_price >= 0),
  -- El precio de venta se calcula sobre el proveedor preferido.
  is_preferred boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (article_id, supplier_id)
);

-- El par (proveedor, código) identifica unívocamente una fila del Excel.
create unique index article_suppliers_supplier_code_key
  on article_suppliers (supplier_id, upper(supplier_code));

-- Un solo proveedor preferido por artículo.
create unique index article_suppliers_one_preferred
  on article_suppliers (article_id) where is_preferred;

create index article_suppliers_article_idx on article_suppliers (article_id);

create trigger article_suppliers_set_updated_at
before update on article_suppliers
for each row execute function set_updated_at();


-- ===== 4) Migrar el proveedor único que ya tenía cada artículo.
-- El código del proveedor se inicializa con nuestro propio código (hay que
-- corregirlo con el código real al importar su lista) y el precio de compra
-- con el precio de venta actual + utilidad 0%, de modo que NINGÚN precio de
-- venta cambie por esta migración.
insert into article_suppliers (article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred)
select a.id, a.supplier_id, a.code, a.description, a.unit_price, true
from articles a
where a.supplier_id is not null;

update articles set markup_percent = 0
where id in (select article_id from article_suppliers);

alter table articles drop column supplier_id;


-- ===== 5) Filas de Excel cuyo código todavía no está vinculado a un artículo.
create table unmatched_supplier_prices (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete cascade,
  supplier_code text not null,
  description text,
  purchase_price numeric not null default 0,
  imported_at timestamptz not null default now(),
  unique (supplier_id, supplier_code)
);

create index unmatched_supplier_idx on unmatched_supplier_prices (supplier_id);


-- ===== 6) Historial de importaciones
create table price_imports (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete cascade,
  file_name text,
  total_rows int not null default 0,
  matched_rows int not null default 0,
  unmatched_rows int not null default 0,
  imported_at timestamptz not null default now()
);

create index price_imports_supplier_idx on price_imports (supplier_id, imported_at desc);


-- ===== 7) RLS de las tablas nuevas: lectura abierta, escritura solo admin.
alter table article_suppliers enable row level security;
alter table unmatched_supplier_prices enable row level security;
alter table price_imports enable row level security;

create policy "read all" on article_suppliers for select using (true);
create policy "admin insert" on article_suppliers for insert with check (is_admin());
create policy "admin update" on article_suppliers for update using (is_admin()) with check (is_admin());
create policy "admin delete" on article_suppliers for delete using (is_admin());

create policy "read all" on unmatched_supplier_prices for select using (true);
create policy "admin insert" on unmatched_supplier_prices for insert with check (is_admin());
create policy "admin update" on unmatched_supplier_prices for update using (is_admin()) with check (is_admin());
create policy "admin delete" on unmatched_supplier_prices for delete using (is_admin());

create policy "read all" on price_imports for select using (true);
create policy "admin insert" on price_imports for insert with check (is_admin());
create policy "admin delete" on price_imports for delete using (is_admin());
