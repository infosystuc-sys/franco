# Empleados del taller — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el taller pueda cargar empleados, asignarles órdenes de trabajo, y que cada empleado vea únicamente las suyas.

**Architecture:** Se renombra la tabla `technicians` —heredada del prototipo— a `employees` y se le agrega el vínculo con el usuario que inicia sesión. El filtro lo aplica la base con políticas de fila apoyadas en una función `current_employee_id()`, hermana de la `is_admin()` que ya existe. El alta de usuarios la hace una Edge Function con la clave de servicio, porque esa clave no puede estar en el navegador.

**Tech Stack:** Postgres sobre Supabase (RLS, funciones `security definer`), Edge Functions en Deno, React 19 + Vite + TypeScript, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-19-empleados-design.md`

## Global Constraints

- **El proyecto no tiene framework de pruebas.** No se agrega uno en este plan. La verificación de permisos se hace con SQL contra la base, que es la prueba correcta para permisos de fila; la de interfaz, en el navegador.
- **Todo cambio de esquema va por `apply_migration`**, no por `execute_sql`.
- Después de cada migración, dejar constancia en `supabase/employees.sql`, siguiendo la convención del repositorio: encabezado "⚠️ YA APLICADO".
- Comentarios y textos de interfaz **en español**, siguiendo el estilo del código existente: explican por qué, no qué.
- `npx tsc --noEmit` debe terminar sin errores antes de cada commit.
- Los commits usan la identidad ya configurada en el repositorio (`infosystuc-sys`). No pasar `-c user.name` ni `-c user.email`.
- Los servidores de desarrollo se levantan con `preview_start`, nunca con Bash.
- **Nunca** exponer la clave de servicio de Supabase al navegador.

## El arnés de pruebas

Todas las verificaciones de permisos usan este patrón, que consulta la base haciéndose pasar por el operario. Va siempre dentro de `begin/rollback` para no dejar rastro:

**El orden importa.** Los claims van primero y el rol después. Al revés, la
subconsulta que resuelve el `sub` contra `profiles` corre ya con el rol puesto y
queda sujeta a la política `auth.uid() = id` de esa tabla, justo cuando
`auth.uid()` todavía es nulo: el `sub` sale nulo y hasta el admin queda como
anónimo, con `is_admin()` en false. Se descubrió al implementar la Task 2.

```sql
begin;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id from profiles where email = 'operario@gmail.com'),
      'role', 'authenticated'
    )::text, true);
  select set_config('role', 'authenticated', true);

  -- consultas a verificar acá

rollback;
```

**Estado inicial medido el 19/08/2026** — esto es lo que hay que cambiar:

| Tabla | Filas que ve el operario hoy |
|---|---|
| `work_orders` | 6 (todas) |
| `customers` | 5 (todas) |
| `article_suppliers` | 5 (precios de compra) |
| `notifications` | 4 (teléfonos y textos) |

---

### Task 1: Renombrar `technicians` a `employees` y ampliar la ficha

**Files:**
- Migración: `rename_technicians_to_employees`
- Create: `supabase/employees.sql`
- Modify: `src/lib/workOrders.ts`, `src/pages/ClientPortal.tsx:184`, `src/types.ts:40-41`

**Interfaces:**
- Produces: tabla `employees` con `id, name, role, phone, active, profile_id`; columna `work_orders.employee_id`; función `get_public_work_order(uuid)` devolviendo `employee_name` en lugar de `technician_name`.

- [ ] **Step 1: Medir el estado de partida**

```sql
select (select count(*) from technicians) as empleados,
       (select count(*) from work_orders where technician_id is not null) as ot_asignadas,
       (select count(*) from work_orders) as ot_total;
```

Esperado: `1 · 4 · 6`. Anotar los valores: la tarea es correcta solo si al final siguen iguales.

- [ ] **Step 2: Aplicar la migración**

`get_public_work_order` cambia el nombre de una columna de retorno, y eso **no** se puede con `create or replace`: hay que borrar y recrear. La función sirve los links de seguimiento en producción, así que el borrado y la recreación van en la misma migración, que es atómica.

```sql
alter table technicians rename to employees;
alter table work_orders rename column technician_id to employee_id;

