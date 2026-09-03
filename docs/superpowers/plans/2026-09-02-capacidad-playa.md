# Capacidad de recepción de la playa — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saber cuántos vehículos más entran en la playa, hoy y en los próximos días, con un cupo por tamaño que se descuenta con cada ingreso y cada OT confirmada.

**Architecture:** La ocupación no se guarda: se calcula leyendo `vehicle_intakes` sin OT más `work_orders` cuyo estado no libera la playa, y cada vehículo descuenta del cupo de su `size_class`. Un módulo nuevo (`src/lib/yardCapacity.ts`) concentra ese cálculo y reemplaza a `src/lib/shopCapacity.ts`, que repartía por sector del empleado. La proyección sale de `estimated_delivery_date` más un margen configurable.

**Tech Stack:** React 19 + TypeScript + Vite, Supabase (Postgres + RLS), Tailwind. Sin test runner: la verificación es `npx tsc --noEmit`, `npm run build`, SQL contra la base real y prueba manual con Playwright.

**Spec:** [`docs/superpowers/specs/2026-09-02-capacidad-playa-design.md`](../specs/2026-09-02-capacidad-playa-design.md)

## Global Constraints

- **Todo ocupa playa.** Ningún cálculo de ocupación puede mirar `employees.workplace` ni el empleado asignado a la OT.
- **Tamaños:** exactamente `CHICO`, `MEDIANO`, `GRANDE`. En la UI: `Chico`, `Mediano`, `Grande`.
- **Default de tamaño por tipo:** `CAMION`→GRANDE, `MAQUINARIA`→GRANDE, `AGRICOLA`→GRANDE, `EMBARCACION`→MEDIANO, `OTRO`→MEDIANO, `GENERADOR`→CHICO.
- **`is_terminal` no se toca.** "Retirado" se agrega como estado terminal *adicional*; "Terminado" sigue siendo terminal y sigue habilitando facturar.
- **La regla de liberación no se ata al nombre del estado:** se usa la columna `frees_yard`, nunca `label = 'Retirado'`.
- **Cupo sembrado en cero.** `yard_capacity` arranca con 0 en los tres tamaños: cero significa "no configurado".
- **El aviso de falta de lugar no bloquea.** El alta de ingreso avisa y deja continuar siempre.
- **Todo el texto de UI y los comentarios de código van en español**, siguiendo el estilo del repo (comentarios que explican el *por qué*, no el *qué*).
- **Proyecto Supabase:** `mnoqdqjhsylohlvuekfh`. Las migraciones se aplican con la herramienta MCP `apply_migration` y además se guardan como archivo en `supabase/`.
- **Verificación de cada tarea:** `npx tsc --noEmit` tiene que pasar sin salida antes de cada commit.

## Rulings tomados al escribir el plan

Tres puntos donde el spec dejaba margen, resueltos acá para que nadie los adivine:

1. **RLS de `yard_capacity`: lectura solo admin.** El spec pedía "lectura para cualquier usuario autenticado" justificándolo con "la pantalla de ingreso la consulta" — pero esa pantalla (`/ingresos`) es `adminOnly` en [`menuCategories.ts:96`](../../../src/lib/menuCategories.ts), igual que `/disponibilidad-taller`. Se deja solo admin, consistente con `workplace_capacity`. Si mañana un operario tiene que ver el cupo, se afloja la policy en una línea.
2. **La ruta y la etiqueta del menú no cambian.** Sigue siendo "Disponibilidad del taller" en `/disponibilidad-taller`: las rutas se guardan en Favoritos (`src/lib/favorites.ts`) y renombrarlas rompería los favoritos ya guardados. Cambia el subtítulo de la pantalla, que hoy dice "por sector" y dejaría de ser cierto.
3. **`size_class` es `text` con check, no un enum.** Es la columna hermana de `vehicles.vehicle_type`, que es `text` con check. Se copia esa convención en vez de introducir un enum al lado.

---

### Task 1: Migración de base

Toda la estructura nueva en una sola migración: sin ella ninguna otra tarea compila contra la base.

**Files:**
- Create: `supabase/yard-capacity.sql`
- Apply: herramienta MCP `apply_migration`, proyecto `mnoqdqjhsylohlvuekfh`, nombre `yard_capacity`

**Interfaces:**
- Consumes: nada (primera tarea).
- Produces: columna `vehicles.size_class` (text, not null, default `'MEDIANO'`, check en CHICO/MEDIANO/GRANDE); tabla `yard_capacity(size_class text pk, capacity int not null default 0, updated_at timestamptz)`; columna `work_order_statuses.frees_yard` (boolean not null default false); estado "Retirado"; valor `CERRADO` en el enum `vehicle_intake_status`; columna `company_settings.yard_pickup_grace_days` (int not null default 2).

- [ ] **Step 1: Escribir la migración**

Crear `supabase/yard-capacity.sql` con este contenido exacto:

```sql
-- ===========================================================================
-- Capacidad de recepción de la playa
-- ===========================================================================
-- Migración: yard_capacity
--
-- Reemplaza el cupo por sector (workplace_capacity, que repartía las OT según
-- el sector del empleado asignado) por un cupo de playa por tamaño de
-- vehículo. Dónde está parado un vehículo no depende de quién lo atiende: con
-- la regla vieja, una OT sin empleado no ocupaba nada y reasignar un mecánico
-- "movía" un camión de lugar sin que nadie lo tocara.
--
-- Las filas de laboratorio de workplace_capacity se dejan donde están, sin
-- uso: borrarlas perdería un dato que el taller ya cargó.

-- 1) Tamaño del vehículo -----------------------------------------------------
-- text con check, no enum: es la columna hermana de vehicles.vehicle_type,
-- que ya se modela así.
alter table public.vehicles
  add column size_class text not null default 'MEDIANO'
  check (size_class in ('CHICO', 'MEDIANO', 'GRANDE'));

-- Los vehículos ya cargados toman el tamaño típico de su tipo. Queda
-- editable por vehículo: "Camión / Utilitario" mete en la misma bolsa una
-- Transit y un Scania.
update public.vehicles set size_class = case vehicle_type
  when 'CAMION'      then 'GRANDE'
  when 'MAQUINARIA'  then 'GRANDE'
  when 'AGRICOLA'    then 'GRANDE'
  when 'EMBARCACION' then 'MEDIANO'
  when 'GENERADOR'   then 'CHICO'
  else 'MEDIANO'
end;

-- 2) Cupo de la playa por tamaño ---------------------------------------------
create table public.yard_capacity (
  size_class text primary key check (size_class in ('CHICO', 'MEDIANO', 'GRANDE')),
  capacity integer not null default 0,
  updated_at timestamptz not null default now()
);

create trigger yard_capacity_set_updated_at
before update on public.yard_capacity
for each row execute function set_updated_at();

alter table public.yard_capacity enable row level security;

create policy "solo admin" on public.yard_capacity for select using (is_admin());
create policy "admin insert" on public.yard_capacity for insert with check (is_admin());
create policy "admin update" on public.yard_capacity for update using (is_admin()) with check (is_admin());

-- Sembrado en cero: cero significa "todavía nadie lo configuró". Sembrar un
-- número inventado haría que la pantalla afirme algo que nadie decidió.
insert into public.yard_capacity (size_class, capacity) values
  ('CHICO', 0), ('MEDIANO', 0), ('GRANDE', 0);

-- 3) Qué estado libera la playa ----------------------------------------------
-- La regla no se ata al nombre: los estados son un ABM del usuario, y
-- renombrar "Retirado" romperia una regla basada en el texto. Se marca con
-- una columna, igual que is_initial e is_terminal.
alter table public.work_order_statuses
  add column frees_yard boolean not null default false;

-- "Retirado" es terminal ADEMÁS de "Terminado", no en su lugar: is_terminal
-- es lo que habilita facturar la OT, y un taller factura para que el cliente
-- se lleve el vehículo, no después.
insert into public.work_order_statuses
  (label, client_description, color, sort_order, active, is_initial, is_terminal, notifies_client, frees_yard)
values
  ('Retirado', 'El vehículo fue retirado del taller.', '#5b6470', 6, true, false, true, false, true);

-- Las OT ya terminadas son historia previa a esta función y sus vehículos no
-- están en el taller. Sin este paso pasarían a contar como presentes y la
-- ocupación arrancaría en 19 en vez de 11. Los dos estados son terminales,
-- así que esto no cambia si esas OT se pueden facturar.
update public.work_orders
set status_id = (select id from public.work_order_statuses where label = 'Retirado')
where status_id = (select id from public.work_order_statuses where label = 'Terminado');

-- 4) Cierre del ingreso que no llega a OT ------------------------------------
-- Si el cliente rechaza el presupuesto y se lleva el vehículo, hoy no hay
-- forma de registrarlo: ese ingreso ocuparía lugar para siempre.
alter type public.vehicle_intake_status add value 'CERRADO';

-- 5) Margen de retiro ---------------------------------------------------------
-- Casi nadie retira el mismo día que termina. Sin margen, la pantalla promete
-- lugar que no va a haber.
alter table public.company_settings
  add column yard_pickup_grace_days integer not null default 2;
```

