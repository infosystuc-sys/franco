-- ===========================================================================
-- La recepción de vehículos arranca en la OT
-- ===========================================================================
-- Migración: reception_from_work_order
--
-- El cliente deja el vehículo antes de que haya nada que cotizar, y el
-- circuito viejo no lo reflejaba: el ingreso vivía en su propio módulo y la
-- OT recién nacía cuando la cotización se aceptaba. El vehículo pasaba días
-- en el taller sin orden que lo representara.

-- 1) Qué se recibió --------------------------------------------------------
-- No se deduce de si hay vehículo: el caso común es "traigo la bomba del
-- Scania patente XYZ", donde el vehículo se elige pero el camión no está en
-- la playa. Esta marca es la que decide si la OT ocupa lugar.
alter table public.work_orders
  add column reception_kind text not null default 'VEHICULO'
  check (reception_kind in ('VEHICULO', 'PIEZA'));

alter table public.work_orders add column observations text;

-- Una OT de pieza suelta puede no tener vehículo.
alter table public.work_orders alter column vehicle_id drop not null;

-- 2) Piezas recibidas ------------------------------------------------------
create table public.work_order_received_parts (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  name text not null,
  serial_number text not null,
  created_at timestamptz not null default now()
);

create index work_order_received_parts_wo_idx
  on public.work_order_received_parts(work_order_id);

alter table public.work_order_received_parts enable row level security;

create policy "lectura autenticada" on public.work_order_received_parts
  for select to authenticated using (true);
create policy "admin insert" on public.work_order_received_parts
  for insert to authenticated with check (is_admin());
create policy "admin update" on public.work_order_received_parts
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin delete" on public.work_order_received_parts
  for delete to authenticated using (is_admin());

-- 3) Estados nuevos --------------------------------------------------------
-- "Rechazada" NO es terminal, y el motivo no es solo que no haya nada que
-- facturar: block_terminal_while_price_pending salta al pasar de no terminal
-- a terminal si el total difiere del presupuestado sin autorizar, y una OT en
-- "Cotizado" todavía no tiene renglones copiados. Marcarla terminal haría
-- imposible registrar un rechazo.
-- "Autorizada" deja de ser el estado inicial ANTES de insertar el nuevo: hay
-- un índice único que admite un solo is_initial, así que insertar primero y
-- desmarcar después falla.
update public.work_order_statuses set is_initial = false where label = 'Autorizada';

insert into public.work_order_statuses
  (label, client_description, color, sort_order, active, is_initial, is_terminal, notifies_client, frees_yard)
values
  ('Ingresado', 'Recibimos el vehículo en el taller.', '#4a6fa5', 1, true, true, false, false, false),
  ('Cotizado',  'Te enviamos el presupuesto y esperamos tu respuesta.', '#e07b1a', 2, true, false, false, false, false),
  ('Rechazada', 'El presupuesto no fue aceptado.', '#8a8f98', 9, true, false, false, false, true);

-- Los estados nuevos se intercalan al principio del flujo, así que los que ya
-- existían corren. Dos estados con el mismo orden dejan las pantallas y los
-- informes decidiendo por desempate arbitrario.
update public.work_order_statuses set sort_order = case label
  when 'Autorizada'     then 3
  when 'Esp. Repuestos' then 4
  when 'En Reparación'  then 5
  when 'Calibración'    then 6
  when 'Terminado'      then 7
  when 'Retirado'       then 8
  else sort_order
end
where label in ('Autorizada','Esp. Repuestos','En Reparación','Calibración','Terminado','Retirado');

-- 4) Los ingresos que hoy están abiertos pasan a ser OT ---------------------
-- Los que ya derivaron en una OT no se convierten: su información ya vive ahí.
--
-- Va como bucle y no como un INSERT ... RETURNING encadenado a propósito: el
-- RETURNING no devuelve de qué ingreso salió cada OT, y varios ingresos
-- comparten vehículo y no tienen cotización (ING-3, ING-8 e ING-9 son del
-- mismo John Deere). Reencontrar el vínculo por vehículo+cotización pegaría
-- las piezas de un ingreso a todas las OT de ese vehículo. Acá cada ingreso
-- conoce su OT porque se crean de a uno.
--
-- Se conserva la fecha real del ingreso (created_at) en vez de dejar que la
-- OT nazca "hoy": la pantalla de disponibilidad calcula cuántos días lleva
-- un vehículo en el taller a partir de work_orders.created_at, y el informe
-- "Tiempos por etapa" mide desde work_order_stage_assignments.started_at.
-- Sin esto, 8 vehículos que llevan semanas adentro aparecerían recién
-- ingresados.
do $$
declare
  r record;
  v_wo uuid;
  v_estado uuid;
begin
  for r in
    select i.*, case when i.status::text = 'COTIZADO' then 'Cotizado' else 'Ingresado' end as estado_destino
    from public.vehicle_intakes i
    where i.quotation_id is null
       or not exists (select 1 from public.work_orders w where w.quotation_id = i.quotation_id)
    order by i.number
  loop
    select id into v_estado from public.work_order_statuses where label = r.estado_destino;

    insert into public.work_orders
      (status_id, customer_id, vehicle_id, quotation_id, observations, reception_kind, created_at)
    values (v_estado, r.customer_id, r.vehicle_id, r.quotation_id, r.observations, 'VEHICULO', r.created_at)
    returning id into v_wo;

    insert into public.work_order_received_parts (work_order_id, name, serial_number, created_at)
    select v_wo, p.name, p.serial_number, p.created_at
    from public.vehicle_intake_parts p
    where p.intake_id = r.id;

    -- work_orders_log_stage_assignment abre el tramo con now(). Estos vehículos
    -- están en el taller desde su ingreso, no desde que corrió la migración:
    -- sin esto, "Tiempos por etapa" informaría que entraron hoy.
    update public.work_order_stage_assignments
    set started_at = r.created_at
    where work_order_id = v_wo;
  end loop;
end $$;

-- 5) Que la migración no le escriba a los clientes -------------------------
-- work_orders_enqueue_created encola un WhatsApp con el link de seguimiento
-- por cada OT insertada. Son 8 mensajes reales avisando de una orden que para
-- el cliente no es nueva. Se descartan en la misma transacción: nunca llegan
-- a existir como pendientes fuera de ella.
update public.notifications
set status = 'DESCARTADO'
where status::text not in ('ENVIADO', 'DESCARTADO')
  and work_order_id in (
    select w.id from public.work_orders w
    join public.work_order_statuses s on s.id = w.status_id
    where s.label in ('Ingresado', 'Cotizado')
  );
