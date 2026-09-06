# La playa se mide en celdas — Plan de implementación

> **Para trabajadores agénticos:** SUB-SKILL REQUERIDA: usar
> superpowers:subagent-driven-development (recomendado) o
> superpowers:executing-plans para implementar tarea por tarea. Los pasos usan
> casillas (`- [ ]`) para seguimiento.

**Objetivo:** reemplazar los tres cupos por tamaño de vehículo por un único
recurso —celdas, donde entra un vehículo grande o hasta tres medianos— y
proyectar la disponibilidad día por día según la fecha estimada de
finalización.

**Arquitectura:** toda la aritmética vive en funciones puras de
`src/lib/yardCapacity.ts` (`celdasOcupadas`, `ocupaEnFecha`,
`proyectarDisponibilidad`), que se verifican con un script desechable porque el
proyecto no tiene corredor de pruebas. Las pantallas solo leen esas funciones.
La cantidad de celdas pasa de una tabla propia a una clave de `app_settings`.

**Stack:** React + TypeScript + Vite, Supabase (Postgres + RLS), Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-06-celdas-de-playa-design.md`

## Restricciones globales

- **No hay corredor de pruebas.** La verificación es: `npx tsc --noEmit`,
  `npm run build`, SQL vía MCP supabase (proyecto `mnoqdqjhsylohlvuekfh`) y
  Playwright sobre `localhost:4000`.
- **Crear una OT dispara un WhatsApp real** (`work_orders_enqueue_created`).
  Para pruebas manuales usar el cliente **Agrícola del Sur**, cuyo teléfono es
  el del propio usuario. Nunca otro cliente.
- **Los subagentes no pueden aplicar migraciones ni commitear.** Escriben el
  `.sql` y dejan el comando listo; el coordinador lo aplica y commitea.
- Fórmula, textual del spec: `celdas ocupadas = grandes + techo(medianos / 3)`.
- El hueco de una celda a medio llenar **no se publica** como disponibilidad.
- Celdas libres **puede dar negativo** y se muestra igual, marcado.
- Una orden con fecha estimada `F` ocupa **hasta `F` inclusive**.
- Sin fecha estimada, o con fecha vencida: **ocupa toda la ventana proyectada**.
- El comentario en el código se escribe en español, explicando *por qué*, al
  estilo del resto del repo.

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `supabase/celdas-de-playa.sql` (nuevo) | Migración: dos tamaños, `yard_cells`, baja de `yard_capacity` y del margen |
| `src/lib/vehicles.ts` | `SizeClass` con dos valores; el alta deja de adivinar el tamaño |
| `src/components/VehicleModal.tsx` | Selector sin preselección + validación |
| `src/lib/yardCapacity.ts` | Toda la aritmética de celdas y la proyección |
| `src/lib/companySettings.ts` | Sale `yardPickupGraceDays` |
| `src/pages/Settings.tsx` | Un único campo: celdas del taller |
| `src/lib/workOrders.ts` | `NewWorkOrderInput` suma la fecha estimada |
| `src/components/NewWorkOrderModal.tsx` | Fecha obligatoria para vehículo + aviso de celdas |
| `src/pages/ShopCapacity.tsx` | Celdas libres, línea de tiempo y contadores |

---

### Task 1: Base de datos — celdas, dos tamaños, sin margen

**Archivos:**
- Crear: `supabase/celdas-de-playa.sql`

**Interfaces:**
- Consume: nada.
- Produce: la clave `app_settings.yard_cells` (texto con un entero), el CHECK
  `vehicles_size_class_check` restringido a `MEDIANO`/`GRANDE`, y la ausencia de
  la tabla `yard_capacity` y de la columna `company_settings.yard_pickup_grace_days`.

- [ ] **Paso 1: Escribir la migración**

Crear `supabase/celdas-de-playa.sql` con este contenido exacto:

```sql
-- ===========================================================================
-- La playa se mide en celdas
-- ===========================================================================
-- Migración: celdas_de_playa
--
-- Los tres cupos por tamaño modelaban un taller con tres playas separadas, una
-- por tamaño. Hay una sola, y lo que entra depende de cómo se combinan los
-- vehículos: una celda admite un grande o hasta tres medianos.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-09-06-celdas-de-playa-design.md

-- ── 1) El tamaño queda en dos valores ──────────────────────────────────────
-- No se reasigna nada: hoy ningún vehículo es CHICO. Si apareciera uno, este
-- ALTER falla y la migración se detiene, que es lo que se busca — el tamaño
-- decide cuánto lugar ocupa el vehículo, y adivinarlo es exactamente lo que
-- este diseño viene a evitar. Si falla, hay que corregir esas filas a mano
-- sabiendo cuál es cada vehículo.
alter table public.vehicles drop constraint vehicles_size_class_check;
alter table public.vehicles add constraint vehicles_size_class_check
  check (size_class = any (array['MEDIANO'::text, 'GRANDE'::text]));