- [ ] **Step 2: Aplicar la migración**

Aplicarla con la herramienta MCP `apply_migration` (proyecto `mnoqdqjhsylohlvuekfh`, name `yard_capacity`) pasando el contenido del archivo.

**Cuidado con el paso 4:** `alter type ... add value` no puede *usarse* en la misma transacción en que se declara. La migración solo lo declara (no marca ningún ingreso como `CERRADO`), así que pasa. Si el servidor igual lo rechaza, aplicar ese `alter type` como una migración propia llamada `yard_capacity_intake_cerrado` y el resto en la principal.

- [ ] **Step 3: Verificar la estructura**

Ejecutar con la herramienta MCP `execute_sql`:

```sql
select
  (select count(*) from public.yard_capacity) as cupos,
  (select count(*) from public.work_order_statuses where frees_yard) as estados_liberan,
  (select count(*) from public.vehicles where size_class = 'GRANDE') as vehiculos_grandes,
  (select yard_pickup_grace_days from public.company_settings) as margen,
  (select count(*) from public.work_orders w
     join public.work_order_statuses s on s.id = w.status_id
   where s.label = 'Terminado') as ot_terminado_restantes;
```

Esperado exactamente: `cupos = 3`, `estados_liberan = 1`, `vehiculos_grandes = 8`, `margen = 2`, `ot_terminado_restantes = 0`.

Los 8 vehículos cargados son 6 camiones, 4 agrícolas y 1 maquinaria vial repartidos entre 8 fichas, todos GRANDE por tipo. Si `vehiculos_grandes` no da 8, el `update` del paso 1 no corrió.

- [ ] **Step 4: Verificar la ocupación que va a quedar**

```sql
with con_ot as (
  select quotation_id from public.work_orders where quotation_id is not null
),
ingresos as (
  select i.id from public.vehicle_intakes i
  where i.status::text <> 'CERRADO'
    and (i.quotation_id is null or i.quotation_id not in (select quotation_id from con_ot))
),
ordenes as (
  select w.id from public.work_orders w
  join public.work_order_statuses s on s.id = w.status_id
  where s.frees_yard = false
)
select (select count(*) from ingresos) as ingresos_sin_ot,
       (select count(*) from ordenes) as ot_ocupando,
       (select count(*) from ingresos) + (select count(*) from ordenes) as total;
```

Esperado: `ingresos_sin_ot = 8`, `ot_ocupando = 3`, `total = 11`.

Si `total` da 19, la migración de las OT terminadas no corrió.

- [ ] **Step 5: Commit**

```bash
git add supabase/yard-capacity.sql
git commit -m "Capacidad de playa: estructura de base (tamaño, cupo, Retirado, cierre de ingreso)"
```

---

### Task 2: Tamaño en la ficha del vehículo

Sin esto el cupo por tamaño no tiene de dónde leer el tamaño.

**Files:**
- Modify: `src/lib/vehicles.ts`
- Modify: `src/components/VehicleModal.tsx`
- Modify: `src/lib/customers.ts`

**Interfaces:**
- Consumes: columna `vehicles.size_class` (Task 1).
- Produces: `SizeClass`, `SIZE_CLASS_LABELS`, `SIZE_CLASSES`, `SIZE_BY_VEHICLE_TYPE` exportados desde `src/lib/vehicles.ts`; `Vehicle.sizeClass: SizeClass`; `VehicleInput.sizeClass: SizeClass`; `CustomerVehicle.sizeClass: SizeClass`.

- [ ] **Step 1: Agregar el tipo y el default por tipo**

En `src/lib/vehicles.ts`, después del bloque de `VEHICLE_TYPES` (línea 20):

```ts
export type SizeClass = 'CHICO' | 'MEDIANO' | 'GRANDE';

export const SIZE_CLASS_LABELS: Record<SizeClass, string> = {
  CHICO: 'Chico',
  MEDIANO: 'Mediano',
  GRANDE: 'Grande',
};

export const SIZE_CLASSES = Object.keys(SIZE_CLASS_LABELS) as SizeClass[];

/**
 * Tamaño que se propone al elegir el tipo. Es solo el punto de partida: el
 * tipo no dice cuánto lugar ocupa el vehículo — "Camión / Utilitario" mete en
 * la misma bolsa una Transit y un Scania — así que el campo queda editable.
 */
export const SIZE_BY_VEHICLE_TYPE: Record<VehicleType, SizeClass> = {
  CAMION: 'GRANDE',
  MAQUINARIA: 'GRANDE',
  AGRICOLA: 'GRANDE',
  EMBARCACION: 'MEDIANO',
  GENERADOR: 'CHICO',
  OTRO: 'MEDIANO',
};
```

- [ ] **Step 2: Sumar el campo al modelo**

En el mismo archivo, cuatro cambios puntuales:

1. En `interface Vehicle`, después de `vehicleType: VehicleType;`, agregar `sizeClass: SizeClass;`
2. En `interface VehicleInput`, después de `vehicleType: VehicleType;`, agregar `sizeClass: SizeClass;`
3. En `EMPTY_VEHICLE_FORM`, después de `vehicleType: 'CAMION',`, agregar `sizeClass: 'GRANDE',` (el tamaño que le corresponde a CAMION)
4. En `mapVehicle`, después de `vehicleType: row.vehicle_type,`, agregar `sizeClass: row.size_class,`
5. En `toRow`, después de `vehicle_type: input.vehicleType,`, agregar `size_class: input.sizeClass,`
6. En `vehicleToForm`, después de `vehicleType: vehicle.vehicleType,`, agregar `sizeClass: vehicle.sizeClass,`

- [ ] **Step 3: Sumar el campo al modal**

En `src/components/VehicleModal.tsx`:

