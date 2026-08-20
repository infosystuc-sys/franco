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

-- DieselPro ERP — Empleados: clientes y vehiculos, solo los de sus ordenes
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (migracion
-- employee_customers_vehicles_rls). Queda como registro del esquema.
--
-- Ver el diseño completo en:
--   .superpowers/sdd/2026-08-19-empleados/

drop policy "authenticated read" on customers;
create policy "lectura segun rol" on customers for select to authenticated
  using (is_admin() or exists (
    select 1 from work_orders w
    where w.customer_id = customers.id
      and w.employee_id = current_employee_id()
  ));

drop policy "authenticated read" on vehicles;
create policy "lectura segun rol" on vehicles for select to authenticated
  using (is_admin() or exists (
    select 1 from work_orders w
    where w.vehicle_id = vehicles.id
      and w.employee_id = current_employee_id()
  ));

-- DieselPro ERP — Empleados: cerrar el resto de las tablas
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel" (migracion
-- employee_close_remaining_tables). Queda como registro del esquema.
--
-- Ver el diseño completo en:
--   .superpowers/sdd/2026-08-19-empleados/

-- Informacion comercial y de compras: no la necesita quien repara.
drop policy "authenticated read" on quotations;
create policy "solo admin" on quotations for select to authenticated using (is_admin());

drop policy "authenticated read" on quotation_items;
create policy "solo admin" on quotation_items for select to authenticated using (is_admin());

drop policy "authenticated read" on suppliers;
create policy "solo admin" on suppliers for select to authenticated using (is_admin());

drop policy "authenticated read" on article_suppliers;
create policy "solo admin" on article_suppliers for select to authenticated using (is_admin());

drop policy "authenticated read" on price_imports;
create policy "solo admin" on price_imports for select to authenticated using (is_admin());

drop policy "authenticated read" on unmatched_supplier_prices;
create policy "solo admin" on unmatched_supplier_prices for select to authenticated using (is_admin());

-- La cola guarda telefonos de clientes y el texto de cada mensaje.
drop policy "authenticated read" on notifications;
create policy "solo admin" on notifications for select to authenticated using (is_admin());

drop policy "authenticated read" on notification_templates;
create policy "solo admin" on notification_templates for select to authenticated using (is_admin());

drop policy "authenticated read" on app_settings;
create policy "solo admin" on app_settings for select to authenticated using (is_admin());

-- Los renglones de la orden guardan codigo y descripcion propios: el operario
-- no necesita el catalogo, que lleva costos y utilidad. Verificado que
-- src/pages/WorkOrderDetails.tsx solo llama a fetchArticles() cuando isAdmin,
-- asi que la pantalla de detalle no depende de esta tabla para el operario.
drop policy "authenticated read" on articles;
create policy "solo admin" on articles for select to authenticated using (is_admin());

-- employees conserva su politica "authenticated read": el nombre del
-- empleado aparece en la orden y los compañeros se ven entre ellos.


-- ===========================================================================
-- Cierre de una vía de escritura que quedaba abierta
-- ===========================================================================
-- Migración lock_adjust_article_stock, aplicada en la revisión final de rama.
--
-- adjust_article_stock es security definer y escribe el stock sin comprobar
-- quién la llama. Postgres otorga EXECUTE a public por defecto, así que quedaba
-- invocable por cualquiera —incluido un usuario anónimo con la clave pública—
-- y bastaba conocer el id de un artículo para alterar el inventario. Un
-- operario obtiene esos ids de los renglones de sus propias órdenes, que sí
-- puede leer.
--
-- Cerrarle la lectura de `articles` no alcanzaba: la escritura pasaba por acá.
-- Solo la invoca el disparador work_order_items_stock_sync, que corre con los
-- permisos de quien lo definió y no necesita este grant.
revoke execute on function public.adjust_article_stock(uuid, numeric)
  from public, anon, authenticated;
