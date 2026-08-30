-- ===========================================================================
-- Tracking de personal por etapa: work_order_stage_assignments
-- ===========================================================================
-- Migración: work_order_stage_assignments
--
-- Cada vez que cambia el empleado asignado a una OT o su estado, se cierra
-- el tramo abierto (ended_at = ahora) y se abre uno nuevo. No hay pantalla
-- ni acción nueva para el admin: sigue reasignando desde el mismo selector
-- de siempre y cambiando el estado como ya lo hace — el tramo se registra
-- solo, vía trigger, igual que ya se hace con work_order_status_history.
--
-- work_orders.employee_id no cambia de significado: sigue siendo "quién la
-- tiene asignada ahora" (lo que usa el RLS del operario). Esta tabla es el
-- historial completo de esos tramos, con cuánto duró cada uno, para poder
-- calcular tiempos promedio por etapa y detectar horas muertas (tramos sin
-- empleado asignado). employee_id admite null acá con ese sentido: una OT
-- "en espera de repuestos" sin nadie asignado también es un tramo válido.
--
-- No se reconstruye el historial de asignaciones previas a esta migración
-- (nunca se registró quién trabajó en cada tramo pasado): el backfill abre
-- un único tramo por OT existente, con el estado/empleado actuales, arrancando
-- en el momento en que llegó a ese estado según work_order_status_history.

create table public.work_order_stage_assignments (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  employee_id uuid references public.employees(id),
  status_id uuid not null references public.work_order_statuses(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index work_order_stage_assignments_work_order_id_idx
  on public.work_order_stage_assignments(work_order_id);

create index work_order_stage_assignments_open_idx
  on public.work_order_stage_assignments(work_order_id) where ended_at is null;

create index work_order_stage_assignments_status_id_idx
  on public.work_order_stage_assignments(status_id);

alter table public.work_order_stage_assignments enable row level security;

-- Sin política de insert/update: los tramos los escribe únicamente el
-- trigger de más abajo (SECURITY DEFINER, mismo patrón que
-- log_work_order_status_change con work_order_status_history).
create policy "lectura segun rol" on public.work_order_stage_assignments for select
  using (
    is_admin() or exists (
      select 1 from work_orders w
      where w.id = work_order_stage_assignments.work_order_id
        and w.employee_id = current_employee_id()
    )
  );

-- ── Backfill: un tramo abierto por cada OT existente ───────────────────

insert into public.work_order_stage_assignments (work_order_id, employee_id, status_id, started_at)
select
  wo.id,
  wo.employee_id,
  wo.status_id,
  coalesce(
    (select max(h.changed_at) from work_order_status_history h
      where h.work_order_id = wo.id and h.to_status_id = wo.status_id),
    wo.created_at
  )
from work_orders wo;

-- ── Trigger: abre/cierra tramos cuando cambia employee_id o status_id ──

create or replace function public.log_work_order_stage_assignment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update work_order_stage_assignments
     set ended_at = now()
   where work_order_id = new.id and ended_at is null;

  insert into work_order_stage_assignments (work_order_id, employee_id, status_id)
  values (new.id, new.employee_id, new.status_id);

  return null;
end;
$$;

create trigger work_orders_log_stage_assignment
after insert or update of employee_id, status_id on public.work_orders
for each row execute function log_work_order_stage_assignment();

-- ── Informe: tiempos por etapa ──────────────────────────────────────────
--
-- SECURITY INVOKER (default, sin declarar): el RLS de arriba ya dice
-- "admin o el operario dueño de la OT", así que el informe hereda esa
-- restricción sin abrir un camino privilegiado nuevo — mismo criterio que
-- el resto de reports.sql. En la práctica solo lo corre el admin (la
-- pantalla de informes es adminOnly).

create or replace function public.report_stage_times(p_from date, p_to date)
returns table (
  status_label text,
  sector text,
  employee_name text,
  assignments integer,
  avg_hours numeric,
  total_hours numeric
)
language sql
stable
as $$
  select
    ws.label,
    coalesce(e.workplace, 'Sin sector'),
    coalesce(e.name, 'Sin asignar'),
    count(*)::integer,
    round((avg(extract(epoch from (coalesce(a.ended_at, now()) - a.started_at))) / 3600)::numeric, 1),
    round((sum(extract(epoch from (coalesce(a.ended_at, now()) - a.started_at))) / 3600)::numeric, 1)
  from work_order_stage_assignments a
  join work_order_statuses ws on ws.id = a.status_id
  left join employees e on e.id = a.employee_id
  where a.started_at::date between p_from and p_to
  group by ws.label, ws.sort_order, coalesce(e.workplace, 'Sin sector'), coalesce(e.name, 'Sin asignar')
  order by ws.sort_order, coalesce(e.workplace, 'Sin sector'), coalesce(e.name, 'Sin asignar');
$$;
