-- ===========================================================================
-- ABM de estados de OT: reemplaza el enum work_order_status por una tabla
-- ===========================================================================
-- Migración: work_order_statuses_abm
--
-- Hasta acá los estados de la OT eran un enum nativo de Postgres, fijo en
-- el código: agregar, renombrar o reordenar un estado pedía una migración y
-- un despliegue. Pasan a vivir en work_order_statuses, una tabla que el
-- admin edita desde una pantalla propia.
--
-- Tres columnas booleanas reemplazan lo que antes eran comparaciones contra
-- el texto literal 'TERMINADO' o 'AUTORIZADO' desperdigadas en triggers y
-- funciones — así el comportamiento sigue funcionando aunque el admin
-- renombre o reordene los estados:
--   is_initial      el estado con el que nace una OT (exactamente uno)
--   is_terminal     cierra la orden: habilita facturar, cuenta como "cerrada"
--   notifies_client al llegar a este estado se manda WhatsApp (hoy: Terminado)
--
-- Dependencias relevadas antes de escribir esto (todo lo que usaba el enum
-- work_order_status en la base): work_orders.status,
-- work_order_status_history.from_status/to_status, notification_templates.status
-- (era su primary key), y las funciones build_work_order_message,
-- get_public_work_order, get_public_status_history, convert_quotation_to_work_order,
-- enqueue_work_order_status, enqueue_work_order_created, log_work_order_status_change.
-- Se tocan todas acá, no solo la tabla.

-- ── 1. La tabla y su ABM ────────────────────────────────────────────────