-- ── 2) La cantidad de celdas ───────────────────────────────────────────────
-- Va a app_settings, que es donde ya viven los escalares de configuración del
-- taller (default_markup_percent sigue el mismo patrón). yard_capacity existía
-- solo porque había tres valores indexados por tamaño; con un único número deja
-- de tener sentido.
--
-- 10 es un punto de partida configurable, no una medición: hay que revisarlo en
-- Configuración.
insert into public.app_settings (key, value)
values ('yard_cells', '10')
on conflict (key) do nothing;

drop table if exists public.yard_capacity;

-- ── 3) El margen de retiro se elimina ──────────────────────────────────────
-- La celda ya no se libera porque venza una fecha, sino cuando la orden pasa a
-- Retirado. El margen quedaba prometiendo lugar por una fecha que no manda.
alter table public.company_settings drop column if exists yard_pickup_grace_days;
```

- [ ] **Paso 2: Verificar que ningún vehículo bloquea el cambio**

Ejecutar por MCP supabase, ANTES de aplicar:

```sql
select count(*) as vehiculos_chicos from vehicles where size_class = 'CHICO';
```

Esperado: `0`. Si da distinto de cero, **detenerse** y reportar cuáles son
(`select id, brand, model, license_plate from vehicles where size_class='CHICO'`):
hay que decidir uno por uno si son medianos o grandes, no reasignarlos en masa.

- [ ] **Paso 3: Aplicar la migración**

El coordinador la aplica con `apply_migration`, nombre `celdas_de_playa`, con el
cuerpo del Paso 1.

- [ ] **Paso 4: Verificar el resultado**

```sql
select
  (select value from app_settings where key='yard_cells') as celdas,
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='yard_capacity') as yard_capacity_viva,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='company_settings'
      and column_name='yard_pickup_grace_days') as margen_vivo,
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid='public.vehicles'::regclass and conname='vehicles_size_class_check') as check_tamano;
```

Esperado: `celdas = 10`, `yard_capacity_viva = 0`, `margen_vivo = 0`, y
`check_tamano` mencionando solo MEDIANO y GRANDE.

- [ ] **Paso 5: Commit**

```bash
git add supabase/celdas-de-playa.sql
git commit -m "Base de datos: la playa se mide en celdas"
```

---

### Task 2: El tamaño queda en dos valores y deja de adivinarse

**Archivos:**
- Modificar: `src/lib/vehicles.ts`
- Modificar: `src/components/VehicleModal.tsx`

**Interfaces:**
- Consume: el CHECK de dos valores de la Task 1.
- Produce: `type SizeClass = 'MEDIANO' | 'GRANDE'`; `SIZE_CLASSES: SizeClass[]`;
  `VehicleInput.sizeClass: SizeClass | ''`; `EMPTY_VEHICLE_FORM.sizeClass: ''`.
  La Task 3 consume `SizeClass`.

- [ ] **Paso 1: Reducir el tipo a dos valores**

En `src/lib/vehicles.ts`, reemplazar el bloque de tamaños:

```ts
export type SizeClass = 'MEDIANO' | 'GRANDE';

export const SIZE_CLASS_LABELS: Record<SizeClass, string> = {
  MEDIANO: 'Mediano',
  GRANDE: 'Grande',
};

export const SIZE_CLASSES = Object.keys(SIZE_CLASS_LABELS) as SizeClass[];

/** Cuántos vehículos medianos entran en una celda. Un grande la ocupa entero. */
export const MEDIANOS_POR_CELDA = 3;
```

Y **borrar por completo** `SIZE_BY_VEHICLE_TYPE` junto con su comentario: ya no
se sugiere un tamaño a partir del tipo. El tipo no dice cuánto lugar ocupa el
vehículo —"Camión / Utilitario" mete en la misma bolsa una Transit y un
Scania— y una sugerencia equivocada que nadie corrige corrompe la cuenta de la
playa en silencio.

- [ ] **Paso 2: Permitir que el formulario arranque sin tamaño elegido**

En el mismo archivo, en `VehicleInput`:

```ts
  /**
   * Vacío hasta que el usuario elige. No hay valor por defecto a propósito:
   * el tamaño decide cuánto lugar ocupa el vehículo en la playa, y un default
   * que nadie mira es una cuenta equivocada que no avisa.
   */
  sizeClass: SizeClass | '';
```

y en `EMPTY_VEHICLE_FORM`, `sizeClass: 'GRANDE'` pasa a `sizeClass: ''`.

- [ ] **Paso 3: Ajustar el mapeo de ida y vuelta**

En `createVehicle`/`updateVehicle` (donde hoy dice `size_class: input.sizeClass`),
la validación de la pantalla garantiza que no llega vacío, pero el tipo no lo
sabe. Dejarlo explícito:

```ts
    size_class: input.sizeClass || 'MEDIANO',
```

Con el comentario:

```ts
    // El `|| 'MEDIANO'` no es un default de negocio: la pantalla no deja
    // guardar sin elegir. Es para que el tipo cierre sin un cast que taparía
    // un vacío real si alguien llamara a esta función desde otro lado.
