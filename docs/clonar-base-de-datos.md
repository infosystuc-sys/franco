# Clonar la base de datos de DieselPro a otro proyecto de Supabase

Este documento es para que **otra conversación de Claude Code**, con acceso al MCP de
Supabase de un proyecto **nuevo y vacío** (puede ser de otra cuenta), recree ahí la
misma estructura que tiene hoy este proyecto (`mnoqdqjhsylohlvuekfh`).

**Qué clona:** esquema completo — tablas, tipos, restricciones, índices, funciones,
triggers, políticas de RLS, permisos, buckets de Storage y la tarea programada —
más los datos de configuración que el propio código da por sentados (los estados de
la OT, sus plantillas de WhatsApp, las alícuotas de IVA).

**Qué NO clona, a propósito:** los datos de negocio (clientes, vehículos, órdenes,
facturas, comprobantes reales) ni la identidad fiscal de este taller
(`company_settings`, bancos, medios de pago). Es un clon de la *estructura*, para
arrancar un proyecto nuevo — no un backup completo. Si además hace falta copiar
datos de negocio, es un paso aparte (ver el final de este documento).

Generado el 14/09/2026 por introspección directa de la base viva (`pg_catalog` /
`information_schema`), no a partir de los archivos `supabase/*.sql` del repo: este
proyecto tiene **108 migraciones** aplicadas a lo largo de su historia y el repo solo
guarda los `.sql` de las funcionalidades más recientes — los primeros dos tercios de
la historia (tablas base, RLS, etc.) se armaron en sesiones anteriores sin dejar un
archivo local equivalente. Por eso el volcado de acá es la única fuente completa y
confiable.

## Los archivos

Están en `supabase/clone-completo/`, numerados en el orden en que hay que correrlos
(cada uno depende del anterior: los tipos antes que las tablas que los usan, las
tablas antes que sus restricciones, etc.):

| Archivo | Contenido |
|---|---|
| `01-tables.sql` | Las 66 tablas de `public`, solo columnas (sin restricciones ni índices) |
| `02-enums.sql` | Los 23 tipos `ENUM` que usan las tablas |
| `03-constraints.sql` | Claves primarias, únicas, foráneas y `CHECK` |
| `04-sequences.sql` | Las 3 secuencias de numeración (OT, cotización, ingreso) |
| `05-indexes.sql` | Índices que no vienen ya de una restricción |
| `06-functions.sql` | Las 112 funciones (`plpgsql`), con `CREATE OR REPLACE` |
| `07-triggers.sql` | Los 26 triggers sobre tablas de `public` |
| `08-policies.sql` | `ENABLE ROW LEVEL SECURITY` + las 160 políticas de RLS |
| `09-grants.sql` | Permisos de `EXECUTE` por función y rol, y los `REVOKE` de las tablas de credenciales |
| `10-seed-config.sql` | Estados de la OT, plantillas de mensaje, alícuotas de IVA, preferencias |
| `11-storage.sql` | Los 4 buckets privados y sus políticas |
| `12-cron.sql` | La tarea de `pg_cron` que despacha WhatsApp cada minuto |

## Cómo correrlo

Con el MCP de Supabase apuntando al proyecto **nuevo**, aplicar cada archivo en
orden con `apply_migration` (un nombre de migración por archivo, por ejemplo
`clone_01_tables`, `clone_02_enums`, …). Después de cada uno, `list_tables` o
`get_advisors` para confirmar que no quedó nada roto antes de seguir con el
siguiente — más fácil encontrar el problema en el archivo que lo causó que al
final de los doce.

No hace falta instalar extensiones a mano: `pgcrypto`, `pg_net`, `pg_cron` y
`supabase_vault` (los cuatro que usa este esquema, fuera de `plpgsql`) vienen
habilitados por default en cualquier proyecto nuevo de Supabase.

## Editar antes de correr (o inmediatamente después)

Tres cosas del volcado están escritas a fuego con datos **de este proyecto en
particular** — si no se tocan, el proyecto nuevo termina hablándole al viejo:

1. **`despachar_whatsapp()` y `diagnosticar_whatsapp()`**, dentro de
   `06-functions.sql`: tienen la URL
   `https://mnoqdqjhsylohlvuekfh.supabase.co/functions/v1/despachar-whatsapp`
   escrita literal. Antes de correr ese archivo (o con un `CREATE OR REPLACE`
   después), cambiarla por la URL del proyecto nuevo.
2. **El secreto `cron_secret` en Vault.** Esas mismas dos funciones leen
   `vault.decrypted_secrets where name = 'cron_secret'` y lo mandan como header
   `x-cron-secret` a la Edge Function. Sin este secreto cargado en el proyecto
   nuevo, el cron corre pero no manda nada (la función avisa con `RAISE WARNING`
   y no falla). Se crea con:
   ```sql
   select vault.create_secret('un-secreto-cualquiera-largo', 'cron_secret');
   ```
   El mismo valor tiene que quedar como variable de entorno `CRON_SECRET` de la
   Edge Function `despachar-whatsapp` en el proyecto nuevo (ver más abajo).
3. **`public_base_url` en `app_settings`** (ya viene en `10-seed-config.sql` como
   placeholder): es la URL pública del frontend, la que se arma en los links de
   seguimiento que recibe el cliente. Cambiarla por la URL real una vez que el
   frontend esté desplegado.

## Lo que el esquema por sí solo no resuelve

### 1. Los usuarios (`auth.users` / `profiles`)

