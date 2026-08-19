# Empleados del taller: asignación de órdenes y acceso restringido

**Fecha:** 19 de agosto de 2026
**Estado:** aprobado, pendiente de plan de implementación

## Qué se pide

Un ABM de empleados del taller. A ellos se les asignan las órdenes de trabajo, y
cada uno debe poder consultar únicamente las suyas.

## Punto de partida

Parte del trabajo ya está hecho, heredado del prototipo de Google AI Studio:

- Existe la tabla `technicians` (`name`, `role`, `avatar_url`), con una fila.
- `work_orders.technician_id` ya apunta ahí, y **4 de las 6 órdenes actuales
  están asignadas**.
- El código lee el nombre del técnico —el portal del cliente muestra
  "Sin asignar"— pero ninguna pantalla permite asignarlo.

Lo que no existe es la conexión con los usuarios: `profiles` (quién inicia
sesión) y `technicians` (quién trabaja) son tablas que hoy no se conocen.

## Decisiones

| Decisión | Por qué |
|---|---|
| Un usuario por empleado | El filtro lo aplica la base mirando `auth.uid()`. Con un usuario compartido no puede distinguir a un empleado de otro. |
| Se mantienen dos roles: `admin` y `operario` | `operario` pasa a significar "empleado del taller": ve solo lo asignado. No quedan roles sin uso. |
| Una orden, un empleado | Es lo que ya soporta el esquema y lo habitual en un taller. |
| El empleado solo consulta | No cambia estados ni edita. |
| Ficha mínima | Nombre, puesto, teléfono y estado. Los datos laborales viven en el sistema de sueldos; duplicarlos obliga a mantenerlos en dos lados. |
| Se renombra `technicians` a `employees` | Si la pantalla dice "Empleados" y la base dice "técnicos", dentro de seis meses eso confunde. |

### Por qué no un usuario genérico

Se evaluó que los empleados entraran con un usuario compartido de Supabase y se
identificaran después contra una tabla propia. **No funciona**, y conviene dejar
registrado el motivo:

- El filtro pasaría a ser una decisión de la pantalla y no de la base. La clave
  anónima de Supabase está a la vista en el JavaScript de la app —eso es así por
  diseño—, así que con el usuario genérico cualquier empleado puede pedir un
  token y consultar la API directamente, salteando la app.
- Guardar contraseñas propias obliga a reimplementar hasheo, límite de intentos
  y recuperación de clave. Supabase Auth ya lo hace bien.
- Con usuario compartido se pierde el registro de quién hizo cada cosa.

Lo que sí se toma de esa idea es la simplicidad para el empleado: **no necesita
casilla de correo**. Supabase pide un mail como identificador, pero puede ser
interno (`carlos@taller.local`), y la pantalla de ingreso puede pedir solo el
nombre de usuario y completar el resto.

## Modelo de datos

`technicians` → `employees`, y `work_orders.technician_id` → `employee_id`.

| Campo | |
|---|---|
| `name` | ya existe |
| `role` | ya existe — puesto o especialidad |
| `phone` | nuevo |
| `active` | nuevo — dar de baja sin borrar el historial de quién hizo cada trabajo |
| `profile_id` | nuevo — el usuario con el que entra, único, `on delete set null` |
| ~~`avatar_url`~~ | se elimina, nunca se usó |

El renombre alcanza a `get_public_work_order`, que está en producción sirviendo
los links de seguimiento. Se actualiza en la misma migración.

## Permisos

Este es el grueso del trabajo, y es mayor de lo que aparenta.

Hoy **las 17 tablas tienen la misma política**: `authenticated read` con
`using (true)`. Cualquier usuario con sesión lee todo. Restringir solo
`work_orders` no serviría de nada: al operario le alcanzaría con pegarle a la
API para leer los precios de compra, los proveedores, las cotizaciones y la cola
de mensajes con los teléfonos de los clientes.

El filtro se apoya en una función nueva, hermana de `is_admin()`:

```sql
create or replace function public.current_employee_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from employees where profile_id = auth.uid() and active;
$$;
```

Qué ve cada rol:

| Tabla | admin | operario |
|---|---|---|
| `work_orders` | todo | solo las asignadas a él |
| `work_order_items` | todo | solo las de sus órdenes |
| `work_order_status_history` | todo | solo las de sus órdenes |
| `customers`, `vehicles` | todo | solo los que aparecen en sus órdenes |
| `employees` | todo | nombre y puesto (necesita ver a sus compañeros) |
| `quotations`, `quotation_items` | todo | nada — información comercial |
| `articles` | todo | nada — los renglones ya guardan código y descripción |
| `suppliers`, `article_suppliers` | todo | nada — precios de compra |
| `price_imports`, `unmatched_supplier_prices` | todo | nada |
| `notifications`, `notification_templates` | todo | nada — teléfonos y textos |
| `app_settings` | todo | nada |
| `profiles` | el propio | el propio |

**A verificar durante la implementación:** que la pantalla de detalle de una
orden no dependa de `articles` para mostrar los renglones. Los renglones guardan
código y descripción propios, así que no debería, pero hay que comprobarlo antes
de cerrarle el acceso.

## Alta de empleados

Crear usuarios de Supabase Auth necesita la clave de servicio, que no puede
estar en el navegador. Lo resuelve una función del lado del servidor, igual que
el despachador de WhatsApp: la clave vive ahí y nunca la toca el cliente.

Desde el ABM, el admin carga nombre, puesto, teléfono, usuario y contraseña
inicial. La función crea el usuario en Auth, le deja rol `operario` en
`profiles` y lo vincula al empleado. Un solo formulario.

También hace falta poder **cambiar la contraseña** de un empleado que la olvidó,
por la misma vía.

## Pantallas

- **`/empleados`** — ABM nuevo, solo admin, siguiendo el patrón de Clientes y
  Proveedores. Va en el menú bajo "Padrones".
- **Orden de trabajo** — selector de empleado en el formulario. Hoy el campo
  existe en la base y no hay forma de cargarlo.
- **Vista del operario** — no necesita cambios: la lista le llega recortada
  desde la base. Sí un mensaje claro cuando no tiene ninguna asignada.

## Migración de los datos actuales

Carlos Méndez (Técnico Senior) pasa a ser empleado activo, sin usuario vinculado
hasta que se le asigne uno. Las 4 órdenes que ya lo tienen asignado conservan la
asignación.

## Riesgos

**Cerrar el acceso puede romper pantallas que hoy funcionan.** Es el riesgo
principal: alguna consulta puede depender de una tabla que el operario deja de
ver. Se prueba cada pantalla con un usuario operario real, no solo con admin.

**Un empleado sin `profile_id` no puede entrar.** Es correcto —Carlos queda así
tras la migración— pero la pantalla debe mostrarlo con claridad y no como si
fuera un error.

**`current_employee_id()` devuelve null si el empleado está inactivo**, y
entonces no ve ninguna orden. Es lo buscado al dar de baja a alguien, pero hay
que comprobar que la pantalla lo explique en vez de mostrar una lista vacía sin
motivo.

## Fuera de alcance

Varios empleados por orden. Que el empleado cambie estados. Legajo laboral
(DNI, CUIL, ingreso, dirección). Registro de horas trabajadas. Que el empleado
vea las cotizaciones.