```

- [ ] **Paso 4: Quitar la preselección de la pantalla**

En `src/components/VehicleModal.tsx`:

1. Sacar `SIZE_BY_VEHICLE_TYPE` del import.
2. En el `onChange` del selector de Tipo, dejar solo `patch({ vehicleType })`
   (ya no repropone tamaño).
3. En el selector de Tamaño, agregar la opción vacía:

```tsx
                <select
                  value={form.sizeClass}
                  onChange={(e) => patch({ sizeClass: e.target.value as SizeClass })}
                  className={cn(inputClass, 'bg-panel')}
                >
                  <option value="">Elegí el tamaño…</option>
                  {SIZE_CLASSES.map((size) => (
                    <option key={size} value={size}>{SIZE_CLASS_LABELS[size]}</option>
                  ))}
                </select>
```

4. En `handleSubmit`, junto a la validación de cliente que ya existe:

```ts
    if (!form.sizeClass) {
      setError('Elegí el tamaño del vehículo: define cuánto lugar ocupa en la playa.');
      return;
    }
```

- [ ] **Paso 5: Verificar que compila**

Run: `npx tsc --noEmit`
Esperado: sin errores. Si aparece un error en `src/lib/customers.ts` o en
`src/lib/yardCapacity.ts` por el `SizeClass` reducido, es esperado en
yardCapacity —lo reescribe la Task 3—; en customers.ts no debería haber ninguno
porque solo lo usa como tipo.

- [ ] **Paso 6: Probar en el navegador**

Con el servidor en `localhost:4000`, ir a Clientes, abrir un cliente y agregar
un vehículo. Verificar que:
- el selector de Tamaño arranca en "Elegí el tamaño…",
- cambiar el Tipo **no** lo modifica,
- guardar sin elegir muestra el mensaje del Paso 4,
- eligiendo Mediano o Grande guarda bien.

Borrar el vehículo de prueba al terminar.

- [ ] **Paso 7: Commit**

```bash
git add src/lib/vehicles.ts src/components/VehicleModal.tsx
git commit -m "El tamaño del vehículo se elige, no se adivina"
```

---

### Task 3: El cálculo de celdas y la proyección

**Archivos:**
- Modificar: `src/lib/yardCapacity.ts`
- Crear (desechable): `<scratchpad>/celdas.check.ts`

**Interfaces:**
- Consume: `SizeClass`, `MEDIANOS_POR_CELDA` de la Task 2; `app_settings.yard_cells`
  de la Task 1.
- Produce:
  - `fetchYardCells(): Promise<number>`
  - `updateYardCells(cells: number): Promise<void>`
  - `fetchYardOccupancy(): Promise<YardOccupant[]>` (sin cambios de firma)
  - `celdasOcupadas(occupants: Pick<YardOccupant,'sizeClass'>[]): number`
  - `ocupaEnFecha(o: Pick<YardOccupant,'estimatedDeliveryDate'>, dia: string, hoy: string): boolean`
  - `proyectarDisponibilidad(cells: number, occupants: YardOccupant[], dias?: number, hoy?: string): YardDayAvailability[]`
  - `sinFechaEstimada(occupants)` y `vencidas(occupants, hoy?)`
  - `hoyISO(): string` (ya existe, se conserva)
  - `interface YardDayAvailability { date: string; freeCells: number }`

- [ ] **Paso 1: Reemplazar la lectura y escritura del cupo**

En `src/lib/yardCapacity.ts`, borrar `YardCapacityRow`, `fetchYardCapacities`,
`updateYardCapacity` y `summarizeYard`, y poner en su lugar:

```ts
/** Cuántas celdas tiene el taller. Sin la clave cargada, cero. */
export async function fetchYardCells(): Promise<number> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'yard_cells')
    .maybeSingle();
  if (error) throw error;
  return Math.max(0, Math.trunc(Number(data?.value) || 0));
}

export async function updateYardCells(cells: number): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'yard_cells', value: String(Math.max(0, Math.trunc(cells))) }, { onConflict: 'key' });
  if (error) throw error;
}
```

- [ ] **Paso 2: Escribir la aritmética de celdas**

Agregar, después de `fetchYardOccupancy`:

```ts
/**
 * Celdas que ocupa un conjunto de vehículos.
 *
 * Un grande toma la celda entera; los medianos se amontonan de a tres. El hueco
 * que queda en una celda a medio llenar NO se publica como disponibilidad: si
 * se contara, el número subiría y bajaría sin que entre ni salga nada del
 * taller, y nadie podría explicarlo.
 */
export function celdasOcupadas(occupants: Pick<YardOccupant, 'sizeClass'>[]): number {
  let grandes = 0;
  let medianos = 0;
  for (const o of occupants) {
    if (o.sizeClass === 'GRANDE') grandes += 1;
    else medianos += 1;
  }
  return grandes + Math.ceil(medianos / MEDIANOS_POR_CELDA);
}

/**
 * Si la orden todavía ocupa su celda el día indicado.
 *
 * Ocupa hasta su fecha estimada INCLUSIVE: el trabajo termina ese día y recién
 * después la celda queda disponible. Es el criterio pesimista, coherente con el
 * resto — se prefiere mostrar la celda ocupada un día de más que prometerla un
 * día antes de tiempo.
 *
 * Sin fecha, o con la fecha ya vencida y la orden todavía sin retirar, ocupa
 * toda la ventana: la celda está tomada de hecho y no hay con qué predecir
 * cuándo se libera.
 */
