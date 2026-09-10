-- ===========================================================================
-- Secuencia de los estados de OT
-- ===========================================================================
-- Migración: orden_de_estados_ot
--
-- Los estados se ordenaban intercambiando sort_order de a pares, con dos
-- updates desde el navegador. Eso alcanza para subir uno un lugar, pero deja
-- dos problemas: un estado nuevo siempre nace último —aunque su lugar sea el
-- tercero— y si el segundo update falla, quedan dos estados con el mismo
-- número y el orden pasa a depender de cuál lea primero Postgres.
--
-- Esta función recibe la secuencia entera y la reescribe 1..N en una sola
-- transacción. El navegador dice cómo quiere que quede la lista; el orden
-- contiguo y sin repetidos lo garantiza la base.

create or replace function public.ordenar_estados_ot(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  -- La lista tiene que ser TODOS los estados, sin faltantes ni repetidos. Con
  -- una lista parcial, los que no vinieran conservarían su número viejo y se
  -- mezclarían con los nuevos en cualquier posición.
  select count(*) into v_total from work_order_statuses;

  if array_length(p_ids, 1) is distinct from v_total then
    raise exception 'La secuencia tiene % estados y existen %.', coalesce(array_length(p_ids, 1), 0), v_total;
  end if;

  if exists (
    select 1 from unnest(p_ids) as id group by id having count(*) > 1
  ) then
    raise exception 'La secuencia trae estados repetidos.';
  end if;

  if exists (
    select 1 from work_order_statuses s
    where not (s.id = any(p_ids))
  ) then
    raise exception 'La secuencia no incluye todos los estados.';
  end if;

  update work_order_statuses s
  set sort_order = nuevo.posicion
  from (
    select id, row_number() over () as posicion
    from unnest(p_ids) as id
  ) as nuevo
  where s.id = nuevo.id
    and s.sort_order is distinct from nuevo.posicion;
end;
$$;

grant execute on function public.ordenar_estados_ot(uuid[]) to authenticated;

-- Deja la numeración contigua de entrada: si quedó algún hueco o repetido de
-- los intercambios viejos, se normaliza ahora y no al primer reordenamiento.
update public.work_order_statuses s
set sort_order = ordenado.posicion
from (
  select id, row_number() over (order by sort_order, created_at) as posicion
  from public.work_order_statuses
) as ordenado
where s.id = ordenado.id
  and s.sort_order is distinct from ordenado.posicion;
