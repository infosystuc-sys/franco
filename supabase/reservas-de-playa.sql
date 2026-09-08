-- ===========================================================================
-- Reservas de celda
-- ===========================================================================
-- Migración: reservas_de_playa
--
-- El cliente llama y avisa que el martes trae el camión. Hasta ahora eso no
-- existía en ningún lado: la playa solo contaba lo que YA estaba adentro, así
-- que se comprometían lugares que después no había.
--
-- Una reserva ocupa celda igual que un vehículo presente —esa es la idea— pero
-- se muestra aparte y con otro color, porque no es lo mismo tener el camión que
-- esperarlo.
--
-- La patente va como texto y no como referencia a vehicles: el cliente reserva
-- por teléfono para un camión que a veces nunca vino al taller, y obligar a
-- cargar la ficha completa en ese momento haría que la reserva no se cargue.
-- vehicle_id queda para cuando la ficha sí existe.

create table public.yard_reservations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  -- Opcional: se completa cuando la patente coincide con una ficha ya cargada.
  vehicle_id uuid references public.vehicles(id) on delete set null,
  license_plate text not null,
  -- El tamaño se guarda en la reserva y no se lee de la ficha: puede no haber
  -- ficha todavía, y de eso depende cuánta celda se está comprometiendo.
  size_class text not null check (size_class in ('MEDIANO', 'GRANDE')),
  starts_on date not null,
  ends_on date not null,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),

  -- Una reserva que termina antes de empezar no reserva nada y descuadraría
  -- la cuenta de todos los días del medio.
  constraint yard_reservations_rango_valido check (ends_on >= starts_on)
);

create index yard_reservations_rango_idx on public.yard_reservations(starts_on, ends_on);

alter table public.yard_reservations enable row level security;

-- La disponibilidad del taller es pantalla de admin, igual que el cupo.
create policy "solo admin" on public.yard_reservations for select using (is_admin());
create policy "admin insert" on public.yard_reservations for insert with check (is_admin());
create policy "admin update" on public.yard_reservations for update using (is_admin());
create policy "admin delete" on public.yard_reservations for delete using (is_admin());
