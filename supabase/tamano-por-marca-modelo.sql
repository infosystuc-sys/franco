-- ===========================================================================
-- Tamaño del vehículo, recordado por marca y modelo
-- ===========================================================================
-- Migración: tamano_por_marca_modelo
--
-- Elegir "Grande" o "Mediano" para un Volvo FH16 750 es la misma respuesta
-- cada vez que entra un Volvo FH16 750: el tamaño lo define el modelo, no el
-- vehículo en particular. Antes había que elegirlo a mano en cada ingreso.
--
-- Se guarda en vehicle_models, que ya junta marca y modelo. La primera vez
-- que alguien elige un tamaño para una combinación sin tamaño registrado,
-- queda grabado; ingresos siguientes del mismo modelo lo traen solo. No se
-- pisa después: mismo criterio que ya usa esta tabla para marca y modelo
-- (on conflict do nothing) — una elección puntual rara no debe correr el
-- valor de referencia de todos los demás ingresos de ese modelo.

alter table public.vehicle_models
  add column if not exists size_class text check (size_class in ('MEDIANO', 'GRANDE'));

-- Los ya cargados también se aprovechan: si todos los vehículos existentes de
-- un modelo coinciden en el tamaño, se lo hereda al catálogo. Si hay
-- vehículos del mismo modelo con tamaños distintos, se deja sin decidir: es
-- mejor esperar una elección más que arrancar sugiriendo un valor que ya se
-- sabe que no vale para todos los casos.
with tamanos_por_modelo as (
  select b.id as brand_id,
         lower(trim(v.model)) as modelo_normalizado,
         min(v.size_class) as un_tamano,
         count(distinct v.size_class) as variantes
  from public.vehicles v
  join public.vehicle_brands b on lower(b.name) = lower(trim(v.brand))
  where v.kind = 'VEHICULO'
    and coalesce(trim(v.brand), '') <> ''
    and coalesce(trim(v.model), '') <> ''
  group by b.id, lower(trim(v.model))
)
update public.vehicle_models vm
set size_class = t.un_tamano
from tamanos_por_modelo t
where vm.brand_id = t.brand_id
  and lower(vm.name) = t.modelo_normalizado
  and vm.size_class is null
  and t.variantes = 1;

-- El nuevo parámetro cambia la firma: la versión de dos argumentos queda
-- reemplazada, no superpuesta, para no dejar dos funciones haciendo casi lo
-- mismo.
drop function if exists public.registrar_marca_modelo(text, text);

create or replace function public.registrar_marca_modelo(
  p_marca text,
  p_modelo text,
  p_tamano text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_marca text := nullif(trim(p_marca), '');
  v_modelo text := nullif(trim(p_modelo), '');
  -- Cualquier valor que no sea uno de los dos tamaños válidos se ignora en
  -- vez de rechazar el llamado entero: esto corre después de guardar el
  -- vehículo, y una pieza (sin tamaño real) manda null sin problema.
  v_tamano text := nullif(p_tamano, '');
  v_brand_id uuid;
  v_model_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if v_marca is null then
    return;
  end if;
  if v_tamano is not null and v_tamano not in ('MEDIANO', 'GRANDE') then
    v_tamano := null;
  end if;

  select id into v_brand_id from vehicle_brands where lower(name) = lower(v_marca);
  if v_brand_id is null then
    insert into vehicle_brands (name) values (v_marca) returning id into v_brand_id;
  end if;

  if v_modelo is null then
    return;
  end if;

  select id into v_model_id
  from vehicle_models
  where brand_id = v_brand_id and lower(name) = lower(v_modelo);

  if v_model_id is null then
    insert into vehicle_models (brand_id, name, size_class)
    values (v_brand_id, v_modelo, v_tamano)
    on conflict do nothing;
  elsif v_tamano is not null then
    -- Solo si todavía no tiene uno registrado: es la primera vez que se
    -- graba para este modelo, no una corrección de lo que ya había.
    update vehicle_models
    set size_class = v_tamano
    where id = v_model_id and size_class is null;
  end if;
end;
$$;

grant execute on function public.registrar_marca_modelo(text, text, text) to authenticated;
