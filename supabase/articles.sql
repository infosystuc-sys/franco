-- DieselPro ERP — catálogo de artículos con control de stock opcional
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (vía MCP, migraciones
-- articles_catalog_with_optional_stock y replace_work_order_items_rpc).
-- Este archivo queda como registro/documentación del esquema. NO hace falta
-- volver a ejecutarlo: dará "relation already exists".
-- Solo es necesario si algún día se levanta el proyecto desde cero.
--
-- Orden de ejecución en una base vacía: schema.sql → auth.sql → articles.sql

-- 1) Catálogo de artículos.
-- tracks_stock decide, por artículo, si se controla stock. Los que no lo
-- controlan (ej. mano de obra, servicios) ignoran stock_quantity.
create table articles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null,
  unit_price numeric not null default 0 check (unit_price >= 0),
  tracks_stock boolean not null default false,
  stock_quantity numeric not null default 0 check (stock_quantity >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2) Los renglones de OT pueden referenciar un artículo del catálogo.
-- Se mantiene nullable: las líneas manuales (sin artículo) siguen siendo válidas.
alter table work_order_items
  add column article_id uuid references articles(id) on delete restrict;

-- 3) Ajuste automático de stock.
-- delta positivo repone, negativo consume. Se ejecuta con SECURITY DEFINER
-- para que el ajuste no dependa de las políticas RLS de articles.
create or replace function public.adjust_article_stock(p_article_id uuid, p_delta numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tracks boolean;
  v_stock numeric;
  v_code text;
begin
  if p_article_id is null or p_delta = 0 then
    return;
  end if;

  select tracks_stock, stock_quantity, code
    into v_tracks, v_stock, v_code
    from articles
   where id = p_article_id
     for update;

  if not found or not v_tracks then
    return;
  end if;

  if v_stock + p_delta < 0 then
    raise exception 'Stock insuficiente para el artículo % (disponible: %, solicitado: %)',
      v_code, v_stock, abs(p_delta);
  end if;

  update articles set stock_quantity = stock_quantity + p_delta where id = p_article_id;
end;
$$;

create or replace function public.work_order_items_stock_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform adjust_article_stock(new.article_id, -new.quantity);
    return new;

  elsif tg_op = 'DELETE' then
    perform adjust_article_stock(old.article_id, old.quantity);
    return old;

  else -- UPDATE
    if old.article_id is distinct from new.article_id then
      -- cambió de artículo: repone el viejo, consume del nuevo
      perform adjust_article_stock(old.article_id, old.quantity);
      perform adjust_article_stock(new.article_id, -new.quantity);
    elsif old.quantity is distinct from new.quantity then
      perform adjust_article_stock(new.article_id, old.quantity - new.quantity);
    end if;
    return new;
  end if;
end;
$$;

create trigger work_order_items_stock
after insert or update or delete on work_order_items
for each row execute function public.work_order_items_stock_sync();

-- 4) RLS: lectura abierta (igual que el resto), escritura solo admin.
alter table articles enable row level security;

create policy "read all" on articles for select using (true);
create policy "admin insert" on articles for insert with check (is_admin());
create policy "admin update" on articles for update using (is_admin()) with check (is_admin());
create policy "admin delete" on articles for delete using (is_admin());

-- 5) Guardado atómico de renglones.
-- La app reemplaza los renglones de una OT en una sola operación: si algo
-- falla (ej. stock insuficiente), se revierte todo y la OT conserva los
-- renglones que tenía. SECURITY INVOKER: las políticas RLS siguen aplicando.
create or replace function public.replace_work_order_items(
  p_work_order_id uuid,
  p_items jsonb
)
returns void
language plpgsql
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  delete from work_order_items where work_order_id = p_work_order_id;

  insert into work_order_items (work_order_id, article_id, code, description, quantity, unit_price, subtotal)
  select
    p_work_order_id,
    nullif(item->>'article_id', '')::uuid,
    item->>'code',
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item;
end;
$$;

-- 6) Catálogo de muestra (los códigos que ya se usaban en las OT).
insert into articles (code, description, unit_price, tracks_stock, stock_quantity) values
  ('BOS-093', 'Tobera Inyector Common Rail', 125.00, true, 40),
  ('DEL-442', 'Válvula de Control Delphi', 85.50, true, 25),
  ('BOS-201', 'Kit Reparación Bomba Bosch VP44', 310.00, true, 8),
  ('FIL-010', 'Filtro de Combustible Racor', 22.00, true, 60),
  ('MO-001', 'Mano de Obra - Desarme y Limpieza', 150.00, false, 0),
  ('CAL-002', 'Calibración Banco Prueba EPS205', 45.00, false, 0);
