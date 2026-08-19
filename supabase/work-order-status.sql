-- DieselPro ERP — cambio de estado de las órdenes de trabajo e historial
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (migración
-- work_order_status_history). Queda como registro del esquema.
--
-- El cambio de estado en sí es un UPDATE sobre work_orders.status, protegido
-- por la política RLS "admin update" que ya existía. Lo que agrega este
-- archivo es la trazabilidad.

create table work_order_status_history (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_orders(id) on delete cascade,
  from_status work_order_status,
  to_status work_order_status not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_by_email text,
  changed_at timestamptz not null default now()
);

create index wo_status_history_order_idx
  on work_order_status_history (work_order_id, changed_at);

-- El historial lo escribe el trigger, nunca la app: así ningún cambio de
-- estado puede quedar sin registrar, venga de donde venga.
create or replace function public.log_work_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into work_order_status_history (
      work_order_id, from_status, to_status, changed_by, changed_by_email
    )
    values (
      new.id,
      case when tg_op = 'INSERT' then null else old.status end,
      new.status,
      auth.uid(),
      (select email from profiles where id = auth.uid())
    );
  end if;
  return null;
end;
$$;

create trigger work_orders_log_status
after insert or update of status on work_orders
for each row execute function public.log_work_order_status_change();

-- Estado inicial de las OT que ya existían, para que su línea de tiempo
-- tenga al menos la fecha de creación.
insert into work_order_status_history (work_order_id, from_status, to_status, changed_at)
select id, null, status, created_at from work_orders;

-- RLS: solo lectura, y abierta porque el portal público del cliente la usa
-- para mostrar las fechas de cada etapa.
-- No hay políticas de insert/update/delete a propósito: el historial es un
-- registro de auditoría y solo lo escribe el trigger (security definer).
alter table work_order_status_history enable row level security;
create policy "read all" on work_order_status_history for select using (true);