alter table employees drop column avatar_url;
alter table employees add column phone text;
-- Dar de baja sin borrar: el historial debe seguir diciendo quién hizo cada trabajo.
alter table employees add column active boolean not null default true;
-- El usuario con el que entra. Nulo mientras no tenga acceso.
alter table employees add column profile_id uuid unique references profiles(id) on delete set null;

alter index technicians_pkey rename to employees_pkey;
-- Renombrar la columna NO renombra la restricción: sin esto queda llamándose
-- work_orders_technician_id_fkey, y el traductor de errores de la Task 5 la
-- busca por nombre.
alter table work_orders
  rename constraint work_orders_technician_id_fkey to work_orders_employee_id_fkey;

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
```

- [ ] **Step 3: Verificar que no se perdió nada y que el portal público sigue vivo**

```sql
select (select count(*) from employees) as empleados,
       (select count(*) from work_orders where employee_id is not null) as ot_asignadas,
       (select count(*) from work_orders) as ot_total,
       (select employee_name from public.get_public_work_order(
          (select public_token from work_orders where employee_id is not null limit 1)
        )) as nombre_en_portal;
```

Esperado: `1 · 4 · 6 · Carlos Méndez`.

Si `nombre_en_portal` viene nulo, la función quedó mal armada: **parar y corregir antes de seguir**, porque son los links que ya se enviaron a clientes.

- [ ] **Step 4: Actualizar el código que nombraba al técnico**

En `src/lib/workOrders.ts`: `technicianName` pasa a `employeeName`, `technician_name` a `employee_name`, y el select `technician:technicians(name)` a `employee:employees(name)`. En `src/types.ts`, `technicianId` y `technicianName` pasan a `employeeId` y `employeeName`. En `src/pages/ClientPortal.tsx:184`, `order.technicianName` pasa a `order.employeeName`.

- [ ] **Step 5: Comprobar que no quedaron referencias**

```bash
grep -rn "technician" src/ && echo "QUEDAN REFERENCIAS" || echo "limpio"
```

Esperado: `limpio`. Después, `npx tsc --noEmit` sin errores.

- [ ] **Step 6: Registrar el esquema y commitear**

Crear `supabase/employees.sql` con el encabezado "⚠️ YA APLICADO" y el SQL del paso 2.

```bash
git add -A
git commit -m "Empleados: renombrar technicians y sumar vinculo con el usuario"
```

---

### Task 2: El filtro de las órdenes

**Files:**
- Migración: `employee_row_level_security`
- Modify: `supabase/employees.sql`

**Interfaces:**
- Consumes: tabla `employees` con `profile_id` y `active` (Task 1).
- Produces: `public.current_employee_id() returns uuid`, usada por las políticas de las tareas 3 y 4.

- [ ] **Step 1: Escribir la prueba que tiene que fallar**

Con el arnés del encabezado:

```sql
  select 'work_orders' as tabla, count(*) from work_orders
  union all select 'work_order_items', count(*) from work_order_items
  union all select 'work_order_status_history', count(*) from work_order_status_history;
```

- [ ] **Step 2: Correrla y confirmar que falla**

Esperado ahora: `work_orders = 6`. Como el operario todavía no está vinculado a ningún empleado, **después del cambio tiene que dar 0**, no 1: Carlos Méndez no tiene usuario asignado hasta la Task 9.

- [ ] **Step 3: Aplicar la migración**

```sql
-- Quién es el empleado que está mirando. Devuelve null si el usuario no está
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
```

- [ ] **Step 4: Correr la prueba de nuevo**

Esperado: las tres en `0`.

- [ ] **Step 5: Comprobar que el admin sigue viendo todo**

Mismo arnés pero con `tango.puntohogar@gmail.com`. Esperado: `work_orders = 6`.

Si el admin ve 0, `is_admin()` no está entrando: parar y revisar antes de seguir.

- [ ] **Step 6: Commitear**

```bash
git add -A
git commit -m "Empleados: cada uno ve solo las ordenes que tiene asignadas"
```

---

### Task 3: Clientes y vehículos, solo los de sus órdenes

**Files:**
- Migración: `employee_customers_vehicles_rls`
- Modify: `supabase/employees.sql`

**Interfaces:**
- Consumes: `current_employee_id()` (Task 2).

- [ ] **Step 1: Escribir la prueba que tiene que fallar**

```sql
  select 'customers' as tabla, count(*) from customers
  union all select 'vehicles', count(*) from vehicles;