export function ocupaEnFecha(
  occupant: Pick<YardOccupant, 'estimatedDeliveryDate'>,
  dia: string,
  hoy: string
): boolean {
  const fecha = occupant.estimatedDeliveryDate;
  if (!fecha || fecha < hoy) return true;
  return dia <= fecha;
}

export interface YardDayAvailability {
  date: string;
  /** Puede ser negativo: hay más vehículos que celdas. La pantalla lo marca. */
  freeCells: number;
}

/**
 * Cuántas celdas quedarían libres cada día, suponiendo que cada orden se retire
 * en su fecha estimada.
 *
 * Cada día se calcula ENTERO, no por diferencia con el anterior. El techo no es
 * aditivo: con 4 medianos ocupando 2 celdas, que se vaya uno solo libera una
 * celda entera (quedan 3, que entran en 1). Ir restando "un tercio de celda por
 * mediano que sale" da resultados equivocados.
 */
export function proyectarDisponibilidad(
  cells: number,
  occupants: YardOccupant[],
  dias = 14,
  hoy: string = hoyISO()
): YardDayAvailability[] {
  const resultado: YardDayAvailability[] = [];
  const base = new Date(`${hoy}T00:00:00`);
  for (let i = 0; i < dias; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const date = d.toISOString().slice(0, 10);
    const eseDia = occupants.filter((o) => ocupaEnFecha(o, date, hoy));
    resultado.push({ date, freeCells: cells - celdasOcupadas(eseDia) });
  }
  return resultado;
}

/** Órdenes que nunca tuvieron fecha estimada: ocupan toda la ventana. */
export function sinFechaEstimada(occupants: YardOccupant[]): YardOccupant[] {
  return occupants.filter((o) => !o.estimatedDeliveryDate);
}

/**
 * Órdenes cuya fecha estimada ya pasó y siguen sin marcarse Retirado. La celda
 * está ocupada de hecho, así que ocupan toda la ventana igual que las que no
 * tienen fecha.
 */
export function vencidas(occupants: YardOccupant[], hoy: string = hoyISO()): YardOccupant[] {
  return occupants.filter((o) => !!o.estimatedDeliveryDate && o.estimatedDeliveryDate < hoy);
}
```

- [ ] **Paso 3: Borrar lo que quedó del modelo viejo**

Del mismo archivo, eliminar `expectedFreeDate`, `tieneFechaFutura`,
`YardReleaseDay`, `projectReleases` y `YardSizeSummary`. Todos dependían del
margen de retiro o de los cupos por tamaño. Agregar el import de
`MEDIANOS_POR_CELDA` desde `@/src/lib/vehicles`.

- [ ] **Paso 4: Escribir el chequeo de la aritmética**

El proyecto no tiene corredor de pruebas, así que la verificación es un script
desechable. Crear `<scratchpad>/celdas.check.ts` (el directorio scratchpad de la
sesión, no el repo):

```ts
import { celdasOcupadas, ocupaEnFecha, proyectarDisponibilidad } from '../../src/lib/yardCapacity';

let fallos = 0;
function esperar(nombre: string, real: unknown, esperado: unknown) {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (!ok) { fallos += 1; console.error(`FALLA ${nombre}: esperaba ${JSON.stringify(esperado)}, dio ${JSON.stringify(real)}`); }
  else console.log(`ok  ${nombre}`);
}
const g = { sizeClass: 'GRANDE' as const };
const m = { sizeClass: 'MEDIANO' as const };

esperar('vacío', celdasOcupadas([]), 0);
esperar('un grande', celdasOcupadas([g]), 1);
esperar('tres medianos entran en una', celdasOcupadas([m, m, m]), 1);
esperar('cuatro medianos necesitan dos', celdasOcupadas([m, m, m, m]), 2);
esperar('el ejemplo del spec', celdasOcupadas([g, g, m, m, m, m]), 4);
esperar('un quinto mediano no suma celda', celdasOcupadas([g, g, m, m, m, m, m]), 4);

// El caso no aditivo: sacar UN mediano de cuatro libera una celda entera.
esperar('no aditivo', celdasOcupadas([m, m, m, m]) - celdasOcupadas([m, m, m]), 1);

const hoy = '2026-09-10';
esperar('ocupa el día de su fecha', ocupaEnFecha({ estimatedDeliveryDate: '2026-09-12' }, '2026-09-12', hoy), true);
esperar('libera al día siguiente', ocupaEnFecha({ estimatedDeliveryDate: '2026-09-12' }, '2026-09-13', hoy), false);
esperar('sin fecha ocupa siempre', ocupaEnFecha({ estimatedDeliveryDate: null }, '2026-12-31', hoy), true);
esperar('vencida ocupa siempre', ocupaEnFecha({ estimatedDeliveryDate: '2026-09-01' }, '2026-12-31', hoy), true);

