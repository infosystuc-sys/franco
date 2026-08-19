-- DieselPro ERP — seguimiento público por token y cierre de la lectura anónima
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (migración
-- public_tracking_token_and_lockdown). Queda como registro del esquema.
--
-- POR QUÉ
-- El portal del cliente entraba por /seguimiento/OT-5002. Los números de OT
-- son correlativos, así que probando OT-5001 se veía la orden de otro cliente.
-- Además, para que ese portal funcionara sin login, la lectura de las tablas
-- estaba abierta a todo el mundo — y la clave anónima viaja dentro del código
-- que descarga el navegador. Cualquiera podía listar clientes con su CUIT,
-- todas las órdenes y los precios de compra.
--
-- CÓMO QUEDA
-- 1. Cada orden tiene un token aleatorio; el link va con el token.
-- 2. Leer las tablas requiere sesión iniciada.
-- 3. El portal no consulta tablas: llama a dos funciones que reciben el token
--    y devuelven solo lo que el cliente puede ver de esa orden.

-- ===== 1) Token público por orden
alter table work_orders
  add column public_token uuid not null default gen_random_uuid();

create unique index work_orders_public_token_key on work_orders (public_token);


-- ===== 2) Cerrar la lectura anónima
drop policy "read all" on customers;
drop policy "read all" on vehicles;
drop policy "read all" on technicians;
drop policy "read all" on work_orders;
drop policy "read all" on work_order_items;
drop policy "read all" on work_order_status_history;
drop policy "read all" on quotations;
drop policy "read all" on quotation_items;
drop policy "read all" on articles;
drop policy "read all" on article_suppliers;
drop policy "read all" on suppliers;
drop policy "read all" on unmatched_supplier_prices;
drop policy "read all" on price_imports;
drop policy "read all" on app_settings;

create policy "authenticated read" on customers for select to authenticated using (true);
create policy "authenticated read" on vehicles for select to authenticated using (true);
create policy "authenticated read" on technicians for select to authenticated using (true);
create policy "authenticated read" on work_orders for select to authenticated using (true);
create policy "authenticated read" on work_order_items for select to authenticated using (true);
create policy "authenticated read" on work_order_status_history for select to authenticated using (true);
create policy "authenticated read" on quotations for select to authenticated using (true);
create policy "authenticated read" on quotation_items for select to authenticated using (true);
create policy "authenticated read" on articles for select to authenticated using (true);
create policy "authenticated read" on article_suppliers for select to authenticated using (true);
create policy "authenticated read" on suppliers for select to authenticated using (true);
create policy "authenticated read" on unmatched_supplier_prices for select to authenticated using (true);
create policy "authenticated read" on price_imports for select to authenticated using (true);
create policy "authenticated read" on app_settings for select to authenticated using (true);


-- ===== 3) Única puerta pública
-- SECURITY DEFINER para saltear RLS de forma controlada: devuelve exactamente
-- los campos que el cliente necesita. No expone CUIT, teléfono, importes ni
-- precios de compra, aunque el token sea correcto.
create or replace function public.get_public_work_order(p_token uuid)
returns table (
  number text,
  status work_order_status,
  component text,
  vehicle_brand text,
  vehicle_model text,
  license_plate text,
  vehicle_type text,
  vehicle_year int,
  engine_brand text,
  engine_model text,
  injection_system text,
  technician_name text,
  customer_name text
)
language sql
security definer
stable
set search_path = public
as $$
  select
    wo.number, wo.status, wo.component,
    v.brand, v.model, v.license_plate, v.vehicle_type, v.year,
    v.engine_brand, v.engine_model, v.injection_system,
    t.name, c.name
  from work_orders wo
  left join vehicles v on v.id = wo.vehicle_id
  left join technicians t on t.id = wo.technician_id
  left join customers c on c.id = wo.customer_id
  where wo.public_token = p_token;
$$;

create or replace function public.get_public_status_history(p_token uuid)
returns table (
  to_status work_order_status,
  changed_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select h.to_status, h.changed_at
  from work_order_status_history h
  join work_orders wo on wo.id = h.work_order_id
  where wo.public_token = p_token
  order by h.changed_at;
$$;

-- Cualquiera puede llamarlas: sin el token correcto no devuelven nada.
grant execute on function public.get_public_work_order(uuid) to anon, authenticated;
grant execute on function public.get_public_status_history(uuid) to anon, authenticated;