```

- [ ] **Step 2: Correrla**

Esperado ahora: `customers = 5`, `vehicles` con todos los cargados. Después del cambio, ambas en `0`.

- [ ] **Step 3: Aplicar la migración**

```sql
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
```

- [ ] **Step 4: Verificar**

Esperado: ambas en `0` para el operario, sin cambios para el admin.

- [ ] **Step 5: Confirmar que el portal público del cliente NO se rompió**

Las políticas no lo afectan porque `get_public_work_order` es `security definer`, pero hay que comprobarlo y no suponerlo:

```sql
select customer_name, vehicle_model
from public.get_public_work_order((select public_token from work_orders limit 1));
```

Esperado: nombre del cliente y modelo del vehículo, no nulos.

- [ ] **Step 6: Commitear**

```bash
git add -A
git commit -m "Empleados: clientes y vehiculos limitados a los de sus ordenes"
```

---

### Task 4: Cerrar el resto de las tablas

Precios de compra, proveedores, cotizaciones y la cola de mensajes no son información de taller. Hoy el operario las lee todas.

**Files:**
- Migración: `employee_close_remaining_tables`
- Modify: `supabase/employees.sql`

- [ ] **Step 1: Verificar el supuesto que puede romper la pantalla de la orden**

**Este paso es obligatorio antes de tocar `articles`.** Si el detalle de una orden arma los renglones leyendo `articles`, cerrarle el acceso deja al operario con la pantalla vacía.

```bash
grep -n "articles" src/lib/workOrders.ts src/pages/WorkOrderDetails.tsx
```

Los renglones guardan `code` y `description` propios, así que no debería depender de `articles`. Si el `grep` muestra un join contra `articles` en la consulta del detalle, **no cerrar `articles`**: dejarla en `authenticated read` y anotarlo en el documento de diseño como pendiente.

- [ ] **Step 2: Escribir la prueba que tiene que fallar**

```sql
  select 'quotations' as tabla, count(*) from quotations
  union all select 'quotation_items', count(*) from quotation_items
  union all select 'suppliers', count(*) from suppliers
  union all select 'article_suppliers', count(*) from article_suppliers
  union all select 'price_imports', count(*) from price_imports
  union all select 'unmatched_supplier_prices', count(*) from unmatched_supplier_prices
  union all select 'notifications', count(*) from notifications
  union all select 'notification_templates', count(*) from notification_templates
  union all select 'app_settings', count(*) from app_settings
  union all select 'articles', count(*) from articles;
```

- [ ] **Step 3: Correrla**

Anotar los valores. Todos tienen que quedar en `0` después del cambio.

- [ ] **Step 4: Aplicar la migración**

```sql
-- Información comercial y de compras: no la necesita quien repara.
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

-- La cola guarda teléfonos de clientes y el texto de cada mensaje.
drop policy "authenticated read" on notifications;
create policy "solo admin" on notifications for select to authenticated using (is_admin());

drop policy "authenticated read" on notification_templates;
create policy "solo admin" on notification_templates for select to authenticated using (is_admin());

drop policy "authenticated read" on app_settings;
create policy "solo admin" on app_settings for select to authenticated using (is_admin());