const ocupantes = [
  { sizeClass: 'GRANDE', estimatedDeliveryDate: '2026-09-11' },
  { sizeClass: 'MEDIANO', estimatedDeliveryDate: '2026-09-11' },
  { sizeClass: 'MEDIANO', estimatedDeliveryDate: null },
] as any[];
const proy = proyectarDisponibilidad(10, ocupantes, 3, hoy);
esperar('proyección 3 días', proy, [
  { date: '2026-09-10', freeCells: 8 },  // 1 grande + 2 medianos(1 celda) = 2
  { date: '2026-09-11', freeCells: 8 },  // siguen los tres
  { date: '2026-09-12', freeCells: 9 },  // solo queda el sin fecha = 1 celda
]);

esperar('desbordada da negativo', 2 - celdasOcupadas([g, g, g]), -1);

if (fallos > 0) { console.error(`\n${fallos} fallas`); process.exit(1); }
console.log('\nTodo bien');
```

- [ ] **Paso 5: Correr el chequeo**

Run: `npx tsx <ruta al scratchpad>/celdas.check.ts`
Esperado: todas las líneas `ok` y `Todo bien`. Si alguna falla, corregir
`yardCapacity.ts` —no el chequeo— salvo que el error esté en el valor esperado
del propio chequeo, en cuyo caso verificar contra el spec antes de tocarlo.

- [ ] **Paso 6: Verificar que compila**

Run: `npx tsc --noEmit`
Esperado: fallan `Settings.tsx` y `ShopCapacity.tsx` porque todavía usan las
funciones borradas. Es lo previsto: las arreglan las Tasks 4 y 6. Ningún otro
archivo debe fallar.

- [ ] **Paso 7: Commit**

```bash
git add src/lib/yardCapacity.ts
git commit -m "El cálculo de la playa pasa a celdas"
```

---

### Task 4: Configuración — una sola cantidad de celdas

**Archivos:**
- Modificar: `src/pages/Settings.tsx`
- Modificar: `src/lib/companySettings.ts`

**Interfaces:**
- Consume: `fetchYardCells`, `updateYardCells` de la Task 3.
- Produce: `CompanySettings` y `CompanySettingsInput` sin `yardPickupGraceDays`.

- [ ] **Paso 1: Sacar el margen de retiro del modelo**

En `src/lib/companySettings.ts`, eliminar `yardPickupGraceDays` de la interfaz de
lectura y de la de formulario, la clave `'yard_pickup_grace_days'` de la lista de
columnas, la línea que lo lee (`yardPickupGraceDays: Number(row.yard_pickup_grace_days ?? 2)`),
el bloque que lo escribe y la línea que lo pasa al formulario.

- [ ] **Paso 2: Reemplazar el estado de cupos por un único valor**

En `src/pages/Settings.tsx`:

- Import: `import { fetchYardCells, updateYardCells } from '@/src/lib/yardCapacity';`
  (sale `YardCapacityRow`; sale también `SIZE_CLASS_LABELS` si no se usa en otro lado).
- Sacar `yardPickupGraceDays: '2'` del estado inicial del formulario.
- Reemplazar `const [cupos, setCupos] = ...` por:

```tsx
  const [celdas, setCeldas] = React.useState(0);
```

- Reemplazar el efecto de carga:

```tsx
  React.useEffect(() => {
    fetchYardCells()
      .then(setCeldas)
      .catch((err) => setCupoError(`No se pudo leer la cantidad de celdas: ${getErrorMessage(err)}`));
  }, []);
```

- [ ] **Paso 3: Conservar el guardado con respiro**

El debounce, el volcado al desmontar y el volcado al perder el foco **se
conservan**: sin ellos, escribir "25" guardaba "2". Los refs pasan de estar
indexados por tamaño a ser uno solo. Reemplazar los tres bloques
(`useEffect` de desmontaje, `guardarCupo`, `handleCupoChange`, `handleCupoBlur`)
por:

```tsx
  // El timer vive fuera del render (un ref, no estado): solo importa para
  // cancelarlo al tipear de nuevo o al desmontar.
  //
  // Al desmontar el guardado pendiente se DISPARA en vez de cancelarse: esta
  // pantalla define el número del que depende toda la disponibilidad de la
  // playa, y cancelar en silencio dejaba la base con el valor viejo aunque el
  // usuario ya viera el nuevo en el input.
  React.useEffect(() => {
    return () => {
      if (guardadoPendiente.current !== undefined) clearTimeout(guardadoPendiente.current);
      if (valorPendiente.current !== undefined) {
        updateYardCells(valorPendiente.current).catch(() => {});
      }
    };
  }, []);

  async function guardarCeldas(cantidad: number) {
    valorPendiente.current = undefined;
    try {
      await updateYardCells(cantidad);
      setCupoError(null);
    } catch (err) {
      setCupoError(`No se pudo guardar la cantidad de celdas: ${getErrorMessage(err)}`);
    }
  }

  /**
   * El input no se bloquea mientras guarda: deshabilitarlo hacía que se perdiera
   * la segunda tecla de un número de dos cifras y quedara "2" cuando el usuario
   * había escrito "25". Se escribe con un respiro después de la última tecla, y
   * un campo vacío no persiste nada — vaciarlo para reescribirlo no tiene por
   * qué dejar la playa en cero.
   */
  function handleCeldasChange(value: string) {
    const cantidad = Math.max(0, Math.trunc(Number(value)) || 0);
    setCeldas(cantidad);
    clearTimeout(guardadoPendiente.current);
    if (value.trim() === '') {
      valorPendiente.current = undefined;
      return;
    }
    valorPendiente.current = cantidad;
    guardadoPendiente.current = setTimeout(() => guardarCeldas(cantidad), 600);
  }

  /** El caso común: escribo y hago clic en otro lado antes de que venza el respiro. */
  function handleCeldasBlur() {
    if (valorPendiente.current === undefined) return;
    clearTimeout(guardadoPendiente.current);
    guardarCeldas(valorPendiente.current);
  }