`profiles` tiene una fila por usuario de `auth.users` (la crea sola el trigger
`on_auth_user_created` → `handle_new_user()`, ya incluido en `06-functions.sql`
y `07-triggers.sql` — ver comentario en la nota del trigger, vive en `auth`, no
en `public`). Para el primer admin:

1. Crear el usuario por el dashboard de Supabase (Authentication → Users →
   Add user) o con `auth.users` desde el MCP.
2. El trigger le crea el `profiles` solo, con `role = 'operario'` por default.
3. Subirlo a admin:
   ```sql
   update public.profiles set role = 'admin', position = 'dueño' where email = 'el-mail-del-admin';
   ```

### 2. Las Edge Functions

El esquema SQL no incluye las Edge Functions — son código TypeScript aparte, en
`supabase/functions/` de este mismo repo. Si la otra conversación tiene acceso a
este repositorio, son cinco carpetas para desplegar tal cual con
`deploy_edge_function` contra el proyecto nuevo:

| Función | Qué hace | Variables de entorno que necesita |
|---|---|---|
| `despachar-whatsapp` | Cron: manda los mensajes de WhatsApp pendientes | `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `CRON_SECRET` (el mismo valor que `cron_secret` en Vault) |
| `enviar-factura` | Botón "Enviar por mail / WhatsApp" de facturas, cotizaciones y órdenes de pago | las tres de Evolution de arriba (para WhatsApp); Gmail se configura desde la propia app |
| `gestionar-empleado` | Alta de usuarios, cambio de contraseña y de cargo | ninguna extra (usa `SUPABASE_SERVICE_ROLE_KEY`, que Supabase inyecta solo) |
| `extraer-factura-compra` | Lee facturas de compra con IA | la clave de IA se carga desde Configuración → no hace falta variable de entorno si se va a usar así; si se prefiere una clave de respaldo del lado del servidor, hay que agregarla a mano |
| `consultar-padron` | Trae datos de ARCA por CUIT/DNI al dar de alta un cliente o proveedor | ninguna — el certificado se carga desde Configuración → Certificados de ARCA, ya en la base (tabla `arca_credentials`) |

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase solo en cada
función; no hace falta configurarlos.

### 3. Los secretos que no viajan con la base

Estas tablas quedan creadas y vacías (**a propósito**: son RLS sin policies,
solo el `service_role` las lee — ver el punto de seguridad más abajo). Hay que
cargarlas desde la app una vez que el frontend esté corriendo, o van quedando
vacías hasta que se necesiten:

- `ai_credentials` — clave de Gemini o Claude, desde Configuración.
- `arca_credentials` — certificado de ARCA (`.crt` + `.key`), desde
  Configuración → Certificados de ARCA. Ver `docs/clonar-base-de-datos.md`
  §"Editar antes de correr" si hace falta reusar el mismo certificado de
  padrón: es válido para cualquier proyecto, no está atado a este.
- La credencial de Gmail para mandar mail (RPC `set_gmail_credential`, desde
  Configuración).

### 4. Aviso de seguridad — `remito_sequences` sin RLS

El asesor de seguridad de Supabase marca que **`public.remito_sequences` tiene
RLS desactivado** en la base original: cualquiera con la `anon key` puede leer
o escribir esa tabla directamente. `08-policies.sql` reproduce ese mismo
estado tal cual (es un clon fiel), con una nota en el propio archivo. Si se
quiere partir ya corregido en el proyecto nuevo:

```sql
ALTER TABLE public.remito_sequences ENABLE ROW LEVEL SECURITY;
-- Sin ninguna policy, la tabla queda ilegible hasta para admin. Agregar, por
-- ejemplo, el mismo patrón que remito_items o remitos ("solo admin" + RPC).
CREATE POLICY "solo admin" ON public.remito_sequences
  FOR SELECT TO authenticated USING (is_admin());
```

Esto no se corrigió en la base original en esta sesión porque cambiar RLS de
una tabla en producción no es una acción que se aplique sin que el dueño del
proyecto lo decida — queda pendiente ahí también si se quiere avisar.

### 5. `whatsapp_enabled` empieza en `false`

A diferencia de la base original (donde está en `true`, mandando WhatsApp real
a cada cambio de estado), `10-seed-config.sql` lo deja en `false` y
`whatsapp_test_mode` en `true` a propósito: un proyecto recién clonado no
debería mandar mensajes reales hasta que alguien revise la configuración de
Evolution y lo prenda a mano desde Configuración.

## Catálogos que se completan desde la propia app

No están en el volcado porque son un par de clics en pantallas ya construidas
para eso, no ameritan SQL: **datos fiscales del taller** (Configuración),
**bancos** (Tesorería → Bancos), **medios de pago** (Tesorería → Medios de
pago), **conceptos de gasto** (Tesorería → Conceptos), **tipos de pieza**
(se cargan solos la primera vez que se usan, igual que marcas y modelos de
vehículo).

## Si además hace falta copiar datos de negocio

Este documento clona la estructura. Si el proyecto nuevo necesita además los
datos reales de clientes, vehículos, órdenes, facturas, etc. — no solo la
forma de las tablas — es un paso aparte: exportar cada tabla con `COPY` o
`pg_dump --data-only --table=...` (respetando el orden de dependencias, igual
que estos archivos) e importarla en el proyecto nuevo. Avisá si hace falta y
se arma esa parte también; adrede no se incluyó datos reales de clientes
(teléfonos, CUIT) en este documento sin que se pida explícitamente.