create table public.work_order_statuses (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  client_description text not null default '',
  color text not null default '#9a9a9a',
  sort_order int not null,
  active boolean not null default true,
  is_initial boolean not null default false,
  is_terminal boolean not null default false,
  notifies_client boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A lo sumo un estado inicial. No exige que haya alguno: si el admin borra
-- el único que tenía la marca, convert_quotation_to_work_order lo va a decir
-- con un error claro en vez de fallar silenciosamente con una OT sin estado.
create unique index work_order_statuses_one_initial
  on public.work_order_statuses (is_initial) where is_initial;

create trigger work_order_statuses_set_updated_at
before update on public.work_order_statuses
for each row execute function set_updated_at();

alter table public.work_order_statuses enable row level security;

-- Lectura abierta a cualquiera, sin sesión incluida: la ve tanto el admin
-- en el ABM como el cliente en el link público de seguimiento (que no tiene
-- sesión), y no hay nada sensible en un nombre de estado y un color.
create policy "read all" on public.work_order_statuses for select using (true);
create policy "admin insert" on public.work_order_statuses for insert with check (is_admin());
create policy "admin update" on public.work_order_statuses for update using (is_admin()) with check (is_admin());
create policy "admin delete" on public.work_order_statuses for delete using (is_admin());

-- ── 2. Semilla: los 5 estados de hoy, en el mismo orden y colores ──────

insert into public.work_order_statuses
  (label, client_description, color, sort_order, is_initial, is_terminal, notifies_client)
values
  ('Autorizada', 'El cliente autorizó el trabajo. Se procederá con la reparación.', '#2b6cb0', 1, true, false, false),
  ('Esp. Repuestos', 'Se están gestionando los repuestos necesarios.', '#e07b1a', 2, false, false, false),
  ('En Reparación', 'El componente está siendo reparado en el taller.', '#7b3fa0', 3, false, false, false),
  ('Calibración', 'Se está calibrando y probando el componente reparado.', '#c9a227', 4, false, false, false),
  ('Terminado', 'El servicio finalizó. Listo para retirar.', '#2e7d32', 5, false, true, true);

-- ── 3. work_orders: agrega status_id, lo completa, saca el enum viejo ──

alter table public.work_orders add column status_id uuid references public.work_order_statuses(id);

update public.work_orders set status_id = (
  select id from public.work_order_statuses where label = case work_orders.status
    when 'AUTORIZADO' then 'Autorizada'
    when 'EN_ESPERA_REP' then 'Esp. Repuestos'
    when 'EN_REPARACION' then 'En Reparación'
    when 'CALIBRACION' then 'Calibración'
    when 'TERMINADO' then 'Terminado'
  end
);

alter table public.work_orders alter column status_id set not null;

-- ── 4. work_order_status_history: mismo tratamiento, from_status admite null ──

alter table public.work_order_status_history add column from_status_id uuid references public.work_order_statuses(id);
alter table public.work_order_status_history add column to_status_id uuid references public.work_order_statuses(id);

update public.work_order_status_history set
  from_status_id = (
    select id from public.work_order_statuses where label = case from_status
      when 'AUTORIZADO' then 'Autorizada' when 'EN_ESPERA_REP' then 'Esp. Repuestos'
      when 'EN_REPARACION' then 'En Reparación' when 'CALIBRACION' then 'Calibración'
      when 'TERMINADO' then 'Terminado' end
  ),
  to_status_id = (
    select id from public.work_order_statuses where label = case to_status
      when 'AUTORIZADO' then 'Autorizada' when 'EN_ESPERA_REP' then 'Esp. Repuestos'
      when 'EN_REPARACION' then 'En Reparación' when 'CALIBRACION' then 'Calibración'
      when 'TERMINADO' then 'Terminado' end
  );

alter table public.work_order_status_history alter column to_status_id set not null;

-- ── 5. notification_templates: status era su primary key ──────────────

alter table public.notification_templates add column status_id uuid references public.work_order_statuses(id);

update public.notification_templates set status_id = (
  select id from public.work_order_statuses where label = case status
    when 'AUTORIZADO' then 'Autorizada' when 'EN_ESPERA_REP' then 'Esp. Repuestos'
    when 'EN_REPARACION' then 'En Reparación' when 'CALIBRACION' then 'Calibración'
    when 'TERMINADO' then 'Terminado' end
);

alter table public.notification_templates drop constraint notification_templates_pkey;
alter table public.notification_templates alter column status_id set not null;
alter table public.notification_templates add primary key (status_id);

-- ── 6. Saca los triggers que dependen de la columna vieja antes de tocarla ──

drop trigger work_orders_enqueue_status on public.work_orders;
drop trigger work_orders_log_status on public.work_orders;

-- ── 7. Saca las columnas viejas (el tipo enum se saca en el paso 8, recién
--       después de redefinir las funciones que todavía lo mencionan en su
--       firma — dropear el tipo antes rompería esas definiciones) ───────

alter table public.work_orders drop column status;
alter table public.work_order_status_history drop column from_status;
alter table public.work_order_status_history drop column to_status;
alter table public.notification_templates drop column status;

-- ── 8. Redefine las funciones que usaban el enum ───────────────────────
--
-- Estas tres cambian de firma (un parámetro o una columna del RETURNS
-- TABLE), y CREATE OR REPLACE FUNCTION no lo permite — hay que dropearlas
-- primero. Las demás (funciones de trigger, y convert_quotation_to_work_order)
-- mantienen la misma firma y solo cambia el cuerpo, así que sí aceptan
-- CREATE OR REPLACE tal cual.

drop function public.build_work_order_message(uuid, work_order_status, boolean);
drop function public.get_public_work_order(uuid);
drop function public.get_public_status_history(uuid);

create or replace function public.build_work_order_message(p_work_order_id uuid, p_status_id uuid, p_include_intro boolean)
returns text
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare
  v_base text;
  v_wo record;
  v_plantilla text;
  v_vehiculo text;
begin
  select value into v_base from app_settings where key = 'public_base_url';
  select body into v_plantilla from notification_templates where status_id = p_status_id;

  select wo.number, wo.component, wo.public_token,
         trim(coalesce(v.brand,'') || ' ' || coalesce(v.model,'')) as veh,
         v.license_plate
    into v_wo
    from work_orders wo
    left join vehicles v on v.id = wo.vehicle_id
   where wo.id = p_work_order_id;

  v_vehiculo := nullif(v_wo.veh, '');
  if v_wo.license_plate is not null then
    v_vehiculo := coalesce(v_vehiculo, '') || ' (' || v_wo.license_plate || ')';
  end if;

  return
    case when p_include_intro
      then 'Hola, le compartimos el seguimiento de su reparación.' || E'\n\n'
      else '' end ||
    'Orden ' || v_wo.number ||
    coalesce(E'\n' || v_vehiculo, '') ||
    coalesce(E'\n' || v_wo.component, '') || E'\n\n' ||
    coalesce(v_plantilla, '') || E'\n\n' ||
    'Puede seguir el avance acá:' || E'\n' ||
    coalesce(v_base, '') || '/seguimiento/' || v_wo.public_token::text;
end;
$$;

create or replace function public.enqueue_work_order_created()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform enqueue_notification(
    'LINK_SEGUIMIENTO',
    'ot:' || new.id::text || ':alta',
    build_work_order_message(new.id, new.status_id, true),
    new.customer_id,
    new.id
  );
  return null;
end;
$$;

create or replace function public.enqueue_work_order_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_base_key text;
  v_seq int;
  v_notifies boolean;
begin
  if new.status_id = old.status_id then
    return null;
  end if;

  select notifies_client into v_notifies from work_order_statuses where id = new.status_id;
  if not coalesce(v_notifies, false) then
    return null;
  end if;

  v_base_key := 'ot:' || new.id::text || ':estado:' || new.status_id::text;

  select count(*) + 1 into v_seq
  from notifications
  where dedupe_key = v_base_key or dedupe_key like v_base_key || ':%';

  perform enqueue_notification(
    'CAMBIO_ESTADO',
    case when v_seq = 1 then v_base_key else v_base_key || ':' || v_seq::text end,
    build_work_order_message(new.id, new.status_id, false),
    new.customer_id,
    new.id
  );
  return null;
end;
$$;

create or replace function public.log_work_order_status_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
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
$$;

create or replace function public.convert_quotation_to_work_order(p_quotation_id uuid)
returns table(id uuid, number text)
language plpgsql
as $$
declare
  v_quotation quotations%rowtype;
  v_wo_id uuid;
  v_wo_number text;
  v_initial_status_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_quotation from quotations where quotations.id = p_quotation_id for update;

  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_quotation.work_order_id is not null then
    raise exception 'Esta cotización ya fue convertida en una orden de trabajo.';
  end if;
  if v_quotation.status <> 'ACEPTADA' then
    raise exception 'Solo se convierten cotizaciones aceptadas (estado actual: %).', v_quotation.status;
  end if;
  if not exists (select 1 from quotation_items where quotation_id = p_quotation_id) then
    raise exception 'La cotización no tiene renglones cargados.';
  end if;

  select id into v_initial_status_id from work_order_statuses where is_initial limit 1;
  if v_initial_status_id is null then
    raise exception 'No hay un estado inicial configurado para las órdenes de trabajo. Marcá uno desde Estados de OT.';
  end if;

  insert into work_orders (status_id, customer_id, vehicle_id, component, quotation_id)
  values (v_initial_status_id, v_quotation.customer_id, v_quotation.vehicle_id, v_quotation.component, v_quotation.id)
  returning work_orders.id, work_orders.number into v_wo_id, v_wo_number;

  -- Al copiar los renglones se dispara el trigger de stock: acá sí se descuenta.
  insert into work_order_items (work_order_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_wo_id, qi.article_id, qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi
  where qi.quotation_id = p_quotation_id;

  update quotations set work_order_id = v_wo_id where quotations.id = p_quotation_id;

  return query select v_wo_id, v_wo_number;
end;
$$;

create or replace function public.get_public_work_order(p_token uuid)
returns table(
  number text, status_id uuid, component text, vehicle_brand text, vehicle_model text,
  license_plate text, vehicle_type text, vehicle_year integer, engine_brand text,
  engine_model text, injection_system text, employee_name text, customer_name text
)
language sql
stable security definer
set search_path to 'public'
as $$
  select
    wo.number, wo.status_id, wo.component,
    v.brand, v.model, v.license_plate, v.vehicle_type, v.year,
    v.engine_brand, v.engine_model, v.injection_system,
    e.name, c.name
  from work_orders wo
  left join vehicles v  on v.id = wo.vehicle_id
  left join employees e on e.id = wo.employee_id
  left join customers c on c.id = wo.customer_id
  where wo.public_token = p_token;
$$;

create or replace function public.get_public_status_history(p_token uuid)
returns table(to_status_id uuid, changed_at timestamp with time zone)
language sql
stable security definer
set search_path to 'public'
as $$
  select h.to_status_id, h.changed_at
  from work_order_status_history h
  join work_orders wo on wo.id = h.work_order_id
  where wo.public_token = p_token
  order by h.changed_at;
$$;

-- Se dropearon y se vuelven a crear (no CREATE OR REPLACE): el grant a
-- anon/authenticated que necesita el portal público sin sesión hay que
-- pedirlo de nuevo explícito, no asumir que vuelve solo.
grant execute on function public.get_public_work_order(uuid) to anon, authenticated;
grant execute on function public.get_public_status_history(uuid) to anon, authenticated;

-- Ahora sí: ninguna función queda mencionando el enum en su firma.
drop type public.work_order_status;

-- ── 9. Recrea los triggers que se sacaron en el paso 6, ahora sobre status_id ──

create trigger work_orders_enqueue_status
after update of status_id on public.work_orders
for each row execute function enqueue_work_order_status();

create trigger work_orders_log_status
after insert or update of status_id on public.work_orders
for each row execute function log_work_order_status_change();