```

Y declarar los refs junto a los demás:

```tsx
  const guardadoPendiente = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const valorPendiente = React.useRef<number | undefined>(undefined);
```

- [ ] **Paso 4: Reemplazar el panel visual**

Sustituir el `<Panel>` de "Capacidad de la playa" completo (los tres inputs por
tamaño y el campo de días de margen) por:

```tsx
      <Panel className="space-y-4 p-5">
        <h3 className={sectionTitleClass}><Warehouse size={14} /> Capacidad de la playa</h3>
        <p className="text-xs text-text-soft">
          Cuántas celdas tiene el taller. En cada celda entra un vehículo grande o
          hasta tres medianos. En cero, la pantalla de disponibilidad avisa que
          todavía no está configurada.
        </p>
        {cupoError && (
          <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{cupoError}</div>
        )}
        <label className={cn(labelClass, 'sm:max-w-xs')}>
          Celdas del taller
          <input
            type="number"
            min={0}
            value={celdas}
            onChange={(e) => handleCeldasChange(e.target.value)}
            onBlur={handleCeldasBlur}
            className={inputClass}
          />
        </label>
      </Panel>
```

- [ ] **Paso 5: Verificar que compila**

Run: `npx tsc --noEmit`
Esperado: solo queda fallando `ShopCapacity.tsx` (Task 6).

- [ ] **Paso 6: Probar en el navegador**

Ir a `localhost:4000/configuracion`. Verificar que:
- el panel muestra un único campo "Celdas del taller" con el valor 10,
- ya no aparece ni "Chico/Mediano/Grande" ni "Días de margen para el retiro",
- escribir `25` de corrido y hacer clic afuera guarda **25** (no `2`):
  comprobarlo con `select value from app_settings where key='yard_cells'`,
- dejarlo de nuevo en el valor que prefiera el usuario.

- [ ] **Paso 7: Commit**

```bash
git add src/pages/Settings.tsx src/lib/companySettings.ts
git commit -m "Configuración: la playa se mide en celdas"
```

---

### Task 5: Alta de OT — fecha estimada obligatoria y aviso de celdas

**Archivos:**
- Modificar: `src/lib/workOrders.ts`
- Modificar: `src/components/NewWorkOrderModal.tsx`

**Interfaces:**
- Consume: `fetchYardCells`, `fetchYardOccupancy`, `celdasOcupadas` de la Task 3.
- Produce: `NewWorkOrderInput.estimatedDeliveryDate: string | null`.

- [ ] **Paso 1: Sumar la fecha al alta**

En `src/lib/workOrders.ts`, en `NewWorkOrderInput`:

```ts
  /**
   * Obligatoria cuando se recibe un vehículo: es lo que permite proyectar
   * cuándo se libera su celda. Null para una pieza suelta, que no ocupa lugar.
   */
  estimatedDeliveryDate: string | null;
```

y en el `insert` de `createWorkOrder`, junto a `employee_id`:

```ts
      estimated_delivery_date: input.estimatedDeliveryDate,
```

- [ ] **Paso 2: Agregar el campo a la pantalla**

En `src/components/NewWorkOrderModal.tsx`:

```tsx
  const [estimatedDelivery, setEstimatedDelivery] = React.useState('');
```

y el campo, después del selector de Empleado:

```tsx
            {receptionKind === 'VEHICULO' && (
              <Label>
                Entrega estimada
                <input
                  type="date"
                  value={estimatedDelivery}
                  onChange={(e) => setEstimatedDelivery(e.target.value)}
                  className={fieldClass(true, 'font-normal normal-case')}
                />
                <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                  Cuándo se estima entregarlo. Es lo que deja proyectar cuándo se
                  libera su lugar en la playa; se puede corregir después.
                </span>
              </Label>
            )}
```

En `handleSubmit`, después de la validación de vehículo:

```ts
    // Solo para vehículos: una pieza sobre el mostrador no ocupa celda, así que
    // pedirle una fecha sería un campo obligatorio sin función — de los que se
    // terminan llenando con cualquier cosa.
    if (receptionKind === 'VEHICULO' && !estimatedDelivery) {
      setError('Poné la entrega estimada: es lo que permite saber cuándo se libera el lugar en la playa.');
      return;
    }
```

y pasarla a `createWorkOrder`:

```ts
        estimatedDeliveryDate: receptionKind === 'VEHICULO' ? estimatedDelivery : null,
