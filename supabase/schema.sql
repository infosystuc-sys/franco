-- DieselPro ERP — schema inicial
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel". Este archivo queda como
-- registro del esquema; volver a ejecutarlo dará "relation already exists".
-- Solo es necesario si algún día se levanta el proyecto desde cero.
--
-- Orden de ejecución en una base vacía: schema.sql → auth.sql → articles.sql
-- (ojo: articles.sql reemplaza las políticas RLS abiertas de este archivo).

create extension if not exists pgcrypto;

create type work_order_status as enum (
  'COTIZACION_ENVIADA',
  'AUTORIZADO',
  'EN_ESPERA_REP',
  'EN_REPARACION',
  'CALIBRACION',
  'TERMINADO'
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  model text not null,
  license_plate text,
  year int,
  created_at timestamptz not null default now()
);

create table technicians (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text,
  avatar_url text
);

create table work_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  status work_order_status not null default 'COTIZACION_ENVIADA',
  customer_id uuid not null references customers(id),
  vehicle_id uuid not null references vehicles(id),
  technician_id uuid references technicians(id),
  component text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table work_order_items (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete cascade,
  code text,
  description text not null,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  subtotal numeric not null default 0
);

-- Mantener updated_at al dia en cada UPDATE de work_orders
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger work_orders_set_updated_at
before update on work_orders
for each row execute function set_updated_at();

-- RLS: sin login todavia, se deja acceso abierto vía anon key.
-- IMPORTANTE: antes de llevar esto a producción real, restringir estas
-- políticas (por ejemplo, exigiendo autenticación) para que no cualquiera
-- pueda leer/escribir órdenes desde la API pública de Supabase.
alter table customers enable row level security;
alter table vehicles enable row level security;
alter table technicians enable row level security;
alter table work_orders enable row level security;
alter table work_order_items enable row level security;

create policy "public full access" on customers for all using (true) with check (true);
create policy "public full access" on vehicles for all using (true) with check (true);
create policy "public full access" on technicians for all using (true) with check (true);
create policy "public full access" on work_orders for all using (true) with check (true);
create policy "public full access" on work_order_items for all using (true) with check (true);

-- Datos de muestra (los mismos que hoy están hardcodeados en la UI)
insert into customers (id, name, email, phone) values
  ('11111111-1111-1111-1111-111111111111', 'Transportes G&M', 'contacto@transportesgm.com', '+54 9 11 5555-0001'),
  ('22222222-2222-2222-2222-222222222222', 'Constructora Andina', 'contacto@construandina.com', '+54 9 11 5555-0002'),
  ('33333333-3333-3333-3333-333333333333', 'Logística Express', 'contacto@logexpress.com', '+54 9 11 5555-0003'),
  ('44444444-4444-4444-4444-444444444444', 'Agrícola del Sur', 'contacto@agricoladelsur.com', '+54 9 11 5555-0004');

insert into vehicles (id, customer_id, model, license_plate, year) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Volvo FH16', 'ABC-123', 2019),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Excavadora CAT 320', null, 2017),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'Scania R450', 'XYZ-987', 2020),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'Tractor John Deere 8R', null, 2018);

insert into technicians (id, name, role) values
  ('99999999-9999-9999-9999-999999999999', 'Carlos Méndez', 'Técnico Senior');

insert into work_orders (id, number, status, customer_id, vehicle_id, technician_id, component) values
  ('a0000000-0000-0000-0000-000000000001', 'OT-4092', 'AUTORIZADO', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '99999999-9999-9999-9999-999999999999', 'Bomba de Inyección Common Rail'),
  ('a0000000-0000-0000-0000-000000000002', 'OT-4091', 'EN_REPARACION', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '99999999-9999-9999-9999-999999999999', 'Bomba Hidráulica'),
  ('a0000000-0000-0000-0000-000000000003', 'OT-4088', 'EN_ESPERA_REP', '33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '99999999-9999-9999-9999-999999999999', 'Inyectores Common Rail'),
  ('a0000000-0000-0000-0000-000000000004', 'OT-4085', 'EN_REPARACION', '44444444-4444-4444-4444-444444444444', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '99999999-9999-9999-9999-999999999999', 'Bomba de Inyección Rotativa');

insert into work_order_items (work_order_id, code, description, quantity, unit_price, subtotal) values
  ('a0000000-0000-0000-0000-000000000001', 'BOS-093', 'Tobera Inyector Common Rail', 4.0, 125.0, 500.0),
  ('a0000000-0000-0000-0000-000000000001', 'DEL-442', 'Válvula de Control Delphi', 4.0, 85.5, 342.0),
  ('a0000000-0000-0000-0000-000000000001', 'MO-001', 'Mano de Obra - Desarme y Limpieza', 1.0, 150.0, 150.0),
  ('a0000000-0000-0000-0000-000000000001', 'CAL-002', 'Calibración Banco Prueba EPS205', 4.0, 45.0, 180.0);
