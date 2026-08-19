-- DieselPro ERP — Empleados: renombrar technicians y sumar vinculo con el usuario
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (migracion
-- rename_technicians_to_employees). Queda como registro del esquema.
--
-- Ver el diseño completo en:
--   .superpowers/sdd/2026-08-19-empleados/

alter table technicians rename to employees;
alter table work_orders rename column technician_id to employee_id;

alter table employees drop column avatar_url;
alter table employees add column phone text;
-- Dar de baja sin borrar: el historial debe seguir diciendo quien hizo cada trabajo.
alter table employees add column active boolean not null default true;
-- El usuario con el que entra. Nulo mientras no tenga acceso.
alter table employees add column profile_id uuid unique references profiles(id) on delete set null;

alter index technicians_pkey rename to employees_pkey;
-- Renombrar la columna NO renombra la restriccion: sin esto queda llamandose
-- work_orders_technician_id_fkey, y el traductor de errores de la Task 5 la
-- busca por nombre.
alter table work_orders
  rename constraint work_orders_technician_id_fkey to work_orders_employee_id_fkey;

-- get_public_work_order cambia el nombre de una columna de retorno, y eso NO
-- se puede con create or replace: hay que borrar y recrear. La funcion sirve
-- los links de seguimiento ya enviados a clientes por WhatsApp, asi que el
-- borrado y la recreacion van en la misma migracion, que es atomica.
drop function public.get_public_work_order(uuid);

create function public.get_public_work_order(p_token uuid)
returns table (
  number text, status work_order_status, component text,
  vehicle_brand text, vehicle_model text, license_plate text,
  vehicle_type text, vehicle_year integer,
  engine_brand text, engine_model text, injection_system text,
  employee_name text, customer_name text
)
language sql
stable
security definer
set search_path = public
as $func$
  select
    wo.number, wo.status, wo.component,
    v.brand, v.model, v.license_plate, v.vehicle_type, v.year,
    v.engine_brand, v.engine_model, v.injection_system,
    e.name, c.name
  from work_orders wo
  left join vehicles v  on v.id = wo.vehicle_id
  left join employees e on e.id = wo.employee_id
  left join customers c on c.id = wo.customer_id
  where wo.public_token = p_token;
$func$;

-- DieselPro ERP — Empleados: cada uno ve solo sus ordenes de trabajo
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (migracion
-- employee_row_level_security). Queda como registro del esquema.
--
-- Ver el diseño completo en:
--   .superpowers/sdd/2026-08-19-empleados/

-- Quien es el empleado que esta mirando. Devuelve null si el usuario no esta
-- vinculado a ninguno, o si el empleado fue dado de baja: en ambos casos no ve
-- ninguna orden, que es lo buscado.
create or replace function public.current_employee_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $func$
  select id from employees where profile_id = auth.uid() and active;
$func$;

drop policy "authenticated read" on work_orders;
create policy "lectura segun rol" on work_orders for select to authenticated
  using (is_admin() or employee_id = current_employee_id());

drop policy "authenticated read" on work_order_items;
create policy "lectura segun rol" on work_order_items for select to authenticated
  using (is_admin() or exists (
    select 1 from work_orders w
    where w.id = work_order_items.work_order_id
      and w.employee_id = current_employee_id()
  ));

drop policy "authenticated read" on work_order_status_history;
create policy "lectura segun rol" on work_order_status_history for select to authenticated
  using (is_admin() or exists (
    select 1 from work_orders w
    where w.id = work_order_status_history.work_order_id
      and w.employee_id = current_employee_id()
  ));
