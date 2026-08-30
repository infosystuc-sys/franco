-- ===========================================================================
-- Cashflow de espacio: cupos por sector + fecha estimada de entrega
-- ===========================================================================
-- Migración: shop_space_capacity
--
-- Modela la capacidad del taller como un cupo simple por sector (Laboratorio
-- 1, Laboratorio 2, Playa — los mismos valores que ya usa employees.workplace,
-- sin convertirlos en un ABM propio porque ya son un conjunto fijo en el
-- código). El admin configura cuántos vehículos entran a la vez en cada uno.
--
-- La ocupación de un sector, en cualquier momento, es la cantidad de OT
-- activas (no terminales) cuyo empleado asignado tiene ese workplace — no
-- hace falta una tabla de ocupación propia, sale de work_orders + employees.
--
-- estimated_delivery_date es un dato que carga el admin a mano (no hay
-- forma de inferirlo con precisión razonable por vehículo); sin ese dato la
-- vista de disponibilidad no puede proyectar cuándo se libera el lugar, pero
-- el conteo de ocupación actual sigue funcionando igual.

create table public.workplace_capacity (
  workplace text primary key,
  capacity integer not null default 1,
  updated_at timestamptz not null default now()
);

create trigger workplace_capacity_set_updated_at
before update on public.workplace_capacity
for each row execute function set_updated_at();

alter table public.workplace_capacity enable row level security;

create policy "solo admin" on public.workplace_capacity for select using (is_admin());
create policy "admin insert" on public.workplace_capacity for insert with check (is_admin());
create policy "admin update" on public.workplace_capacity for update using (is_admin()) with check (is_admin());

insert into public.workplace_capacity (workplace, capacity) values
  ('Laboratorio 1', 1),
  ('Laboratorio 2', 1),
  ('Playa', 1);

alter table public.work_orders add column estimated_delivery_date date;