-- Los renglones de la orden guardan código y descripción propios: el operario
-- no necesita el catálogo, que lleva costos y utilidad.
drop policy "authenticated read" on articles;
create policy "solo admin" on articles for select to authenticated using (is_admin());
```

Si el Step 1 encontró una dependencia real contra `articles`, omitir el último bloque.

`employees` conserva su política `authenticated read`: el nombre del empleado aparece en la orden y los compañeros se ven entre ellos.

- [ ] **Step 5: Verificar**

Correr de nuevo la consulta del Step 2 como operario. Esperado: todas en `0` (salvo `articles`, si el Step 1 obligó a dejarla abierta).

Y como admin: los valores originales, sin cambios.

- [ ] **Step 6: Commitear**

```bash
git add -A
git commit -m "Empleados: cerrar precios, cotizaciones y cola de mensajes al operario"
```

---

### Task 5: Capa de datos del ABM

**Files:**
- Create: `src/lib/employees.ts`

**Interfaces:**
- Produces:
  - `interface Employee { id: string; name: string; role: string | null; phone: string | null; active: boolean; profileId: string | null; email: string | null }`
  - `interface EmployeeInput { name: string; role: string; phone: string; active: boolean }`
  - `fetchEmployees(onlyActive?: boolean): Promise<Employee[]>`
  - `createEmployee(input: EmployeeInput): Promise<Employee>`
  - `updateEmployee(id: string, input: EmployeeInput): Promise<Employee>`
  - `deleteEmployee(id: string): Promise<void>`
  - `describeEmployeeError(message: string): string`

- [ ] **Step 1: Escribir el archivo**

Seguir el patrón de `src/lib/suppliers.ts` (85 líneas), que tiene exactamente esta forma: constante con el `select`, funciones `fetch`/`create`/`update`/`delete` que lanzan el error de Supabase, y un traductor de errores al final.

El `select` incluye el correo del usuario vinculado:

```ts
const SELECT = 'id, name, role, phone, active, profile_id, profile:profiles(email)';
```

`describeEmployeeError` traduce el error de clave foránea. Si una orden tiene al empleado asignado, el borrado lo rechaza la base:

```ts
export function describeEmployeeError(message: string): string {
  if (message.includes('work_orders_employee_id_fkey') || message.includes('foreign key')) {
    return 'No se puede eliminar: el empleado tiene órdenes asignadas. Es el registro ' +
      'de quién hizo cada trabajo. Marcalo como inactivo en lugar de borrarlo.';
  }
  return message;
}
```

- [ ] **Step 2: Verificar tipos**

```bash
npx tsc --noEmit
```

Esperado: sin errores.

- [ ] **Step 3: Commitear**

```bash
git add src/lib/employees.ts
git commit -m "Empleados: capa de datos del ABM"
```

---

### Task 6: Pantalla de empleados

**Files:**
- Create: `src/pages/Employees.tsx`
- Modify: `src/App.tsx`, `src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: todo lo de `src/lib/employees.ts` (Task 5).

- [ ] **Step 1: Escribir la pantalla**

Seguir `src/pages/Suppliers.tsx` como molde: `PageHeader`, `Panel`, tabla con `className="table-stack"` y atributos `data-label` en cada `td` para que se apile en el celular, formulario en panel lateral, y `fieldClass(true)` en los campos obligatorios.

Columnas: Nombre (con `data-primary`), Puesto, Teléfono, Usuario, Estado.

En la columna Usuario, cuando `profileId` es nulo mostrar **"Sin acceso"** en gris. Es un estado válido, no un error: el empleado puede recibir órdenes sin entrar al sistema.

- [ ] **Step 2: Agregar la ruta y el ítem de menú**

En `src/App.tsx`, junto a las otras rutas internas:

```tsx
<Route path="/empleados" element={<Employees />} />
```

En `src/components/Sidebar.tsx`, dentro del grupo `Padrones`, importando `HardHat` de lucide-react:

```tsx
{ icon: HardHat, label: 'Empleados', path: '/empleados', adminOnly: true },
```

- [ ] **Step 3: Verificar en el navegador**