Agregar a los imports desde `@/src/lib/vehicles` (donde ya está `VEHICLE_TYPES`): `SIZE_CLASSES`, `SIZE_CLASS_LABELS`, `SIZE_BY_VEHICLE_TYPE`, y el tipo `SizeClass`.

Reemplazar el `onChange` del select de tipo (línea 125) por:

```tsx
                  onChange={(e) => {
                    const vehicleType = e.target.value as VehicleType;
                    // Cambiar el tipo repropone el tamaño típico. Pisa lo que
                    // hubiera: es más predecible que adivinar si el usuario ya
                    // lo tocó, y el campo queda al lado para corregirlo.
                    patch({ vehicleType, sizeClass: SIZE_BY_VEHICLE_TYPE[vehicleType] });
                  }}
```

El formulario es una grilla de 6 columnas (`sm:grid-cols-6`, línea 95) y esa fila hoy suma justo 6: Tipo (`col-span-3`) + Patente (`col-span-2`) + Año (`col-span-1`).

Insertar el campo nuevo **inmediatamente después del `</label>` que cierra "Tipo"** (línea 132), con `col-span-3` para completar la fila:

```tsx
              <label className={cn(labelClass, 'col-span-3')}>
                Tamaño en playa
                <select
                  value={form.sizeClass}
                  onChange={(e) => patch({ sizeClass: e.target.value as SizeClass })}
                  className={cn(inputClass, 'bg-panel')}
                >
                  {SIZE_CLASSES.map((size) => (
                    <option key={size} value={size}>{SIZE_CLASS_LABELS[size]}</option>
                  ))}
                </select>
              </label>
```

Eso empuja Patente (2) y Año (1) a la fila siguiente, que quedaría con 3 columnas libres. Para cerrarla, cambiar el `col-span-6` del campo "N° de chasis (VIN)" (línea 147) por `col-span-3`:

```tsx
              <label className={cn(labelClass, 'col-span-3')}>
                N° de chasis (VIN)
```

Queda: fila 1 = Tipo + Tamaño, fila 2 = Patente + Año + VIN. Sin huecos.

- [ ] **Step 4: Exponer el tamaño en los vehículos del cliente**

En `src/lib/customers.ts`:

1. Importar el tipo: agregar `import type { SizeClass } from '@/src/lib/vehicles';` junto a los demás imports.
2. En `interface CustomerVehicle`, después de `year: number | null;`, agregar `sizeClass: SizeClass;`
3. En `mapCustomer`, dentro del `.map` de vehículos, después de `year: v.year,`, agregar `sizeClass: v.size_class,`
4. Cambiar `SELECT_WITH_VEHICLES` (línea 51) por:

```ts
const SELECT_WITH_VEHICLES = '*, vehicles(id, brand, model, license_plate, year, active, size_class)';
```

- [ ] **Step 5: Compilar**

```bash
npx tsc --noEmit
```

Esperado: sin salida. Si aparece un error de que falta `sizeClass` en algún objeto literal de `VehicleInput`, ese literal es un lugar más donde hay que agregar el campo — buscarlo con `grep -rn "vehicleType:" src/`.

- [ ] **Step 6: Probar a mano**

Con la app en `localhost:4000`, entrar a Vehículos, editar cualquiera y confirmar tres cosas:
1. El campo "Tamaño en playa" aparece y muestra "Grande" (los 8 vehículos son GRANDE por tipo).
2. Cambiar el tipo a "Grupo electrógeno" cambia el tamaño a "Chico" solo.
3. Poner el tamaño en "Mediano", guardar, reabrir: quedó "Mediano".

Después devolverlo a "Grande" para no dejar dato de prueba, y verificar con SQL:

```sql
select count(*) from public.vehicles where size_class = 'GRANDE';
```

Esperado: 8.

- [ ] **Step 7: Commit**

```bash
git add src/lib/vehicles.ts src/components/VehicleModal.tsx src/lib/customers.ts
git commit -m "Tamaño en playa por vehículo, con default según el tipo"
```

---

### Task 3: El módulo de cálculo de la playa

El corazón del cambio: cuenta la ocupación sin mirar al empleado.

**Files:**
- Create: `src/lib/yardCapacity.ts`
- Delete: `src/lib/shopCapacity.ts` (queda sin usar; sus consumidores se reescriben en la Task 7)

**Interfaces:**
- Consumes: `SizeClass`, `SIZE_CLASSES` de `src/lib/vehicles.ts` (Task 2); `yard_capacity`, `frees_yard`, `size_class`, `CERRADO` (Task 1).
- Produces:
  - `interface YardCapacityRow { sizeClass: SizeClass; capacity: number; }`
  - `fetchYardCapacities(): Promise<YardCapacityRow[]>`
  - `updateYardCapacity(sizeClass: SizeClass, capacity: number): Promise<void>`
  - `interface YardOccupant { kind: 'INGRESO' | 'OT'; id: string; number: string; customerName: string; vehicleLabel: string; sizeClass: SizeClass; statusLabel: string; statusColor: string; estimatedDeliveryDate: string | null; daysInShop: number; createdAt: string; }`
  - `fetchYardOccupancy(): Promise<YardOccupant[]>`
  - `interface YardSizeSummary { sizeClass: SizeClass; capacity: number; occupied: number; free: number; }`
  - `summarizeYard(capacities: YardCapacityRow[], occupants: YardOccupant[]): YardSizeSummary[]`
  - `expectedFreeDate(estimatedDeliveryDate: string | null, graceDays: number): string | null`
  - `interface YardReleaseDay { date: string; bySize: Partial<Record<SizeClass, number>>; }`
  - `projectReleases(occupants: YardOccupant[], graceDays: number, maxDays?: number): YardReleaseDay[]`

- [ ] **Step 1: Escribir el módulo**

Crear `src/lib/yardCapacity.ts`:

