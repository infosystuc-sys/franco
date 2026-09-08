-- ===========================================================================
-- Catálogo de marcas y modelos de vehículos
-- ===========================================================================
-- Migración: catalogo_marcas_modelos
--
-- Marca y modelo se tipeaban libres en cada alta, así que el mismo camión
-- entraba como "volvo", "Volvo" y "VOLVO" según quién lo cargara. El catálogo
-- junta lo ya escrito y lo ofrece en la próxima carga.
--
-- vehicles.brand y vehicles.model SIGUEN siendo texto: esto es un catálogo de
-- sugerencias, no una clave foránea. Convertirlos en referencia obligaría a
-- tocar cada consulta que hoy lee marca y modelo —el rótulo del vehículo, la
-- playa, cotizaciones, facturas, remitos— sin que se note ninguna diferencia
-- en pantalla.

create table public.vehicle_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Insensible a mayúsculas: sin esto el catálogo nacería con "volvo" y "Volvo"
-- como dos marcas distintas, que es exactamente el problema que viene a
-- resolver.
create unique index vehicle_brands_name_idx on public.vehicle_brands (lower(name));

create table public.vehicle_models (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.vehicle_brands(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create unique index vehicle_models_brand_name_idx
  on public.vehicle_models (brand_id, lower(name));

alter table public.vehicle_brands enable row level security;
alter table public.vehicle_models enable row level security;

-- Lee cualquiera con sesión: las sugerencias las necesita quien carga.
create policy "lectura autenticada" on public.vehicle_brands for select to authenticated using (true);
create policy "lectura autenticada" on public.vehicle_models for select to authenticated using (true);
create policy "admin escribe" on public.vehicle_brands for insert to authenticated with check (is_admin());
create policy "admin escribe" on public.vehicle_models for insert to authenticated with check (is_admin());
create policy "admin actualiza" on public.vehicle_brands for update to authenticated using (is_admin());
create policy "admin actualiza" on public.vehicle_models for update to authenticated using (is_admin());

-- ── Sembrar con lo que ya se cargó ────────────────────────────────────────
-- Las marcas se normalizan a Mayúscula Inicial para que "volvo" y "Volvo"
-- terminen en una sola entrada prolija. Los modelos NO: initcap arruinaría
-- "FH16 750" y "8R 410", que se escriben así a propósito.
insert into public.vehicle_brands (name)
select distinct initcap(lower(trim(brand)))
from public.vehicles
where coalesce(trim(brand), '') <> ''
on conflict do nothing;

-- Un modelo cuelga de su marca, así que los vehículos sin marca cargada no
-- aportan modelo: no hay de qué colgarlo.
insert into public.vehicle_models (brand_id, name)
select b.id, min(v.model)
from public.vehicles v
join public.vehicle_brands b on lower(b.name) = lower(trim(v.brand))
where coalesce(trim(v.brand), '') <> '' and coalesce(trim(v.model), '') <> ''
group by b.id, lower(trim(v.model))
on conflict do nothing;

-- ── Registrar al guardar un vehículo ──────────────────────────────────────
-- En una sola función y del lado del servidor: hecho desde el navegador, dos
-- altas simultáneas de la misma marca chocan contra el índice único y una de
-- las dos se cae con un error que el usuario no puede entender.
create or replace function public.registrar_marca_modelo(p_marca text, p_modelo text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_marca text := nullif(trim(p_marca), '');
  v_modelo text := nullif(trim(p_modelo), '');
  v_brand_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if v_marca is null then
    return;
  end if;

  select id into v_brand_id from vehicle_brands where lower(name) = lower(v_marca);
  if v_brand_id is null then
    insert into vehicle_brands (name) values (v_marca) returning id into v_brand_id;
  end if;

  if v_modelo is not null then
    insert into vehicle_models (brand_id, name)
    values (v_brand_id, v_modelo)
    on conflict do nothing;
  end if;
end;
$$;

grant execute on function public.registrar_marca_modelo(text, text) to authenticated;