Levantar el servidor con `preview_start`. Entrar como admin, ir a `/empleados`, comprobar que aparece Carlos Méndez con "Sin acceso". Crear un empleado de prueba, editarlo y borrarlo. Revisar la consola: sin errores.

- [ ] **Step 4: Verificar que el operario no puede entrar**

Iniciar sesión como `operario@gmail.com` y navegar a `/empleados` a mano. El ítem no debe aparecer en el menú, y la ruta debe redirigir, como hace `src/pages/Notifications.tsx:62`.

- [ ] **Step 5: Commitear**

```bash
git add -A
git commit -m "Empleados: pantalla del ABM"
```

---

### Task 7: Asignar el empleado a la orden

**Files:**
- Modify: `src/lib/workOrders.ts`, `src/pages/WorkOrderDetails.tsx`

**Interfaces:**
- Consumes: `fetchEmployees(true)` (Task 5).
- Produces: `assignEmployee(workOrderId: string, employeeId: string | null): Promise<void>`

- [ ] **Step 1: Agregar la función a `src/lib/workOrders.ts`**

```ts
/** Asignar o desasignar el empleado que hace el trabajo. */
export async function assignEmployee(workOrderId: string, employeeId: string | null) {
  const { error } = await supabase
    .from('work_orders')
    .update({ employee_id: employeeId })
    .eq('id', workOrderId);
  if (error) throw error;
}
```

- [ ] **Step 2: Agregar el selector en la pantalla de la orden**

Lista desplegable con los empleados activos (`fetchEmployees(true)`) más una opción vacía "Sin asignar". Solo visible para el admin.

- [ ] **Step 3: Verificar en el navegador**

Asignar un empleado a una orden, recargar y comprobar que quedó guardado.

- [ ] **Step 4: Verificar que el aviso al cliente sigue saliendo bien**

Cambiar el estado de esa orden y mirar la pantalla **Mensajes**: el aviso debe encolarse igual que antes. La asignación no debe alterar el texto del mensaje.

- [ ] **Step 5: Commitear**

```bash
git add -A
git commit -m "Empleados: asignar el empleado desde la orden de trabajo"
```

---

### Task 8: Alta de usuarios desde el servidor

Crear usuarios en Supabase Auth necesita la clave de servicio, que no puede estar en el navegador.

**Files:**
- Create: `supabase/functions/gestionar-empleado/index.ts`
- Deploy: función `gestionar-empleado` con `verify_jwt: true`

**Interfaces:**
- Produces: endpoint `POST /functions/v1/gestionar-empleado` con dos acciones:
  - `{ accion: 'crear', employeeId, usuario, password }` — crea el usuario, le deja rol `operario` y lo vincula
  - `{ accion: 'clave', employeeId, password }` — cambia la contraseña

- [ ] **Step 1: Escribir la función**

Modelar sobre `supabase/functions/despachar-whatsapp/index.ts`, con dos diferencias importantes:

- `verify_jwt: true`, al revés que el despachador, que lo tiene en `false` porque lo llama el cron sin sesión. Acá **sí** hay sesión.
- Antes que nada, comprobar que quien llama es admin. Sin esa comprobación, cualquier operario con sesión podría fabricarse usuarios:

```ts
const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
const { data: { user } } = await db.auth.getUser(token);
const { data: perfil } = await db.from('profiles').select('role').eq('id', user?.id ?? '').single();
if (perfil?.role !== 'admin') {
  return new Response('No autorizado', { status: 403 });
}
```

El identificador se arma como `<usuario>@taller.local` cuando no trae arroba, así el empleado no necesita casilla de correo. El alta usa `db.auth.admin.createUser({ email, password, email_confirm: true })`, y después escribe `profile_id` en la fila del empleado.

- [ ] **Step 2: Desplegar y comprobar que rechaza a quien no es admin**

Llamarla con el token de `operario@gmail.com`. Esperado: **403**.

Esta prueba es obligatoria: es la única barrera que impide que un empleado se fabrique usuarios.

- [ ] **Step 3: Comprobar que crea el usuario siendo admin**