```ts
import { supabase } from '@/src/lib/supabase';
import { SIZE_CLASSES, type SizeClass } from '@/src/lib/vehicles';

/**
 * Cuánto lugar hay en la playa y cuánto queda.
 *
 * La ocupación no se guarda en ninguna tabla: se calcula cada vez leyendo lo
 * que está físicamente en el taller. Reemplaza al cálculo por sector del
 * empleado (shopCapacity.ts), que dejaba afuera las OT sin empleado asignado
 * y "movía" vehículos de lugar cuando se reasignaba un mecánico.
 */

export interface YardCapacityRow {
  sizeClass: SizeClass;
  capacity: number;
}

/**
 * Siempre devuelve los tres tamaños, en orden. Un tamaño sin fila se completa
 * con cupo 0 —que es lo mismo que dice la fila sembrada— en vez de romper la
 * vista.
 */
export async function fetchYardCapacities(): Promise<YardCapacityRow[]> {
  const { data, error } = await supabase.from('yard_capacity').select('size_class, capacity');
  if (error) throw error;

  const bySize = new Map((data ?? []).map((r: any) => [r.size_class as SizeClass, Number(r.capacity)]));
  return SIZE_CLASSES.map((sizeClass) => ({ sizeClass, capacity: bySize.get(sizeClass) ?? 0 }));
}

export async function updateYardCapacity(sizeClass: SizeClass, capacity: number): Promise<void> {
  const { error } = await supabase
    .from('yard_capacity')
    .update({ capacity })
    .eq('size_class', sizeClass);
  if (error) throw error;
}

export interface YardOccupant {
  kind: 'INGRESO' | 'OT';
  id: string;
  number: string;
  customerName: string;
  vehicleLabel: string;
  sizeClass: SizeClass;
  statusLabel: string;
  statusColor: string;
  /** Solo las OT la tienen; un ingreso sin OT no tiene fecha de salida. */
  estimatedDeliveryDate: string | null;
  daysInShop: number;
  createdAt: string;
}

function labelDeVehiculo(vehicle: { brand: string | null; model: string; license_plate: string | null } | null): string {
  if (!vehicle) return '—';
  const nombre = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
  return vehicle.license_plate ? `${nombre} — ${vehicle.license_plate}` : nombre || '—';
}

function diasEnTaller(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000));
}

/**
 * Un vehículo ocupa lugar si cumple una de dos, que son excluyentes: tiene un
 * ingreso abierto que todavía no derivó en OT, o tiene una OT cuyo estado no
 * libera la playa.
 *
 * El vínculo entre las dos es la cotización. Se leen TODAS las OT para armar
 * ese vínculo —incluidas las que ya liberaron— porque un ingreso cuya OT está
 * retirada tampoco ocupa: el vehículo se fue.
 */
export async function fetchYardOccupancy(): Promise<YardOccupant[]> {
  const [ordenes, ingresos] = await Promise.all([
    supabase
      .from('work_orders')
      .select(
        `id, number, created_at, estimated_delivery_date, quotation_id,
         status:work_order_statuses(label, color, frees_yard),
         customer:customers(name),
         vehicle:vehicles(brand, model, license_plate, size_class)`
      )
      .order('created_at', { ascending: true }),
    supabase
      .from('vehicle_intakes')
      .select(
        `id, number, created_at, quotation_id,
         customer:customers(name),
         vehicle:vehicles(brand, model, license_plate, size_class)`
      )
      .neq('status', 'CERRADO')
      .order('created_at', { ascending: true }),
  ]);

  if (ordenes.error) throw ordenes.error;
  if (ingresos.error) throw ingresos.error;

  const cotizacionesConOrden = new Set(
    (ordenes.data ?? []).map((row: any) => row.quotation_id).filter(Boolean)
  );

  const deOrdenes: YardOccupant[] = (ordenes.data ?? [])
    .filter((row: any) => !row.status?.frees_yard)
    .map((row: any) => ({
      kind: 'OT' as const,
      id: row.id,
      number: row.number,
      customerName: row.customer?.name ?? '—',
      vehicleLabel: labelDeVehiculo(row.vehicle),
      sizeClass: (row.vehicle?.size_class as SizeClass) ?? 'MEDIANO',
      statusLabel: row.status?.label ?? '—',
      statusColor: row.status?.color ?? '#6b7280',
      estimatedDeliveryDate: row.estimated_delivery_date,
      daysInShop: diasEnTaller(row.created_at),
      createdAt: row.created_at,
    }));

  const deIngresos: YardOccupant[] = (ingresos.data ?? [])
    .filter((row: any) => !row.quotation_id || !cotizacionesConOrden.has(row.quotation_id))
    .map((row: any) => ({
      kind: 'INGRESO' as const,
      id: row.id,
      number: row.number,
      customerName: row.customer?.name ?? '—',
      vehicleLabel: labelDeVehiculo(row.vehicle),
      sizeClass: (row.vehicle?.size_class as SizeClass) ?? 'MEDIANO',
      statusLabel: 'Ingreso sin OT',
      statusColor: '#e07b1a',
      estimatedDeliveryDate: null,
      daysInShop: diasEnTaller(row.created_at),
      createdAt: row.created_at,
    }));

  return [...deIngresos, ...deOrdenes];
}

export interface YardSizeSummary {
  sizeClass: SizeClass;
  capacity: number;
  occupied: number;
  /** Puede ser negativo: hay más vehículos que cupo. La pantalla lo marca. */
  free: number;
}

export function summarizeYard(
  capacities: YardCapacityRow[],
  occupants: YardOccupant[]
): YardSizeSummary[] {
  return capacities.map(({ sizeClass, capacity }) => {
    const occupied = occupants.filter((o) => o.sizeClass === sizeClass).length;
    return { sizeClass, capacity, occupied, free: capacity - occupied };
  });
}

/**
 * Cuándo se espera que el vehículo libere el lugar: la fecha estimada de
 * finalización más el margen de retiro. Sin fecha estimada no se inventa una.
 */
export function expectedFreeDate(estimatedDeliveryDate: string | null, graceDays: number): string | null {
  if (!estimatedDeliveryDate) return null;
  const fecha = new Date(`${estimatedDeliveryDate}T00:00:00`);
  if (Number.isNaN(fecha.getTime())) return null;
  fecha.setDate(fecha.getDate() + graceDays);
  return fecha.toISOString().slice(0, 10);
}

export interface YardReleaseDay {
  date: string;
  bySize: Partial<Record<SizeClass, number>>;
}

/**
 * Cuántos lugares se liberarían cada día si todo saliera según lo estimado.
 * Es una proyección, no una promesa: una fecha estimada que se corre arrastra
 * todo lo que viene atrás.
 */
export function projectReleases(
  occupants: YardOccupant[],
  graceDays: number,
  maxDays = 14
): YardReleaseDay[] {
  const hoy = new Date().toISOString().slice(0, 10);
  const porFecha = new Map<string, Partial<Record<SizeClass, number>>>();

  for (const occupant of occupants) {
    const fecha = expectedFreeDate(occupant.estimatedDeliveryDate, graceDays);
    if (!fecha || fecha < hoy) continue;
    const delDia = porFecha.get(fecha) ?? {};
    delDia[occupant.sizeClass] = (delDia[occupant.sizeClass] ?? 0) + 1;
    porFecha.set(fecha, delDia);
  }

  return [...porFecha.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, maxDays)
    .map(([date, bySize]) => ({ date, bySize }));
}
```

- [ ] **Step 2: Borrar el módulo viejo**

```bash
git rm src/lib/shopCapacity.ts
```

- [ ] **Step 3: Compilar y ver qué se rompe**

```bash
npx tsc --noEmit
```

Esperado: errores **solo** en `src/pages/ShopCapacity.tsx`, que importa lo que se acaba de borrar. Esa pantalla se reescribe en la Task 7. Si aparece un error en cualquier otro archivo, ese archivo también consumía `shopCapacity.ts` y hay que anotarlo para la Task 7 antes de seguir.

Para no dejar la rama sin compilar, dejar `ShopCapacity.tsx` temporalmente apuntando al módulo nuevo con lo mínimo: reemplazar el import de `@/src/lib/shopCapacity` por
```ts
import { fetchYardCapacities, fetchYardOccupancy, updateYardCapacity, type YardCapacityRow, type YardOccupant } from '@/src/lib/yardCapacity';
```
y ajustar los nombres de tipo (`WorkplaceCapacity`→`YardCapacityRow`, `ShopOccupancyRow`→`YardOccupant`, `fetchWorkplaceCapacities`→`fetchYardCapacities`, `updateWorkplaceCapacity`→`updateYardCapacity`, `fetchShopOccupancy`→`fetchYardOccupancy`) y los campos (`cap.workplace`→`cap.sizeClass`, `row.workplace`→`row.sizeClass`) hasta que compile. La pantalla va a mostrar cosas raras hasta la Task 7 — es transitorio y esperado.

- [ ] **Step 4: Verificar el cálculo contra la base**

Con la app corriendo y sesión de admin, en la consola del navegador de Playwright:

```js
const { fetchYardOccupancy } = await import('/src/lib/yardCapacity.ts');
const rows = await fetchYardOccupancy();
({
  total: rows.length,
  ingresos: rows.filter(r => r.kind === 'INGRESO').length,
  ots: rows.filter(r => r.kind === 'OT').length,
  grandes: rows.filter(r => r.sizeClass === 'GRANDE').length,
  conFecha: rows.filter(r => r.estimatedDeliveryDate).length,
})
```

Esperado exactamente: `total: 11`, `ingresos: 8`, `ots: 3`, `grandes: 11`, `conFecha: 3`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/yardCapacity.ts src/pages/ShopCapacity.tsx
git rm --cached src/lib/shopCapacity.ts 2>/dev/null; git add -A src/lib/
git commit -m "Cálculo de ocupación de playa por tamaño, sin pasar por el empleado"
```

---

### Task 4: El estado "Retirado" en el ABM

El estado ya existe en la base; falta que el ABM lo muestre y deje marcar la casilla en otros estados.

**Files:**
- Modify: `src/lib/workOrders.ts`
- Modify: `src/pages/WorkOrderStatuses.tsx`

**Interfaces:**
- Consumes: columna `work_order_statuses.frees_yard` (Task 1).
- Produces: `freesYard: boolean` en `WorkOrderStatus` y en el input del ABM.

- [ ] **Step 1: Sumar el campo al modelo de estados**

En `src/lib/workOrders.ts`:

1. En el comentario de doc que lista los flags (líneas 35-37), agregar una línea más:
```
 *  - freesYard: al llegar acá el vehículo salió del taller y libera la playa.
```
2. En las dos interfaces que tienen `isTerminal: boolean;` y `notifiesClient: boolean;` (líneas 46-48 y 57-59), agregar `freesYard: boolean;` después de `notifiesClient`.
3. En el `SELECT` de estados (línea 71), agregar `frees_yard`:
```ts
  'id, label, client_description, color, sort_order, active, is_initial, is_terminal, notifies_client, frees_yard';
```
4. En el mapeo (línea 83, después de `notifiesClient: row.notifies_client,`), agregar `freesYard: row.frees_yard,`
5. En el `toRow` del ABM (línea 108, después de `notifies_client: input.notifiesClient,`), agregar `frees_yard: input.freesYard,`

- [ ] **Step 2: Sumar la casilla al ABM**

En `src/pages/WorkOrderStatuses.tsx`:

1. En el form vacío (línea 26, donde está `isTerminal: false,`), agregar `freesYard: false,`
2. Donde se carga el form desde un estado existente (línea 38, `isTerminal: status.isTerminal,`), agregar `freesYard: status.freesYard,`
3. En la cabecera de la tabla, después del `<th>` "Terminal" (línea 143), agregar:
```tsx
                <th className="w-28 px-3 py-1">Libera playa</th>
```
4. En la fila, después de la celda "Terminal" (línea 201), agregar:
```tsx
                  <td data-label="Libera playa" className="px-3 py-1 text-text-soft">{status.freesYard ? 'Sí' : '—'}</td>
```
5. Después del bloque del checkbox de "Terminal" (el que termina en la línea 364 con el texto `Terminal (cierra la orden y habilita facturarla)`), agregar el checkbox nuevo copiando esa misma estructura:

```tsx
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={form.freesYard}
                onChange={(e) => patch({ freesYard: e.target.checked })}
                className="h-4 w-4 accent-accent-deep"
              />
              Libera la playa (el vehículo ya salió del taller)
            </label>
```

Las clases son las mismas que usan los checkboxes vecinos de "Terminal" y "Avisa al cliente", verificadas contra el archivo.

- [ ] **Step 3: Compilar**

```bash
npx tsc --noEmit
```

Esperado: sin salida.

- [ ] **Step 4: Probar a mano**

En `localhost:4000/estados-ot`: la lista tiene que mostrar "Retirado" con `Libera playa = Sí` y `Terminal = Sí`, y "Terminado" con `Libera playa = —` y `Terminal = Sí`. Abrir "Retirado" para editar y confirmar que las dos casillas están tildadas. Cerrar sin guardar.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workOrders.ts src/pages/WorkOrderStatuses.tsx
git commit -m "Estado que libera la playa, visible en el ABM de estados de OT"
```

---

### Task 5: Cerrar un ingreso que no llega a OT

Sin esto, un ingreso cuyo cliente rechazó el presupuesto ocupa lugar para siempre.

**Files:**
- Modify: `src/lib/vehicleIntakes.ts`
- Modify: `src/pages/VehicleIntakeDetails.tsx`

**Interfaces:**
- Consumes: valor `CERRADO` del enum `vehicle_intake_status` (Task 1).
- Produces: `closeVehicleIntake(id: string): Promise<void>`; `'CERRADO'` en `VehicleIntakeStatus` con su etiqueta y color.

- [ ] **Step 1: Sumar el estado al modelo**

En `src/lib/vehicleIntakes.ts`, reemplazar las tres declaraciones del principio (líneas 4-14) por:

```ts
export type VehicleIntakeStatus = 'PENDIENTE' | 'COTIZADO' | 'CERRADO';

export const VEHICLE_INTAKE_STATUS_LABELS: Record<VehicleIntakeStatus, string> = {
  PENDIENTE: 'Pendiente de cotizar',
  COTIZADO: 'Cotizado',
  CERRADO: 'Cerrado sin OT',
};

export const VEHICLE_INTAKE_STATUS_STRIP: Record<VehicleIntakeStatus, string> = {
  PENDIENTE: '#e07b1a',
  COTIZADO: '#2e7d32',
  CERRADO: '#6b7280',
};
```

- [ ] **Step 2: Agregar la función de cierre**

Al final de `src/lib/vehicleIntakes.ts`:

```ts
/**
 * El vehículo se fue sin que el ingreso derivara en una orden de trabajo —
 * típicamente porque el cliente rechazó el presupuesto. Cierra el ingreso
 * para que deje de ocupar un lugar en la playa.
 */
export async function closeVehicleIntake(id: string): Promise<void> {
  const { error } = await supabase
    .from('vehicle_intakes')
    .update({ status: 'CERRADO' })
    .eq('id', id);
  if (error) throw error;
}
```

- [ ] **Step 3: Agregar el botón en el detalle del ingreso**

En `src/pages/VehicleIntakeDetails.tsx`, agregar `closeVehicleIntake` al import que ya trae `VEHICLE_INTAKE_STATUS_LABELS` desde `@/src/lib/vehicleIntakes`, y `Archive` al import de `lucide-react`.

Dentro del componente `VehicleIntakeDetails` (línea 26), después de `const [converting, setConverting] = React.useState(false);` (línea 39), agregar el estado y el handler:

```tsx
  const [cerrando, setCerrando] = React.useState(false);

  async function handleCerrar() {
    if (!intake) return;
    if (!window.confirm(
      `¿Cerrar el ingreso ${intake.number}? Se usa cuando el vehículo se fue sin llegar a una orden de trabajo. Deja de ocupar lugar en la playa.`
    )) return;
    setCerrando(true);
    try {
      await closeVehicleIntake(intake.id);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCerrando(false);
    }
  }
```

Los nombres del archivo son exactamente esos: el ingreso es `intake`, la recarga es `load()`, el error es `setError`, y `getErrorMessage` ya está importado.

Agregar el botón dentro del fragmento `actions={...}` del `PageHeader`, **después del bloque de "Crear cotización"** (el que termina en la línea 134). Usa el componente `Button` del repo, igual que sus vecinos:

```tsx
            {isAdmin && intake.status !== 'CERRADO' && (
              <Button variant="ghost" type="button" onClick={handleCerrar} disabled={cerrando}>
                <Archive size={16} /> {cerrando ? 'Cerrando…' : 'Cerrar sin OT'}
              </Button>
            )}
```

Va last a propósito: es la salida excepcional, no la acción normal del ingreso.

- [ ] **Step 4: Compilar**

```bash
npx tsc --noEmit
```

Esperado: sin salida.

- [ ] **Step 5: Probar a mano y devolver el dato**

Anotar el estado real de ING-10 antes de tocarlo:

```sql
select number, status from public.vehicle_intakes where number = 'ING-10';
```

En la app, abrir ese ingreso, apretar "Cerrar sin OT", aceptar. Verificar:

```sql
select number, status from public.vehicle_intakes where number = 'ING-10';
```

Esperado: `CERRADO`. Y que la ocupación bajó de 11 a 10:

```sql
with con_ot as (select quotation_id from public.work_orders where quotation_id is not null)
select
  (select count(*) from public.vehicle_intakes i
   where i.status::text <> 'CERRADO'
     and (i.quotation_id is null or i.quotation_id not in (select quotation_id from con_ot)))
  + (select count(*) from public.work_orders w
     join public.work_order_statuses s on s.id = w.status_id where s.frees_yard = false) as total;
```

Esperado: 10.

**Devolver el dato de prueba** (era `PENDIENTE`):

```sql
update public.vehicle_intakes set status = 'PENDIENTE' where number = 'ING-10';
```

Y confirmar que el total volvió a 11 con la consulta anterior.

- [ ] **Step 6: Commit**

```bash
git add src/lib/vehicleIntakes.ts src/pages/VehicleIntakeDetails.tsx
git commit -m "Cerrar un ingreso cuyo vehículo se fue sin llegar a una OT"
```

---

### Task 6: Los cupos y el margen en Configuración

**Files:**
- Modify: `src/lib/companySettings.ts`
- Modify: `src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `company_settings.yard_pickup_grace_days` (Task 1); `fetchYardCapacities`, `updateYardCapacity`, `YardCapacityRow` de `src/lib/yardCapacity.ts` (Task 3); `SIZE_CLASS_LABELS` de `src/lib/vehicles.ts` (Task 2).
- Produces: `CompanySettings.yardPickupGraceDays: number`; `CompanySettingsInput.yardPickupGraceDays: string`.

- [ ] **Step 1: Sumar el margen a los ajustes**

En `src/lib/companySettings.ts`, cinco cambios:

1. En `interface CompanySettings`, después de `email: string | null;`:
```ts
  /** Días después de la entrega estimada en que se asume que el vehículo se retira. */
  yardPickupGraceDays: number;
```
2. En `interface CompanySettingsInput`, después de `email: string;`, agregar `yardPickupGraceDays: string;`
3. En la constante `SELECT` (líneas 45-47), agregar el campo al final del string:
```ts
  'activity_start_date, address_street, address_city, address_state, address_zip, phone, email, ' +
  'yard_pickup_grace_days';
```
4. En `mapCompanySettings`, después de `email: row.email,`:
```ts
    yardPickupGraceDays: Number(row.yard_pickup_grace_days ?? 2),
```
5. En el `.update({...})` de `updateCompanySettings`, después de `email: nullIfBlank(input.email),`:
```ts
      // Un margen vacío o inválido cae en 2, el default de la columna: dejarlo
      // en 0 diría que todos retiran el mismo día que termina el trabajo.
      yard_pickup_grace_days: Math.max(0, Number(input.yardPickupGraceDays) || 2),
```
6. En `companySettingsToForm`, después de `email: settings.email ?? '',`:
```ts
    yardPickupGraceDays: String(settings.yardPickupGraceDays),
```

- [ ] **Step 2: Agregar la sección a Configuración**

En `src/pages/Settings.tsx`, agregar los imports:

```ts
import { fetchYardCapacities, updateYardCapacity, type YardCapacityRow } from '@/src/lib/yardCapacity';
import { SIZE_CLASS_LABELS } from '@/src/lib/vehicles';
```

Dentro del componente `Settings`, agregar estado y carga:

```tsx
  const [cupos, setCupos] = React.useState<YardCapacityRow[]>([]);
  const [guardandoCupo, setGuardandoCupo] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetchYardCapacities().then(setCupos).catch(() => setCupos([]));
  }, []);

  async function handleCupoChange(sizeClass: YardCapacityRow['sizeClass'], value: string) {
    const capacity = Math.max(0, Number(value) || 0);
    setCupos((previos) => previos.map((c) => (c.sizeClass === sizeClass ? { ...c, capacity } : c)));
    setGuardandoCupo(sizeClass);
    try {
      await updateYardCapacity(sizeClass, capacity);
    } finally {
      setGuardandoCupo(null);
    }
  }
```

Y un `<Panel>` nuevo después del panel de "Envío de facturas por mail" (que arranca en la línea 314):

```tsx
      <Panel className="space-y-4 p-5">
        <h3 className={sectionTitleClass}><Warehouse size={14} /> Capacidad de la playa</h3>
        <p className="text-xs text-text-soft">
          Cuántos vehículos de cada tamaño entran en la playa. En cero, la pantalla de
          disponibilidad avisa que el cupo todavía no está configurado.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {cupos.map((cupo) => (
            <label key={cupo.sizeClass} className={labelClass}>
              {SIZE_CLASS_LABELS[cupo.sizeClass]}
              <input
                type="number"
                min={0}
                value={cupo.capacity}
                disabled={guardandoCupo === cupo.sizeClass}
                onChange={(e) => handleCupoChange(cupo.sizeClass, e.target.value)}
                className={inputClass}
              />
            </label>
          ))}
        </div>
        <label className={labelClass}>
          Días de margen para el retiro
          <input
            type="number"
            min={0}
            value={form.yardPickupGraceDays}
            onChange={(e) => patch({ yardPickupGraceDays: e.target.value })}
            className={inputClass}
          />
          <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
            Cuántos días después de la fecha estimada de finalización se asume que el
            cliente pasa a buscar el vehículo. Se usa solo para proyectar.
          </span>
        </label>
      </Panel>
```

Agregar `Warehouse` al import de `lucide-react` que ya existe en el archivo.

**Nota sobre el guardado:** los cupos se guardan solos al cambiarlos (van a su propia tabla); el margen de días viaja con el botón "Guardar" de los datos fiscales, porque vive en `company_settings`. Es la misma división que ya tiene la pantalla entre los datos fiscales y la sección de Gmail.

- [ ] **Step 3: Compilar**

```bash
npx tsc --noEmit
```

Esperado: sin salida.

- [ ] **Step 4: Probar a mano**

En `localhost:4000/configuracion`, en la sección nueva: poner Grande = 12, Mediano = 4, Chico = 6; poner el margen en 3 y apretar "Guardar" (el de los datos fiscales). Recargar la página y confirmar que los cuatro valores siguen ahí.

Verificar en base:

```sql
select size_class, capacity from public.yard_capacity order by size_class;
select yard_pickup_grace_days from public.company_settings;
```

Esperado: CHICO 6, GRANDE 12, MEDIANO 4; margen 3.

**Dejar esos valores cargados**: no son datos de prueba, son la configuración que las tareas siguientes necesitan para mostrar algo con sentido. Confirmar con el usuario los números reales antes de cerrar el trabajo.

- [ ] **Step 5: Commit**

```bash
git add src/lib/companySettings.ts src/pages/Settings.tsx
git commit -m "Configuración: cupo de playa por tamaño y margen de retiro"
```

---

### Task 7: La pantalla de disponibilidad, reescrita

**Files:**
- Modify: `src/pages/ShopCapacity.tsx` (reescritura completa del cuerpo)

**Interfaces:**
- Consumes: todo lo de `src/lib/yardCapacity.ts` (Task 3); `fetchCompanySettings` de `src/lib/companySettings.ts` (Task 6); `SIZE_CLASS_LABELS` de `src/lib/vehicles.ts` (Task 2); `setEstimatedDeliveryDate` y `getErrorMessage` de `src/lib/workOrders.ts` (ya existen).
- Produces: nada que consuman otras tareas.

- [ ] **Step 1: Reescribir la pantalla**

Reemplazar el contenido completo de `src/pages/ShopCapacity.tsx` por:

```tsx
import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { cn, formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage, setEstimatedDeliveryDate } from '@/src/lib/workOrders';
import { SIZE_CLASS_LABELS } from '@/src/lib/vehicles';
import { fetchCompanySettings } from '@/src/lib/companySettings';
import {
  fetchYardCapacities,
  fetchYardOccupancy,
  projectReleases,
  summarizeYard,
  type YardCapacityRow,
  type YardOccupant,
  type YardSizeSummary,
} from '@/src/lib/yardCapacity';