```

- [ ] **Paso 3: Recuperar el aviso de lugar**

Este aviso existía y se perdió cuando la recepción pasó a la OT (vivía en
`VehicleIntakes.tsx`, borrado en esa migración). Agregar en el modal:

```tsx
  // Cuánto lugar queda, para avisar —nunca para bloquear—. El vehículo ya está
  // en la puerta del taller: un sistema que impide registrarlo solo consigue
  // que el dato deje de cargarse.
  const [celdasLibres, setCeldasLibres] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([fetchYardCells(), fetchYardOccupancy()])
      .then(([celdas, ocupantes]) => {
        if (!cancelled) setCeldasLibres(celdas - celdasOcupadas(ocupantes));
      })
      .catch(() => {/* informativo: si falla, el alta sigue funcionando igual */});
    return () => { cancelled = true; };
  }, []);
```

y mostrarlo debajo del selector de "Qué se recibe", solo para vehículo:

```tsx
            {receptionKind === 'VEHICULO' && celdasLibres !== null && (
              <p className={cn(
                'border px-3 py-2 text-[11px]',
                celdasLibres > 0
                  ? 'border-line bg-panel-alt text-text-soft'
                  : 'border-danger/40 bg-danger-soft text-danger'
              )}>
                {celdasLibres > 0
                  ? `Quedan ${celdasLibres} celda${celdasLibres === 1 ? '' : 's'} libre${celdasLibres === 1 ? '' : 's'} en la playa.`
                  : 'La playa está completa. Se puede recibir igual, pero no hay celda libre.'}
              </p>
            )}
