-- ===========================================================================
-- Renglones de piezas recibidas
-- ===========================================================================
-- Migración: renglones_de_piezas
--
-- Una pieza se cargaba como una ficha suelta: una marca, un modelo, un número
-- de referencia. Pero al mostrador no llega "una pieza", llega un juego: seis
-- inyectores Bosch y además la bomba. Cada tipo tiene su propia referencia, y
-- meterlos en una sola ficha obligaba a cargar un ingreso por cada tipo, o a
-- perder la referencia de todos menos uno.
--
-- Ahora el ingreso de piezas es una ficha con renglones. La ficha sigue siendo
-- la fila de `vehicles` (kind = 'PIEZA') porque es a ella a la que apunta la
-- orden de trabajo; los renglones cuelgan de ella.
--
-- vehicles.brand/model/reference_number se siguen completando con los datos
-- del PRIMER renglón. No es duplicación por descuido: es lo que leen el
-- listado de vehículos, el selector de la OT, las cotizaciones y los remitos
-- para rotular el equipo. Sin eso, un ingreso de piezas aparecería en blanco
-- en media app.

-- ── Tipos de pieza ────────────────────────────────────────────────────────
-- Mismo criterio que marcas y modelos: se escribe y queda para la próxima. Un
-- catálogo cerrado se desactualiza el día que entra algo que nadie previó, y
-- el que está recibiendo no puede parar a pedir un alta.
create table public.vehicle_part_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create unique index vehicle_part_types_name_idx
  on public.vehicle_part_types (lower(name));

-- Los habituales del taller, para que la lista no arranque vacía.
insert into public.vehicle_part_types (name) values
  ('Inyector'),
  ('Bomba inyectora'),
  ('Common rail'),
  ('Turbo'),
  ('Porta inyector'),
  ('Bomba de alta presión')
on conflict do nothing;

-- ── Renglones ─────────────────────────────────────────────────────────────
create table public.vehicle_parts (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  part_type text not null,
  brand text,
  model text,
  reference_number text,
  -- Cantidad recibida. Se controla acá y no solo en pantalla porque de este
  -- número depende lo que después se devuelve al cliente.
  quantity integer not null default 1 check (quantity > 0),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index vehicle_parts_vehicle_idx on public.vehicle_parts (vehicle_id, position);

alter table public.vehicle_part_types enable row level security;
alter table public.vehicle_parts enable row level security;

-- Lee cualquiera con sesión: el operario necesita ver qué le dejaron.
create policy "lectura autenticada" on public.vehicle_part_types for select to authenticated using (true);
create policy "lectura autenticada" on public.vehicle_parts for select to authenticated using (true);
create policy "admin escribe" on public.vehicle_part_types for insert to authenticated with check (is_admin());
create policy "admin escribe" on public.vehicle_parts for insert to authenticated with check (is_admin());
create policy "admin actualiza" on public.vehicle_part_types for update to authenticated using (is_admin());
create policy "admin actualiza" on public.vehicle_parts for update to authenticated using (is_admin());
create policy "admin borra" on public.vehicle_parts for delete to authenticated using (is_admin());

-- ── Registrar un tipo nuevo al guardar ────────────────────────────────────
-- Del lado del servidor por lo mismo que las marcas: dos altas simultáneas del
-- mismo tipo chocan contra el índice único, y el error que llega al navegador
-- no le dice nada a quien está recibiendo.
create or replace function public.registrar_tipo_de_pieza(p_tipo text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo text := nullif(trim(p_tipo), '');
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if v_tipo is null then
    return;
  end if;

  insert into vehicle_part_types (name) values (v_tipo) on conflict do nothing;
end;
$$;

grant execute on function public.registrar_tipo_de_pieza(text) to authenticated;

-- ── Traer las piezas ya cargadas ──────────────────────────────────────────
-- Las fichas de pieza que existen hoy pasan a tener su primer renglón, para
-- que no queden como ingresos sin nada adentro. El tipo sale de si venía
-- marcada con inyectores; si no, queda el genérico.
insert into public.vehicle_parts (vehicle_id, part_type, brand, model, reference_number, quantity, position)
select
  v.id,
  case when coalesce(v.has_injectors, false) then 'Inyector' else 'Pieza' end,
  v.brand,
  v.model,
  v.reference_number,
  greatest(coalesce(v.injector_count, 1), 1),
  0
from public.vehicles v
where v.kind = 'PIEZA';

insert into public.vehicle_part_types (name)
select distinct part_type from public.vehicle_parts
on conflict do nothing;
