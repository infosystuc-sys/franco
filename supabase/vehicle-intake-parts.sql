-- ===========================================================================
-- Piezas de un ingreso de vehículo (inyectores, bombas...), por N° de serie
-- ===========================================================================
-- Migración: vehicle_intake_parts
--
-- Igual que las fotos del ingreso (vehicle_intake_photos): no hace falta
-- cargarlas al recibir el vehículo, se pueden agregar en cualquier momento
-- desde el detalle del ingreso. Cuántas y cuáles no se sabe de antemano —
-- puede no haber ninguna o haber diez— así que es una tabla aparte, no
-- columnas fijas en vehicle_intakes.

create table public.vehicle_intake_parts (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references public.vehicle_intakes(id) on delete cascade,
  name text not null,
  serial_number text not null,
  created_at timestamptz not null default now()
);

create index vehicle_intake_parts_intake_id_idx on public.vehicle_intake_parts(intake_id);

alter table public.vehicle_intake_parts enable row level security;

create policy "read all" on public.vehicle_intake_parts for select using (true);
create policy "admin insert" on public.vehicle_intake_parts for insert with check (is_admin());
create policy "admin update" on public.vehicle_intake_parts for update using (is_admin());
create policy "admin delete" on public.vehicle_intake_parts for delete using (is_admin());
