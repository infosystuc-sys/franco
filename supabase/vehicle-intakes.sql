-- DieselPro ERP — Ingreso de vehículos (paso previo a la cotización)
--
-- ⚠️ YA APLICADO en el proyecto Supabase "Ludiesel". Queda como registro
-- del esquema.
--
-- Modelo: mismo espíritu que quotations.sql (cliente, vehículo,
-- componente), más observaciones libres y fotos tomadas en el momento.
-- Numeración con secuencia nativa, igual que OT/cotizaciones: es un
-- comprobante operativo, no fiscal, no necesita poder corregirse.
--
-- Flujo: un ingreso nace PENDIENTE. Desde la pantalla se dispara "Crear
-- cotización", que arranca ya con cliente/vehículo/componente/observaciones
-- (estas últimas van al campo notes que la cotización ya tenía — no se
-- duplica el concepto). Al crearse la cotización el ingreso pasa a
-- COTIZADO y queda con quotation_id apuntando a ella.

create sequence vehicle_intake_number_seq start 1;

create type vehicle_intake_status as enum ('PENDIENTE', 'COTIZADO');

create table vehicle_intakes (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default 'ING-' || nextval('vehicle_intake_number_seq')::text,
  status vehicle_intake_status not null default 'PENDIENTE',
  customer_id uuid not null references customers(id),
  vehicle_id uuid not null references vehicles(id),
  component text,
  observations text,
  -- on delete restrict: mismo motivo que quotations.work_order_id — si se
  -- pudiera borrar la cotización, el ingreso quedaría "cotizado" con el
  -- vínculo en blanco y la pantalla volvería a ofrecer "Crear cotización",
  -- generando una segunda.
  quotation_id uuid references quotations(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger vehicle_intakes_set_updated_at
before update on vehicle_intakes
for each row execute function set_updated_at();

create table vehicle_intake_photos (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references vehicle_intakes(id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);

alter table vehicle_intakes enable row level security;
alter table vehicle_intake_photos enable row level security;

create policy "read all" on vehicle_intakes for select using (true);
create policy "admin insert" on vehicle_intakes for insert with check (is_admin());
create policy "admin update" on vehicle_intakes for update using (is_admin()) with check (is_admin());
create policy "admin delete" on vehicle_intakes for delete using (is_admin());

create policy "read all" on vehicle_intake_photos for select using (true);
create policy "admin insert" on vehicle_intake_photos for insert with check (is_admin());
create policy "admin delete" on vehicle_intake_photos for delete using (is_admin());

-- Bucket privado: las fotos son internas del taller, no públicas. Se leen
-- con URL firmada desde la sesión del admin (createSignedUrl), no con
-- getPublicUrl.
insert into storage.buckets (id, name, public) values ('vehicle-intakes', 'vehicle-intakes', false);

create policy "admin read intake photos" on storage.objects for select
  using (bucket_id = 'vehicle-intakes' and is_admin());
create policy "admin upload intake photos" on storage.objects for insert
  with check (bucket_id = 'vehicle-intakes' and is_admin());
create policy "admin delete intake photos" on storage.objects for delete
  using (bucket_id = 'vehicle-intakes' and is_admin());
