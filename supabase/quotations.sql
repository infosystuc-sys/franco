-- DieselPro ERP — módulo de cotizaciones
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (vía MCP, migraciones
-- quotations_module y quotation_rpcs). Este archivo queda como registro del
-- esquema; volver a ejecutarlo dará errores de "already exists".
--
-- Orden en una base vacía:
--   schema.sql → auth.sql → articles.sql → (fiscal/vehículos/proveedores) → quotations.sql
--
-- Modelo:
--   La cotización es el paso previo a la OT y tiene la misma forma (cliente,
--   vehículo, componente y renglones), pero NO mueve stock: es una propuesta,
--   no un compromiso. El stock se descuenta recién al convertirla en OT.

-- ===== 1) Numeración por secuencia (evita colisiones al generarla en el cliente)
create sequence work_order_number_seq start 5000;
create sequence quotation_number_seq start 1000;

alter table work_orders
  alter column number set default 'OT-' || nextval('work_order_number_seq')::text;

-- ===== 2) La OT ya no arranca en "Cotización enviada": nace autorizada,
-- porque proviene de una cotización aceptada.
update work_orders set status = 'AUTORIZADO' where status = 'COTIZACION_ENVIADA';

alter type work_order_status rename to work_order_status_old;
create type work_order_status as enum (
  'AUTORIZADO', 'EN_ESPERA_REP', 'EN_REPARACION', 'CALIBRACION', 'TERMINADO'
);
alter table work_orders
  alter column status drop default,
  alter column status type work_order_status using status::text::work_order_status,
  alter column status set default 'AUTORIZADO';
drop type work_order_status_old;

-- ===== 3) Cotizaciones
create type quotation_status as enum ('EMITIDA', 'ENVIADA', 'ACEPTADA', 'RECHAZADA');

create table quotations (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default 'COT-' || nextval('quotation_number_seq')::text,
  status quotation_status not null default 'EMITIDA',
  customer_id uuid not null references customers(id),
  vehicle_id uuid not null references vehicles(id),
  component text,
  notes text,
  valid_until date,
  -- OT generada al aceptarse. Null = todavía no convertida.
  -- on delete RESTRICT: tampoco se puede borrar la OT que salió de acá. Si se
  -- pudiera, la cotización quedaría ACEPTADA con el vínculo en blanco y la app
  -- volvería a ofrecer convertirla, generando una segunda OT.
  work_order_id uuid references work_orders(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger quotations_set_updated_at
before update on quotations
for each row execute function set_updated_at();

-- Renglones de cotización: misma forma que los de la OT pero SIN trigger de
-- stock. Ésa es la diferencia clave entre ambos módulos.
create table quotation_items (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references quotations(id) on delete cascade,
  article_id uuid references articles(id) on delete restrict,
  code text,
  description text not null,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  subtotal numeric not null default 0
);

create index quotation_items_quotation_idx on quotation_items (quotation_id);
create index quotations_status_idx on quotations (status);

-- Enlace inverso: desde la OT se puede ver de qué cotización vino.
-- on delete RESTRICT: una cotización que ya generó una OT NO puede eliminarse.
-- Es el registro de lo que el cliente aceptó y el origen de esa orden; borrarla
-- dejaría la OT sin trazabilidad. La base lo rechaza, no solo la interfaz.
alter table work_orders
  add column quotation_id uuid references quotations(id) on delete restrict;

-- ===== 4) RLS: lectura abierta, escritura solo admin (igual que el resto)
alter table quotations enable row level security;
alter table quotation_items enable row level security;

create policy "read all" on quotations for select using (true);
create policy "admin insert" on quotations for insert with check (is_admin());
create policy "admin update" on quotations for update using (is_admin()) with check (is_admin());
create policy "admin delete" on quotations for delete using (is_admin());

create policy "read all" on quotation_items for select using (true);
create policy "admin insert" on quotation_items for insert with check (is_admin());
create policy "admin update" on quotation_items for update using (is_admin()) with check (is_admin());
create policy "admin delete" on quotation_items for delete using (is_admin());

-- ===== 5) Guardado atómico de renglones.
-- Solo mientras esté Emitida o Enviada: una vez Aceptada o Rechazada la
-- cotización queda congelada como registro de lo que se acordó.
create or replace function public.replace_quotation_items(
  p_quotation_id uuid,
  p_items jsonb
)
returns void
language plpgsql
as $$
declare
  v_status quotation_status;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select status into v_status from quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_status in ('ACEPTADA', 'RECHAZADA') then
    raise exception 'La cotización está % y no puede modificarse.', lower(v_status::text);
  end if;

  delete from quotation_items where quotation_id = p_quotation_id;

  insert into quotation_items (quotation_id, article_id, code, description, quantity, unit_price, subtotal)
  select
    p_quotation_id,
    nullif(item->>'article_id', '')::uuid,
    item->>'code',
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item;
end;
$$;

-- ===== 6) Conversión de cotización aceptada en orden de trabajo.
-- Método elegido: una sola transacción del lado de la base. Crea la OT, copia
-- los renglones (lo que dispara el descuento de stock) y enlaza ambas. Si el
-- stock no alcanza, se revierte todo: no queda una OT huérfana ni stock mal
-- descontado. El "for update" impide que dos conversiones simultáneas —doble
-- clic o dos usuarios— generen dos OT para la misma cotización.
create or replace function public.convert_quotation_to_work_order(p_quotation_id uuid)
returns table (id uuid, number text)
language plpgsql
as $$
declare
  v_quotation quotations%rowtype;
  v_wo_id uuid;
  v_wo_number text;
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

  insert into work_orders (status, customer_id, vehicle_id, component, quotation_id)
  values ('AUTORIZADO', v_quotation.customer_id, v_quotation.vehicle_id, v_quotation.component, v_quotation.id)
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

-- ===== 7) Duplicar una cotización (para recotizar tras un rechazo).
create or replace function public.duplicate_quotation(p_quotation_id uuid)
returns table (id uuid, number text)
language plpgsql
as $$
declare
  v_new_id uuid;
  v_new_number text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  insert into quotations (status, customer_id, vehicle_id, component, notes, valid_until)
  select 'EMITIDA', q.customer_id, q.vehicle_id, q.component, q.notes, current_date + 15
  from quotations q where q.id = p_quotation_id
  returning quotations.id, quotations.number into v_new_id, v_new_number;

  if v_new_id is null then
    raise exception 'La cotización a duplicar no existe.';
  end if;

  insert into quotation_items (quotation_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_new_id, qi.article_id, qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi where qi.quotation_id = p_quotation_id;

  return query select v_new_id, v_new_number;
end;
$$;