```

- [ ] **Paso 4: Verificar que compila**

Run: `npx tsc --noEmit`
Esperado: solo `ShopCapacity.tsx` (Task 6).

- [ ] **Paso 5: Probar en el navegador**

En `localhost:4000/ordenes`, "Nueva orden". Verificar que:
- con "Vehículo" aparecen el aviso de celdas libres y el campo Entrega estimada,
- al cambiar a "Pieza suelta" desaparecen los dos,
- intentar crear un vehículo sin fecha muestra el mensaje del Paso 2,
- con fecha, la OT se crea y la fecha queda guardada:
  `select number, estimated_delivery_date from work_orders order by created_at desc limit 1`.

**Usar el cliente Agrícola del Sur** (crear una OT manda un WhatsApp real, y ese
número es el del propio usuario). Borrar la OT de prueba al terminar, desde el
listado de OT.

- [ ] **Paso 6: Commit**

```bash
git add src/lib/workOrders.ts src/components/NewWorkOrderModal.tsx
git commit -m "El alta de OT pide la entrega estimada y avisa el lugar"
```

---

### Task 6: La pantalla de disponibilidad

**Archivos:**
- Modificar: `src/pages/ShopCapacity.tsx`

**Interfaces:**
- Consume: todo lo que produce la Task 3.
- Produce: nada que otra tarea use.

- [ ] **Paso 1: Reemplazar la carga de datos**

En `src/pages/ShopCapacity.tsx`, los imports pasan a:

```tsx
import {
  celdasOcupadas,
  fetchYardCells,
  fetchYardOccupancy,
  hoyISO,
  proyectarDisponibilidad,
  sinFechaEstimada,
  vencidas,
  type YardOccupant,
} from '@/src/lib/yardCapacity';
```

El estado y la carga:

```tsx
  const [cells, setCells] = React.useState(0);
  const [occupancy, setOccupancy] = React.useState<YardOccupant[]>([]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [celdas, rows] = await Promise.all([fetchYardCells(), fetchYardOccupancy()]);
      setCells(celdas);
      setOccupancy(rows);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
```

Sale `fetchCompanySettings` y todo lo relativo a `graceDays`.

Los derivados:

```tsx
  const hoy = hoyISO();
  const ocupadas = React.useMemo(() => celdasOcupadas(occupancy), [occupancy]);
  const libres = cells - ocupadas;
  const linea = React.useMemo(
    () => proyectarDisponibilidad(cells, occupancy, 14, hoy),
    [cells, occupancy, hoy]
  );
  const sinFecha = React.useMemo(() => sinFechaEstimada(occupancy), [occupancy]);
  const atrasadas = React.useMemo(() => vencidas(occupancy, hoy), [occupancy, hoy]);
  const sinConfigurar = cells === 0;
```

- [ ] **Paso 2: Reemplazar las tarjetas de cupo por el número de celdas**

Sustituir el bloque que hoy recorre `summary` por:

```tsx
      <Panel className="p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              Celdas libres
            </span>
            <span className={cn(
              'font-display text-5xl font-medium',
              libres < 0 ? 'text-danger' : 'text-text'
            )}>
              {loading ? '—' : libres}
            </span>
            <span className="ml-2 text-sm text-text-soft">de {cells}</span>
          </div>
          <p className="max-w-md text-xs text-text-soft">
            En cada celda entra un vehículo grande o hasta tres medianos. El lugar
            que sobra en una celda a medio llenar no se cuenta como disponible.
          </p>
        </div>

        {libres < 0 && (
          <p className="mt-3 border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
            Hay más vehículos que celdas: la playa está desbordada.
          </p>
        )}

        {(sinFecha.length > 0 || atrasadas.length > 0) && (
          <p className="mt-3 text-xs text-text-soft">
            {sinFecha.length > 0 && <>{sinFecha.length} sin fecha estimada. </>}
            {atrasadas.length > 0 && <>{atrasadas.length} con la fecha vencida. </>}
            Ocupan celda todos los días proyectados, porque no hay con qué saber
            cuándo se liberan.
          </p>
        )}
      </Panel>
```

Conservar el aviso de `sinConfigurar` que ya existe, cambiando su texto a
"Todavía no cargaste cuántas celdas tiene el taller. Configurala en
Configuración."

- [ ] **Paso 3: Reemplazar "próximas salidas" por la línea de tiempo**

Sustituir el bloque de `upcoming` por:

```tsx
      <Panel className="p-5">
        <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
          Celdas libres día por día
        </h2>
        <p className="mb-3 text-xs text-text-soft">
          Suponiendo que cada orden se retire en su fecha estimada. Es una
          proyección, no una promesa: una fecha que se corre arrastra todo lo que
          viene atrás.
        </p>
        <div className="overflow-x-auto">
          <div className="flex gap-2">
            {linea.map((dia) => (
              <div
                key={dia.date}
                className={cn(
                  'min-w-[64px] border p-2 text-center',
                  dia.freeCells < 0 ? 'border-danger/40 bg-danger-soft' : 'border-line bg-panel-alt'
                )}
              >
                <span className="block text-[10px] uppercase tracking-[0.06em] text-text-soft">
                  {formatDate(dia.date)}
                </span>
                <span className={cn(
                  'block font-display text-xl font-medium',
                  dia.freeCells < 0 ? 'text-danger' : 'text-text'
                )}>
                  {dia.freeCells}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Panel>
```

- [ ] **Paso 4: Ajustar la tabla de ocupantes**

La tabla se conserva. Cambiar solo la columna "Tamaño" para que use
`SIZE_CLASS_LABELS` con los dos valores (ya lo hace; verificar que compila) y
quitar cualquier referencia a `graceDays` o a la fecha de liberación calculada
con margen: donde se mostraba la liberación esperada, mostrar directamente
`estimatedDeliveryDate`.

- [ ] **Paso 5: Verificar que compila y construye**

Run: `npx tsc --noEmit`
Esperado: sin errores en todo el proyecto.

Run: `npm run build`
Esperado: `✓ built`.

- [ ] **Paso 6: Probar contra datos reales**

En `localhost:4000/disponibilidad-taller`, con las OT que existan:

1. Anotar cuántos vehículos hay ocupando y de qué tamaño.
2. Calcular a mano `grandes + techo(medianos/3)` y comprobar que "Celdas libres"
   da `celdas − ese número`.
3. Cambiar la entrega estimada de una OT a mañana y verificar que la línea de
   tiempo suma una celda a partir de pasado mañana (ocupa hasta mañana
   inclusive).
4. Borrarle la fecha a una OT y verificar que aparece en "sin fecha estimada" y
   ocupa toda la línea.

- [ ] **Paso 7: Commit**

```bash
git add src/pages/ShopCapacity.tsx
git commit -m "Disponibilidad: celdas libres y línea de tiempo"
```

---

## Autorrevisión

**Cobertura del spec.** Cada sección tiene tarea: el cálculo y el hueco no
publicado (Task 3, con chequeo numérico); quién ocupa y hasta cuándo (Task 3,
`ocupaEnFecha`); línea de tiempo con recálculo por día (Task 3 + Task 6);
sin fecha y vencidas (Task 3 + Task 6); Configuración (Task 4); alta de vehículo
sin preselección (Task 2); alta de OT con fecha obligatoria y aviso recuperado
(Task 5); datos —CHICO, `yard_cells`, margen— (Task 1). `estimated_delivery_date`
queda nullable: ninguna tarea la toca en la base, que es lo que pide el spec.

**Sin marcadores de posición.** Todos los pasos de código llevan el código real.
Los dos únicos textos a completar por el ejecutor son la ruta del scratchpad en
la Task 3 y los números observados en la Task 6, que dependen del entorno.

**Consistencia de tipos.** `SizeClass` se reduce en la Task 2 y se consume en la
3; `MEDIANOS_POR_CELDA` se define en la 2 y se usa en la 3;
`fetchYardCells`/`updateYardCells` se definen en la 3 y se consumen en la 4 y la
5; `celdasOcupadas` se define en la 3 y se consume en la 5 y la 6;
`NewWorkOrderInput.estimatedDeliveryDate` se define en la 5 y no la consume
nadie más. `VehicleInput.sizeClass` pasa a `SizeClass | ''` en la Task 2 y solo
la usa `VehicleModal`.

**Orden.** Las Tasks 2 a 5 dejan `ShopCapacity.tsx` sin compilar a propósito;
cada paso de verificación lo dice para que no se confunda con una rotura. La
Task 6 lo cierra.
