-- ===========================================================================
-- El ingreso distingue vehículos de piezas, y guarda fotos
-- ===========================================================================
-- Migración: ingreso_piezas_y_fotos
--
-- Al taller no siempre entra un vehículo: muchas veces llega la bomba sola,
-- sobre el mostrador. Hasta ahora eso se anotaba a mano en cada orden y no
-- quedaba ficha reutilizable de la pieza.
--
-- La pieza vive en la misma tabla que el vehículo, marcada con kind. Es lo que
-- permite que la orden de trabajo la elija igual que elegía un vehículo, sin
-- inventarle un segundo vínculo. El precio de esa decisión es que hay que
-- filtrar por kind donde se listan vehículos: una pieza cargada como vehículo
-- ocuparía celda en la playa sin estar ocupando nada.

alter table public.vehicles
  add column kind text not null default 'VEHICULO'
    check (kind in ('VEHICULO', 'PIEZA')),
  -- Con qué se identifica la pieza. La patente cumple ese papel en el
  -- vehículo; en una bomba o un inyector, el número de referencia.
  add column reference_number text,
  -- Solo tienen sentido en una pieza. Nulos en un vehículo: no es "no trae
  -- inyectores", es que la pregunta no aplica.
  add column has_injectors boolean,
  add column injector_count integer check (injector_count is null or injector_count >= 0);

comment on column public.vehicles.kind is
  'VEHICULO o PIEZA. Una pieza no ocupa lugar en la playa y no tiene patente '
  'ni tamaño: se identifica por su número de referencia.';

create index vehicles_kind_idx on public.vehicles(kind);

-- ===========================================================================
-- Fotos de la ficha
-- ===========================================================================
-- Van pegadas al equipo, no a la orden: sirven para el estado con que llegó y
-- para reconocerlo la próxima vez que entre, aunque sea por otra orden.
--
-- La lectura es de cualquiera con sesión, igual que la propia tabla vehicles:
-- el operario que atiende la orden necesita ver con qué llegó el equipo.
create table public.vehicle_photos (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index vehicle_photos_vehicle_id_idx on public.vehicle_photos(vehicle_id);

alter table public.vehicle_photos enable row level security;

create policy "lectura autenticada" on public.vehicle_photos for select
  to authenticated using (true);
create policy "admin insert" on public.vehicle_photos for insert with check (is_admin());
create policy "admin delete" on public.vehicle_photos for delete using (is_admin());

-- Bucket privado y URL firmada, nunca pública: mismo criterio que las fotos de
-- la orden. El archivo va como "<vehicle_id>/<uuid>.<ext>" para que la
-- política mire el primer segmento del path sin depender de esta tabla.
insert into storage.buckets (id, name, public)
values ('vehicle-photos', 'vehicle-photos', false);

create policy "lectura autenticada vehicle photos" on storage.objects for select
  to authenticated using (bucket_id = 'vehicle-photos');
create policy "admin upload vehicle photos" on storage.objects for insert
  with check (bucket_id = 'vehicle-photos' and is_admin());
create policy "admin delete vehicle photos" on storage.objects for delete
  using (bucket_id = 'vehicle-photos' and is_admin());
