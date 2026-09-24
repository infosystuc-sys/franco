-- ===========================================================================
-- Deshacer el último avance de una orden de trabajo
-- ===========================================================================
-- Migración sugerida: deshacer_avance_ot
--
-- Si alguien marca una etapa que no era, hoy la única salida es volver a
-- elegir la anterior. Pero eso no corrige: agrega. La línea de tiempo queda
-- con el paso equivocado, el de vuelta, y el bueno —tres casilleros donde
-- hubo uno—, y el informe de tiempos por etapa cuenta un tramo que nunca
-- existió.
--
-- Deshacer es otra cosa: el paso equivocado desaparece.
--
-- ── El problema de los disparadores ────────────────────────────────────────
-- El historial y los tramos de etapa los escriben disparadores, a propósito:
-- así ningún cambio de estado puede quedar sin registrar, venga de donde
-- venga. Pero eso es justo lo que estorba acá, porque volver atrás el estado
-- dispararía un registro nuevo.
--
-- Se resuelve con una marca de sesión que los disparadores miran. No se
-- desactivan los disparadores —eso bloquea la tabla entera y deja un rato en
-- que CUALQUIER cambio pasa sin registrar—: la marca vive en la transacción
-- que deshace y solo la ve ella.

-- ---------------------------------------------------------------------------
-- 1. Los disparadores respetan la marca
-- ---------------------------------------------------------------------------
create or replace function public.log_work_order_status_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Deshaciendo: el cambio es el borrado de un paso, no un paso nuevo.
  if coalesce(current_setting('app.deshaciendo_avance', true), '') = 'on' then
    return null;
  end if;

  if tg_op = 'INSERT' or new.status_id is distinct from old.status_id then
    insert into work_order_status_history (
      work_order_id, from_status_id, to_status_id, changed_by, changed_by_email
    )
    values (
      new.id,
      case when tg_op = 'INSERT' then null else old.status_id end,
      new.status_id,
      auth.uid(),
      (select email from profiles where id = auth.uid())
    );
  end if;
  return null;
end;
$function$;

create or replace function public.log_work_order_stage_assignment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('app.deshaciendo_avance', true), '') = 'on' then
    return null;
  end if;

  update work_order_stage_assignments
     set ended_at = now()
   where work_order_id = new.id and ended_at is null;

  insert into work_order_stage_assignments (work_order_id, employee_id, status_id)
  values (new.id, new.employee_id, new.status_id);

  return null;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Deshacer
-- ---------------------------------------------------------------------------
create or replace function public.deshacer_avance_de_orden(p_work_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ultimo work_order_status_history%rowtype;
  v_volver_a text;
  v_deshecho text;
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_ultimo
  from work_order_status_history
  where work_order_id = p_work_order_id
  order by changed_at desc, id desc
  limit 1;

  if not found then
    raise exception 'Esta orden no tiene ningún avance registrado.';
  end if;

  if v_ultimo.from_status_id is null then
    raise exception
      'Ese es el estado con el que se abrió la orden: no hay avance que deshacer.';
  end if;

  select label into v_deshecho from work_order_statuses where id = v_ultimo.to_status_id;
  select label into v_volver_a from work_order_statuses where id = v_ultimo.from_status_id;

  perform set_config('app.deshaciendo_avance', 'on', true);

  update work_orders
     set status_id = v_ultimo.from_status_id
   where id = p_work_order_id;

  delete from work_order_status_history where id = v_ultimo.id;

  -- El tramo que abrió ese paso se va, y el anterior vuelve a quedar abierto:
  -- la orden estuvo en la etapa anterior todo este tiempo.
  delete from work_order_stage_assignments
   where work_order_id = p_work_order_id
     and status_id = v_ultimo.to_status_id
     and ended_at is null;

  update work_order_stage_assignments
     set ended_at = null
   where id = (
     select id from work_order_stage_assignments
      where work_order_id = p_work_order_id
      order by started_at desc, id desc
      limit 1
   );

  perform set_config('app.deshaciendo_avance', 'off', true);

  return jsonb_build_object('deshecho', v_deshecho, 'volvio_a', v_volver_a);
end;
$function$;

revoke all on function public.deshacer_avance_de_orden(uuid) from public, anon;
grant execute on function public.deshacer_avance_de_orden(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='deshacer_avance_de_orden') as funcion,
  (select prosrc like '%deshaciendo_avance%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='log_work_order_status_change') as historial_respeta_la_marca,
  (select prosrc like '%deshaciendo_avance%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='log_work_order_stage_assignment') as tramos_respetan_la_marca;