Llamarla con el token del admin y verificar:

```sql
select e.name, p.email, p.role
from employees e join profiles p on p.id = e.profile_id;
```

Esperado: el empleado con su correo y rol `operario`.

- [ ] **Step 4: Commitear**

```bash
git add -A
git commit -m "Empleados: alta de usuarios desde el servidor"
```

---

### Task 9: Cerrar el circuito y verificar de punta a punta

**Files:**
- Modify: `src/lib/employees.ts`, `src/pages/Employees.tsx`

**Interfaces:**
- Consumes: el endpoint de la Task 8.
- Produces: `darAcceso(employeeId: string, usuario: string, password: string): Promise<void>` y `cambiarClave(employeeId: string, password: string): Promise<void>` en `src/lib/employees.ts`.

- [ ] **Step 1: Agregar el alta de acceso en la pantalla**

En la ficha del empleado, cuando no tiene usuario: campos de usuario y contraseña inicial, y un botón "Dar acceso" que llama a la función de la Task 8. Cuando ya tiene: un botón "Cambiar contraseña".

- [ ] **Step 2: Explicar la lista vacía en la vista del operario**

En la lista de órdenes, cuando el usuario es operario y no hay ninguna fila, el mensaje no puede ser el genérico. Dos casos distintos, dos mensajes:

- Sin órdenes asignadas: «No tenés órdenes asignadas. El encargado del taller te las asigna desde la orden de trabajo.»
- Usuario sin empleado vinculado, o empleado dado de baja: «Tu usuario no está vinculado a ningún empleado activo. Pedile al administrador que lo revise.»

Sin esto, un empleado dado de baja ve una lista vacía sin ningún motivo y parece que el sistema falla.

Para distinguir los casos alcanza con consultar si el usuario tiene empleado activo:

```ts
const { data } = await supabase.rpc('current_employee_id');
const vinculado = data !== null;
```

Requiere que `current_employee_id()` sea invocable por `authenticated`, que es el comportamiento por defecto y no hace falta tocar.

- [ ] **Step 3: Crear el acceso de Carlos Méndez**

Desde la pantalla, con usuario `carlos` y una contraseña de prueba.

- [ ] **Step 4: La prueba que cierra todo**

Cerrar sesión, entrar como `carlos` y comprobar:

- Ve **solo las 4 órdenes** que tiene asignadas, no las 6
- Al abrir una, ve sus renglones y el cliente
- **No** aparecen en el menú: Clientes, Vehículos, Proveedores, Inventario, Listas de Precios, Mensajes ni Empleados
- No puede cambiar el estado de una orden

- [ ] **Step 5: La misma prueba, pero contra la base**

La interfaz puede esconder cosas que la API sigue entregando. Con el arnés del encabezado, usando el correo de Carlos:

```sql
  select 'work_orders' as tabla, count(*) from work_orders
  union all select 'customers', count(*) from customers
  union all select 'quotations', count(*) from quotations
  union all select 'article_suppliers', count(*) from article_suppliers
  union all select 'notifications', count(*) from notifications;
```

Esperado: `4 · 1 · 0 · 0 · 0`.

`customers = 1` si las 4 órdenes de Carlos son del mismo cliente. Antes de dar por buena la prueba, confirmar el número con:

```sql
select count(distinct customer_id) from work_orders
where employee_id = (select id from employees where name = 'Carlos Méndez');
```

- [ ] **Step 6: Comprobar que no se rompió lo que ya andaba**

- El admin sigue viendo las 6 órdenes y todas las pantallas
- Un link de seguimiento abierto sin sesión muestra el nombre del empleado
- La cola de mensajes sigue despachando

- [ ] **Step 7: Commitear y actualizar el documento de diseño**

Anotar en el documento el resultado de la verificación del Step 1 de la Task 4: si `articles` quedó cerrada o si hubo que dejarla abierta.

```bash
git add -A
git commit -m "Empleados: dar acceso desde la ficha y verificacion completa"
```