/**
 * Cuánto lugar queda en la playa, hoy y en los próximos días.
 *
 * Todo lo que está en el taller ocupa playa: cada ingreso sin OT y cada OT
 * cuyo estado no la libera. No se reparte por sector ni se deduce de quién
 * atiende el vehículo — dónde está parado un camión no depende de eso.
 *
 * La proyección depende de que la OT tenga cargada la entrega estimada: sin
 * ese dato no hay forma confiable de saber cuándo se libera el lugar, así que
 * esos vehículos quedan afuera de la proyección pero siguen ocupando.
 */
export function ShopCapacity() {
  const { role } = useAuth();
  const [capacities, setCapacities] = React.useState<YardCapacityRow[]>([]);
  const [occupancy, setOccupancy] = React.useState<YardOccupant[]>([]);
  const [graceDays, setGraceDays] = React.useState(2);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [caps, rows, settings] = await Promise.all([
        fetchYardCapacities(),
        fetchYardOccupancy(),
        fetchCompanySettings(),
      ]);
      setCapacities(caps);
      setOccupancy(rows);
      setGraceDays(settings?.yardPickupGraceDays ?? 2);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const summary: YardSizeSummary[] = React.useMemo(
    () => summarizeYard(capacities, occupancy),
    [capacities, occupancy]
  );

  const upcoming = React.useMemo(
    () => projectReleases(occupancy, graceDays),
    [occupancy, graceDays]
  );

  const sinFecha = occupancy.filter((row) => !row.estimatedDeliveryDate);

  const sortedOccupancy = React.useMemo(() => {
    return [...occupancy].sort((a, b) => {
      if (a.estimatedDeliveryDate && b.estimatedDeliveryDate) {
        return a.estimatedDeliveryDate.localeCompare(b.estimatedDeliveryDate);
      }
      if (a.estimatedDeliveryDate) return -1;
      if (b.estimatedDeliveryDate) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }, [occupancy]);

  const sinConfigurar = capacities.every((c) => c.capacity === 0);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleDeliveryChange(workOrderId: string, date: string) {
    setError(null);
    try {
      await setEstimatedDeliveryDate(workOrderId, date || null);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Disponibilidad del taller"
        subtitle="Cuánto lugar queda en la playa, según los ingresos y las OT en curso."
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {!loading && sinConfigurar && (
        <div className="rounded-md border border-line bg-panel-alt px-4 py-3 text-sm text-text-soft">
          El cupo de la playa todavía no está configurado. Cargalo en{' '}
          <Link to="/configuracion" className="font-semibold text-accent-deep hover:underline">Configuración</Link>{' '}
          para que esta pantalla pueda decir cuánto lugar queda.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {summary.map((size) => {
          const over = size.occupied > size.capacity;
          const full = size.occupied === size.capacity && size.capacity > 0;
          return (
            <Panel key={size.sizeClass} className="p-4">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                {SIZE_CLASS_LABELS[size.sizeClass]}
              </span>
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'font-display text-3xl font-medium',
                    over ? 'text-danger' : full ? 'text-state-wait' : 'text-state-done'
                  )}
                >
                  {loading ? '—' : size.occupied}
                </span>
                <span className="text-sm text-text-soft">/ {size.capacity} cupo</span>
              </div>
              {!loading && !over && size.capacity > 0 && (
                <span className="mt-1 block text-[11px] text-text-soft">
                  Quedan {size.free} lugar{size.free === 1 ? '' : 'es'}
                </span>
              )}
              {over && (
                <span className="mt-1 block text-[11px] font-semibold text-danger">
                  {size.occupied - size.capacity} por encima del cupo
                </span>
              )}
            </Panel>
          );
        })}
      </div>

      {upcoming.length > 0 && (
        <Panel className="p-4">
          <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            <CalendarClock size={14} /> Próximas salidas
          </span>
          <p className="mb-3 text-[11px] text-text-soft">
            Proyección, no promesa: sale de la entrega estimada de cada OT más {graceDays} día
            {graceDays === 1 ? '' : 's'} de margen para el retiro.
          </p>
          <div className="space-y-1.5">
            {upcoming.map(({ date, bySize }) => (
              <div key={date} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono font-semibold text-text">{formatDate(date)}</span>
                <span className="text-text-soft">
                  {Object.entries(bySize)
                    .map(([size, n]) => `${SIZE_CLASS_LABELS[size as keyof typeof SIZE_CLASS_LABELS]}: libera ${n}`)
                    .join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {!loading && sinFecha.length > 0 && (
        <div className="rounded-md border border-line bg-panel-alt px-4 py-3 text-sm text-text-soft">
          {sinFecha.length} vehículo{sinFecha.length === 1 ? '' : 's'} sin fecha de salida: no
          entran en la proyección, pero ocupan lugar igual.
        </div>
      )}

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto overflow-y-hidden">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="w-28 p-3 font-semibold">Comprobante</th>
                <th className="p-3 font-semibold">Cliente</th>
                <th className="p-3 font-semibold">Vehículo</th>
                <th className="w-28 p-3 font-semibold">Tamaño</th>
                <th className="w-36 p-3 font-semibold">Estado</th>
                <th className="w-20 p-3 text-right font-semibold">Días</th>
                <th className="w-40 p-3 font-semibold">Entrega estimada</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-text-soft">Cargando…</td>
                </tr>
              )}
              {!loading && sortedOccupancy.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-text-soft">
                    No hay vehículos ocupando la playa.
                  </td>
                </tr>
              )}
              {sortedOccupancy.map((row) => (
                <tr key={`${row.kind}-${row.id}`} className="border-b border-line hover:bg-panel-alt">
                  <td data-primary className="p-3">
                    <Link
                      to={row.kind === 'OT' ? `/orden/${row.id}` : `/ingresos/${row.id}`}
                      className="font-mono font-semibold text-accent-deep hover:underline"
                    >
                      {row.number}
                    </Link>
                  </td>
                  <td data-label="Cliente" className="p-3">{row.customerName}</td>
                  <td data-label="Vehículo" className="p-3 text-text-soft">{row.vehicleLabel}</td>
                  <td data-label="Tamaño" className="p-3 text-text-soft">{SIZE_CLASS_LABELS[row.sizeClass]}</td>
                  <td data-label="Estado" className="p-3">
                    <span
                      className="text-[10px] font-bold uppercase tracking-wider"
                      style={{ color: row.statusColor }}
                    >
                      {row.statusLabel}
                    </span>
                  </td>
                  <td data-label="Días" className="p-3 text-right font-mono text-text-soft">{row.daysInShop}</td>
                  <td data-label="Entrega estimada" className="p-3">
                    {row.kind === 'OT' ? (
                      <input
                        type="date"
                        value={row.estimatedDeliveryDate ?? ''}
                        onChange={(e) => handleDeliveryChange(row.id, e.target.value)}
                        className="rounded border border-line bg-panel px-1.5 py-0.5 text-[13px] focus:border-accent-deep focus:outline-none"
                      />
                    ) : (
                      <span className="text-text-faint">Sin OT todavía</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
```

**Ojo con las rutas:** el detalle de OT es `/orden/:id` **en singular** ([`App.tsx:95`](../../../src/App.tsx)), mientras que el listado es `/ordenes`. El detalle de ingreso sí es `/ingresos/:id` ([`App.tsx:97`](../../../src/App.tsx)). Las dos están verificadas contra el archivo de rutas; escribir `/ordenes/${row.id}` daría un enlace roto que no falla al compilar.

- [ ] **Step 2: Compilar y construir**

```bash
npx tsc --noEmit && npm run build
```

Esperado: `tsc` sin salida y el build terminando en `✓ built in ...`.

- [ ] **Step 3: Probar a mano**

En `localhost:4000/disponibilidad-taller`, con los cupos de la Task 6 (Grande 12, Mediano 4, Chico 6):

1. El panel "Grande" muestra `11 / 12 cupo` y "Quedan 1 lugar".
2. "Mediano" y "Chico" muestran 0 ocupado.
3. La tabla lista **11 filas**: 8 con estado "Ingreso sin OT" y 3 con el estado de la OT.
4. No aparece por ningún lado la palabra "Sector", ni un aviso de "sin empleado asignado".
5. El aviso de "sin fecha de salida" dice 8.
6. "Próximas salidas" lista las 3 OT con fecha, corridas 3 días respecto de su entrega estimada (OT-5010 entrega 2026-09-02 → aparece 2026-09-05).

Prueba de que la ocupación ya no depende del empleado: en una OT activa, quitarle el empleado asignado y volver a esta pantalla — la ocupación tiene que seguir en 11. Después devolver el empleado.

- [ ] **Step 4: Commit**

```bash
git add src/pages/ShopCapacity.tsx
git commit -m "Disponibilidad: playa por tamaño, con ingresos y OT en la misma cuenta"
```

---

### Task 8: Aviso de lugar al recibir un vehículo

**Files:**
- Modify: `src/pages/VehicleIntakes.tsx`

**Interfaces:**
- Consumes: `fetchYardCapacities`, `fetchYardOccupancy`, `summarizeYard` de `src/lib/yardCapacity.ts` (Task 3); `SIZE_CLASS_LABELS` de `src/lib/vehicles.ts` (Task 2); `CustomerVehicle.sizeClass` (Task 2).
- Produces: nada.

- [ ] **Step 1: Cargar el resumen de playa en el formulario**

En `src/pages/VehicleIntakes.tsx`, agregar los imports:

```ts
import { fetchYardCapacities, fetchYardOccupancy, summarizeYard, type YardSizeSummary } from '@/src/lib/yardCapacity';
import { SIZE_CLASS_LABELS } from '@/src/lib/vehicles';
```

En el componente del formulario de alta (el que tiene `const [vehicleId, setVehicleId] = React.useState('');` en la línea 189), agregar:

```tsx
  const [resumenPlaya, setResumenPlaya] = React.useState<YardSizeSummary[]>([]);

  React.useEffect(() => {
    Promise.all([fetchYardCapacities(), fetchYardOccupancy()])
      .then(([caps, rows]) => setResumenPlaya(summarizeYard(caps, rows)))
      // El aviso de lugar es informativo: si falla, el alta tiene que seguir
      // funcionando igual.
      .catch(() => setResumenPlaya([]));
  }, []);

  const vehiculoElegido = vehicles.find((v) => v.id === vehicleId) ?? null;
  const lugarDelTamano = vehiculoElegido
    ? resumenPlaya.find((r) => r.sizeClass === vehiculoElegido.sizeClass) ?? null
    : null;
```

- [ ] **Step 2: Mostrar el aviso debajo del selector de vehículo**

Justo después del `</label>` que cierra el campo "Vehículo / Equipo" (el bloque que termina en la línea 298), agregar:

```tsx
            {lugarDelTamano && lugarDelTamano.capacity > 0 && (
              <p
                className={cn(
                  'text-xs',
                  lugarDelTamano.free <= 0 ? 'font-semibold text-danger' : 'text-text-soft'
                )}
              >
                {lugarDelTamano.free > 0
                  ? `Quedan ${lugarDelTamano.free} de ${lugarDelTamano.capacity} lugares para vehículos de tamaño ${SIZE_CLASS_LABELS[lugarDelTamano.sizeClass].toLowerCase()}.`
                  : `No queda lugar para vehículos de tamaño ${SIZE_CLASS_LABELS[lugarDelTamano.sizeClass].toLowerCase()} (${lugarDelTamano.occupied} de ${lugarDelTamano.capacity}). Podés registrar el ingreso igual.`}
              </p>
            )}
```

**No agrega ninguna validación al submit**: el vehículo ya está en la puerta del taller, y un sistema que impide registrarlo solo consigue que el dato deje de cargarse.

- [ ] **Step 3: Compilar y construir**

```bash
npx tsc --noEmit && npm run build
```

Esperado: `tsc` sin salida, build exitoso.

- [ ] **Step 4: Probar a mano**

En `localhost:4000/ingresos`, "Nuevo ingreso": elegir un cliente y un vehículo. Con los cupos de la Task 6 (Grande 12, ocupado 11) tiene que decir "Quedan 1 de 12 lugares para vehículos de tamaño grande."

Para probar el caso sin lugar: bajar temporalmente el cupo de Grande a 11 en Configuración, volver al alta y confirmar que aparece el aviso rojo "No queda lugar..." y que el botón de guardar **sigue habilitado**. Después devolver el cupo a 12.

Cerrar el formulario sin crear el ingreso, para no dejar datos de prueba.

- [ ] **Step 5: Commit**

```bash
git add src/pages/VehicleIntakes.tsx
git commit -m "Aviso de lugar disponible al recibir un vehículo"
```

---

## Verificación final

Después de la última tarea, antes de cerrar:

- [ ] `npx tsc --noEmit` sin salida y `npm run build` exitoso.
- [ ] `grep -rn "shopCapacity" src/` no devuelve nada.
- [ ] `grep -rn "workplace" src/lib/yardCapacity.ts src/pages/ShopCapacity.tsx` no devuelve nada: la ocupación no mira al empleado por ningún lado.
- [ ] La ocupación da 11 en la pantalla y en SQL.
- [ ] Marcar una OT activa como "Retirado" baja la ocupación a 10, y esa OT **sigue pudiendo facturarse** (verificar entrando a Facturación y comprobando que aparece en las OT facturables). Después devolverla a su estado original.
- [ ] Los datos de prueba quedaron devueltos: ING-10 en `PENDIENTE`, empleados y vehículos como estaban, cupos en los valores que confirme el usuario.
