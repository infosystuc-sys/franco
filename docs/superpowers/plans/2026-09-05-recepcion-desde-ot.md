# La recepción arranca en la OT — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que recibir un vehículo sea abrir una orden de trabajo, y que el módulo de Ingreso de vehículos desaparezca.

**Architecture:** La OT gana lo que hoy tiene el ingreso —qué se recibió, observaciones y piezas con número de serie— y nace en un estado nuevo, "Ingresado". La cotización se arma desde la OT y la vincula; aceptarla copia los renglones en esa OT que ya existe, en vez de crear una nueva. El módulo de cotizaciones no cambia: solo su decisión ahora mueve la OT.

**Tech Stack:** React 19 + TypeScript + Vite, Supabase (Postgres + RLS + RPC), Tailwind. Sin test runner: la verificación es `npx tsc --noEmit`, `npm run build`, SQL contra la base real y prueba manual con Playwright.

**Spec:** [`docs/superpowers/specs/2026-09-03-recepcion-desde-ot-design.md`](../specs/2026-09-03-recepcion-desde-ot-design.md)

## Global Constraints

- **Estados nuevos, con sus marcas exactas:** `Ingresado` (is_initial=true, is_terminal=false, frees_yard=false, notifies_client=false), `Cotizado` (todo false), `Rechazada` (is_terminal=**false**, frees_yard=**true**, notifies_client=false). "Autorizada" deja de ser inicial y no cambia en nada más.
- **"Rechazada" no puede ser terminal.** El disparador `block_terminal_while_price_pending` salta al pasar de no terminal a terminal cuando el total difiere del presupuestado sin autorizar — y una OT en "Cotizado" todavía no tiene renglones copiados, así que su total es cero contra un presupuesto que no lo es. Marcarla terminal haría imposible registrar un rechazo.
- **`reception_kind`:** exactamente `VEHICULO` o `PIEZA`. Es lo que decide si la OT ocupa lugar en la playa, y **no se deduce de si hay vehículo**: una pieza puede tener vehículo elegido (la bomba del Scania que no está en el taller).
- **La ocupación de la playa cuenta OT con `reception_kind = 'VEHICULO'` cuyo estado no libera la playa**, deduplicando por vehículo. Nada de esto mira al empleado asignado.
- **Una OT está pendiente si no es terminal Y su estado no libera la playa.** Sin esa segunda condición cada rechazo queda figurando como trabajo por hacer para siempre.
- **Crear una OT le manda un WhatsApp al cliente** (`work_orders_enqueue_created`). La migración crea 8 de una vez: tiene que descartar esas notificaciones **en la misma transacción**.
- Todo el texto de UI y los comentarios van en español, explicando el *por qué*, no el *qué*.
- `npx tsc --noEmit` sin salida y `npm run build` exitoso antes de cada commit.
- **Proyecto Supabase:** `mnoqdqjhsylohlvuekfh`. Migraciones con la herramienta MCP `apply_migration`, y además guardadas como archivo en `supabase/`.
- **Los subagentes de este entorno no pueden commitear ni mutar la base**: el clasificador de permisos los rechaza. Escriben código y verifican; el commit y las migraciones los hace el coordinador.

## Lo que ya existe y hay que reusar, no reinventar

Relevado antes de escribir el plan:

| Ya existe | Dónde | Para qué sirve acá |
|---|---|---|
| Alta manual de OT | [`NewWorkOrderModal.tsx`](../../../src/components/NewWorkOrderModal.tsx), 164 líneas | Es la base de la recepción: ya elige cliente, vehículo y componente. Se le suman los campos nuevos. |
| `createWorkOrder(input)` | [`workOrders.ts:405`](../../../src/lib/workOrders.ts) | Crea la OT en el estado inicial. Solo hay que ampliar su input. |
| Fotos de la OT | `work_order_photos` + bucket `work-order-photos` | No hay nada que construir del lado de fotos. |
| `setWorkOrderStatus(id, statusId)` | [`workOrders.ts:560`](../../../src/lib/workOrders.ts) | Mover la OT a Cotizado / Rechazada. |
| `quotations.work_order_id` | tabla `quotations` | El vínculo cotización↔OT ya tiene su columna. |

---

### Task 1: Migración de base

Toda la estructura nueva y la conversión de los ingresos existentes, en una sola migración.

**Files:**
- Create: `supabase/reception-from-work-order.sql`
- Apply: MCP `apply_migration`, proyecto `mnoqdqjhsylohlvuekfh`, nombre `reception_from_work_order`

**Interfaces:**
- Consumes: nada.
- Produces: `work_orders.reception_kind` (text not null default `'VEHICULO'`, check en VEHICULO/PIEZA), `work_orders.observations` (text), `work_orders.vehicle_id` pasa a nullable; tabla `work_order_received_parts(id, work_order_id, name, serial_number, created_at)`; estados `Ingresado`, `Cotizado`, `Rechazada`; 8 OT nuevas migradas desde los ingresos.

- [ ] **Step 1: Escribir la migración**

Crear `supabase/reception-from-work-order.sql`:

```sql
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
insert into public.work_order_statuses
  (label, client_description, color, sort_order, active, is_initial, is_terminal, notifies_client, frees_yard)
values
  ('Ingresado', 'Recibimos el vehículo en el taller.', '#4a6fa5', 0, true, true, false, false, false),
  ('Cotizado',  'Te enviamos el presupuesto y esperamos tu respuesta.', '#e07b1a', 1, true, false, false, false, false),
  ('Rechazada', 'El presupuesto no fue aceptado.', '#8a8f98', 99, true, false, false, false, true);

-- "Autorizada" deja de ser el estado inicial: ahora la OT nace en Ingresado.
update public.work_order_statuses set is_initial = false where label = 'Autorizada';

-- 4) Los ingresos que hoy están abiertos pasan a ser OT ---------------------
-- Los que ya derivaron en una OT no se convierten: su información ya vive ahí.
with a_migrar as (
  select i.*,
    case when i.status::text = 'COTIZADO' then 'Cotizado' else 'Ingresado' end as estado_destino
  from public.vehicle_intakes i
  where not exists (
    select 1 from public.work_orders w
    where w.quotation_id = i.quotation_id and i.quotation_id is not null
  )
),
creadas as (
  insert into public.work_orders
    (status_id, customer_id, vehicle_id, quotation_id, observations, reception_kind)
  select s.id, m.customer_id, m.vehicle_id, m.quotation_id, m.observations, 'VEHICULO'
  from a_migrar m
  join public.work_order_statuses s on s.label = m.estado_destino
  returning id, quotation_id, vehicle_id, created_at
)
insert into public.work_order_received_parts (work_order_id, name, serial_number, created_at)
select c.id, p.name, p.serial_number, p.created_at
from creadas c
join a_migrar m on m.vehicle_id = c.vehicle_id
  and (m.quotation_id is not distinct from c.quotation_id)
join public.vehicle_intake_parts p on p.intake_id = m.id;

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
```

- [ ] **Step 2: Aplicar la migración**

Con MCP `apply_migration`, nombre `reception_from_work_order`, pasando el contenido del archivo.

Si el `with ... insert ... returning` del paso 4 da problemas de correlación (no todos los motores dejan unir el `returning` con la CTE de origen), aplicarlo en dos pasos: primero el insert de las OT, después las piezas resolviendo el vínculo por `vehicle_id` + `quotation_id`. Anotar en el reporte cuál de las dos formas se usó.

- [ ] **Step 3: Verificar la estructura y la migración**

```sql
select
  (select count(*) from information_schema.columns
    where table_name='work_orders' and column_name='reception_kind') as col_kind,
  (select count(*) from information_schema.columns
    where table_name='work_orders' and column_name='observations') as col_obs,
  (select is_nullable from information_schema.columns
    where table_name='work_orders' and column_name='vehicle_id') as vehiculo_opcional,
  (select count(*) from public.work_order_statuses where label in ('Ingresado','Cotizado','Rechazada')) as estados_nuevos,
  (select label from public.work_order_statuses where is_initial) as estado_inicial,
  (select count(*) from public.work_order_statuses where frees_yard) as liberan_playa;
```

Esperado exacto: `col_kind = 1`, `col_obs = 1`, `vehiculo_opcional = 'YES'`, `estados_nuevos = 3`, `estado_inicial = 'Ingresado'`, `liberan_playa = 2` (Retirado y Rechazada).

- [ ] **Step 4: Verificar las OT migradas**

```sql
select s.label, count(*) as ot,
       count(*) filter (where w.quotation_id is not null) as con_cotizacion
from public.work_orders w
join public.work_order_statuses s on s.id = w.status_id
where s.label in ('Ingresado','Cotizado')
group by s.label order by s.label;

select count(*) as piezas_migradas from public.work_order_received_parts;
```

Esperado: `Cotizado = 3` (los tres con cotización, que salen de ING-5, ING-6 e ING-7), `Ingresado = 5` (ING-3, ING-4, ING-8, ING-9, ING-10, sin cotización), y `piezas_migradas = 2` (las dos de ING-4).

- [ ] **Step 5: Verificar que no se le escribió a ningún cliente**

```sql
select count(*) as notificaciones_pendientes
from public.notifications
where status::text not in ('ENVIADO','DESCARTADO');
```

Esperado: **0**. Si da distinto de cero, hay mensajes en cola para clientes reales: hay que descartarlos antes de seguir.

- [ ] **Step 6: Commit**

El coordinador commitea `supabase/reception-from-work-order.sql` con el mensaje:
`Recepción desde la OT: estructura de base y migración de los ingresos abiertos`

---

### Task 2: La OT sabe qué se recibió

**Files:**
- Modify: `src/lib/workOrders.ts`

**Interfaces:**
- Consumes: las columnas y la tabla de la Task 1.
- Produces:
  - `type ReceptionKind = 'VEHICULO' | 'PIEZA'` y `RECEPTION_KIND_LABELS: Record<ReceptionKind, string>` = `{ VEHICULO: 'Vehículo', PIEZA: 'Pieza suelta' }`
  - `NewWorkOrderInput` gana `receptionKind: ReceptionKind`, `observations: string`, y `vehicleId: string` pasa a `vehicleId: string | null`
  - `WorkOrderDetail` gana `receptionKind: ReceptionKind`, `observations: string | null`, `receivedParts: ReceivedPart[]`
  - `interface ReceivedPart { id: string; name: string; serialNumber: string; }`
  - `addReceivedPart(workOrderId: string, name: string, serialNumber: string): Promise<ReceivedPart>`
  - `deleteReceivedPart(id: string): Promise<void>`
  - `updateWorkOrderObservations(workOrderId: string, observations: string): Promise<void>`

- [ ] **Step 1: Tipos y etiquetas**

En `src/lib/workOrders.ts`, junto a los demás tipos del módulo:

```ts
/**
 * Qué se recibió. No se deduce de si hay vehículo elegido: el caso común es
 * "traigo la bomba del Scania patente XYZ", donde el vehículo está en el
 * padrón y se elige, pero el camión no está en la playa. Esta marca es la que
 * decide si la OT descuenta un lugar.
 */
export type ReceptionKind = 'VEHICULO' | 'PIEZA';

export const RECEPTION_KIND_LABELS: Record<ReceptionKind, string> = {
  VEHICULO: 'Vehículo',
  PIEZA: 'Pieza suelta',
};

export const RECEPTION_KINDS = Object.keys(RECEPTION_KIND_LABELS) as ReceptionKind[];

export interface ReceivedPart {
  id: string;
  name: string;
  serialNumber: string;
}
```

- [ ] **Step 2: Ampliar el alta**

Reemplazar `NewWorkOrderInput` y el cuerpo de `createWorkOrder` (líneas 394-429):

```ts
export interface NewWorkOrderInput {
  customerId: string;
  /** Opcional: una OT de pieza suelta puede no tener vehículo. */
  vehicleId: string | null;
  component: string;
  receptionKind: ReceptionKind;
  observations: string;
}

/**
 * Recibir es abrir la orden: la OT nace en el estado inicial ("Ingresado")
 * con lo que se observó en el mostrador. El número lo asigna la secuencia de
 * la base.
 */
export async function createWorkOrder(input: NewWorkOrderInput) {
  const { data: initial, error: initialError } = await supabase
    .from('work_order_statuses')
    .select('id')
    .eq('is_initial', true)
    .limit(1)
    .maybeSingle();
  if (initialError) throw initialError;
  if (!initial) {
    throw new Error('No hay un estado inicial configurado para las órdenes de trabajo. Marcá uno desde Estados de OT.');
  }

  const { data: workOrder, error } = await supabase
    .from('work_orders')
    .insert({
      status_id: initial.id,
      customer_id: input.customerId,
      vehicle_id: input.vehicleId,
      component: input.component || null,
      reception_kind: input.receptionKind,
      observations: input.observations.trim() || null,
    })
    .select()
    .single();
  if (error) throw error;

  return workOrder;
}
```

- [ ] **Step 3: Traer los campos nuevos en el detalle**

En `fetchWorkOrderByNumber` (línea 488), agregar a la lista de columnas del `select` los campos `reception_kind, observations` y la relación de piezas:

```
reception_kind, observations,
received_parts:work_order_received_parts(id, name, serial_number),
```

En `WorkOrderDetail` agregar:

```ts
  receptionKind: ReceptionKind;
  observations: string | null;
  receivedParts: ReceivedPart[];
```

Y en el mapeo del detalle:

```ts
    receptionKind: row.reception_kind,
    observations: row.observations,
    receivedParts: (row.received_parts ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      serialNumber: p.serial_number,
    })),
```

- [ ] **Step 4: Alta y baja de piezas, y observaciones**

Al final de `src/lib/workOrders.ts`:

```ts
/** Las piezas que el cliente dejó con el vehículo, con su número de serie. */
export async function addReceivedPart(
  workOrderId: string,
  name: string,
  serialNumber: string
): Promise<ReceivedPart> {
  const { data, error } = await supabase
    .from('work_order_received_parts')
    .insert({ work_order_id: workOrderId, name: name.trim(), serial_number: serialNumber.trim() })
    .select('id, name, serial_number')
    .single();
  if (error) throw error;
  return { id: data.id, name: data.name, serialNumber: data.serial_number };
}

export async function deleteReceivedPart(id: string): Promise<void> {
  const { error } = await supabase.from('work_order_received_parts').delete().eq('id', id);
  if (error) throw error;
}

export async function updateWorkOrderObservations(workOrderId: string, observations: string): Promise<void> {
  const { error } = await supabase
    .from('work_orders')
    .update({ observations: observations.trim() || null })
    .eq('id', workOrderId);
  if (error) throw error;
}
```

- [ ] **Step 5: Compilar**

```bash
npx tsc --noEmit
```

Esperado: errores **solo** en `src/components/NewWorkOrderModal.tsx`, que llama a `createWorkOrder` sin los campos nuevos. Se arregla en la Task 3. Si aparece un error en otro archivo, es otro consumidor de `NewWorkOrderInput` que hay que anotar.

- [ ] **Step 6: Commit**

`La OT registra qué se recibió, las observaciones y las piezas`

---

### Task 3: La recepción es el alta de la OT

**Files:**
- Modify: `src/components/NewWorkOrderModal.tsx`

**Interfaces:**
- Consumes: `NewWorkOrderInput`, `ReceptionKind`, `RECEPTION_KINDS`, `RECEPTION_KIND_LABELS`, `addReceivedPart` de `src/lib/workOrders.ts` (Task 2).
- Produces: nada que consuman otras tareas.

- [ ] **Step 1: Estado nuevo del formulario**

En `src/components/NewWorkOrderModal.tsx`, junto a los `useState` existentes (líneas 22-28):

```tsx
  const [receptionKind, setReceptionKind] = React.useState<ReceptionKind>('VEHICULO');
  const [observations, setObservations] = React.useState('');
  // Las piezas se juntan acá y se guardan recién cuando la OT existe: no hay
  // work_order_id contra el cual insertarlas hasta ese momento.
  const [parts, setParts] = React.useState<{ name: string; serialNumber: string }[]>([]);
  const [partName, setPartName] = React.useState('');
  const [partSerial, setPartSerial] = React.useState('');
```

Agregar al import de `@/src/lib/workOrders`: `RECEPTION_KINDS`, `RECEPTION_KIND_LABELS`, `addReceivedPart`, y el tipo `ReceptionKind`.

- [ ] **Step 2: Qué se recibe, arriba de todo**

Antes del campo de cliente, agregar el selector. Va primero porque decide si el vehículo es obligatorio:

```tsx
            <Label>
              Qué se recibe
              <select
                value={receptionKind}
                onChange={(e) => setReceptionKind(e.target.value as ReceptionKind)}
                className={fieldClass(false, 'font-normal normal-case bg-panel')}
              >
                {RECEPTION_KINDS.map((k) => (
                  <option key={k} value={k}>{RECEPTION_KIND_LABELS[k]}</option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Una pieza suelta no ocupa lugar en la playa, aunque se elija de qué equipo salió.
              </span>
            </Label>
```

Usar las clases que el archivo ya use para sus `Label`/`select`; si difieren de `fieldClass`, copiar las del campo de cliente vecino.

- [ ] **Step 3: El vehículo deja de ser obligatorio para una pieza**

En el `<select>` de vehículo, cambiar la primera opción para que refleje cuándo se puede dejar vacío:

```tsx
                <option value="">
                  {receptionKind === 'PIEZA' ? 'Sin vehículo (opcional)' : 'Elegí un vehículo...'}
                </option>
```

- [ ] **Step 4: Observaciones y piezas recibidas**

Después del campo de componente:

```tsx
            <Label>
              Observaciones de la recepción
              <textarea
                value={observations}
                onChange={(e) => setObservations(e.target.value)}
                rows={2}
                placeholder="Estado en que llegó, faltantes, lo que dijo el cliente..."
                className={fieldClass(false, 'font-normal normal-case resize-y')}
              />
            </Label>

            <div className="space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-text-soft">
                Piezas recibidas
              </span>
              {parts.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {parts.map((p, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span>{p.name} — <span className="font-mono text-xs">{p.serialNumber}</span></span>
                      <button
                        type="button"
                        onClick={() => setParts((c) => c.filter((_, j) => j !== i))}
                        aria-label={`Quitar ${p.name}`}
                        className="text-text-soft hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <input
                  value={partName}
                  onChange={(e) => setPartName(e.target.value)}
                  placeholder="Bomba inyectora"
                  className={fieldClass(false, 'font-normal normal-case mt-0 flex-1')}
                />
                <input
                  value={partSerial}
                  onChange={(e) => setPartSerial(e.target.value)}
                  placeholder="N° de serie"
                  className={fieldClass(false, 'font-normal normal-case mt-0 w-40 font-mono')}
                />
                <button
                  type="button"
                  disabled={!partName.trim() || !partSerial.trim()}
                  onClick={() => {
                    setParts((c) => [...c, { name: partName.trim(), serialNumber: partSerial.trim() }]);
                    setPartName('');
                    setPartSerial('');
                  }}
                  className="border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt disabled:opacity-50"
                >
                  Agregar
                </button>
              </div>
            </div>
```

Agregar `Trash2` al import de `lucide-react`.

- [ ] **Step 5: Guardar**

Reemplazar la llamada a `createWorkOrder` (línea 66) por:

```tsx
      const workOrder = await createWorkOrder({
        customerId,
        vehicleId: vehicleId || null,
        component,
        receptionKind,
        observations,
      });
      // Las piezas van después: recién ahora existe la OT contra la cual
      // colgarlas. Si alguna falla, la OT ya está creada y no se pierde la
      // recepción — se avisa y se cargan desde el detalle.
      for (const p of parts) {
        await addReceivedPart(workOrder.id, p.name, p.serialNumber);
      }
```

Y agregar, antes de guardar, la única validación nueva:

```tsx
    if (receptionKind === 'VEHICULO' && !vehicleId) {
      setError('Elegí el vehículo que estás recibiendo, o cambiá "Qué se recibe" a pieza suelta.');
      return;
    }
```

Quitar la validación vieja que exigía `vehicleId` siempre, si existe.

- [ ] **Step 6: Compilar y construir**

```bash
npx tsc --noEmit && npm run build
```

Esperado: `tsc` sin salida, build exitoso.

- [ ] **Step 7: Probar la recepción a mano**

En `http://localhost:4000/ordenes`, botón "Nueva orden":

1. Con "Qué se recibe" en **Vehículo** y sin elegir vehículo, guardar → tiene que rechazar con el mensaje del Step 5.
2. Elegir cliente y vehículo, escribir una observación, agregar una pieza con serie, guardar → lleva al detalle de la OT nueva, que tiene que estar en **Ingresado**.
3. Repetir con "Qué se recibe" en **Pieza suelta** y sin vehículo → tiene que dejar guardar.

Anotar los números de las dos OT creadas: se borran al final de la tarea con SQL, para no dejar datos de prueba:

```sql
delete from public.work_orders where number in ('<OT-a>', '<OT-b>');
```

Y confirmar que la ocupación de la playa volvió al valor previo.

- [ ] **Step 8: Commit**

`Recibir un vehículo o una pieza es abrir la orden de trabajo`

---

### Task 4: Piezas y observaciones en el detalle de la OT

**Files:**
- Modify: `src/pages/WorkOrderDetails.tsx`

**Interfaces:**
- Consumes: `WorkOrderDetail.receptionKind/observations/receivedParts`, `addReceivedPart`, `deleteReceivedPart`, `updateWorkOrderObservations`, `RECEPTION_KIND_LABELS` (Task 2).
- Produces: nada.

- [ ] **Step 1: Sección de recepción**

En `src/pages/WorkOrderDetails.tsx`, agregar un `<Panel>` nuevo junto a la sección de Fotos (que arranca en la línea 546 y sirve de modelo de estructura):

```tsx
      <Panel className="space-y-4 p-5">
        <SectionHeader title={`Recepción · ${RECEPTION_KIND_LABELS[order.receptionKind]}`} />

        <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
          Observaciones
          <textarea
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            onBlur={handleSaveObservations}
            disabled={!isAdmin}
            rows={2}
            className="mt-1 w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none disabled:bg-panel-alt"
          />
        </label>

        <div className="space-y-2">
          <span className="text-xs font-bold uppercase tracking-wider text-text-soft">
            Piezas recibidas{order.receivedParts.length > 0 && ` (${order.receivedParts.length})`}
          </span>
          {order.receivedParts.length === 0 ? (
            <p className="text-sm text-text-soft">No se registraron piezas al recibir.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {order.receivedParts.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span>{p.name} — <span className="font-mono text-xs">{p.serialNumber}</span></span>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => handleDeletePart(p.id)}
                      aria-label={`Quitar ${p.name}`}
                      className="text-text-soft transition-colors hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {isAdmin && (
            <div className="flex gap-2">
              <input
                value={partName}
                onChange={(e) => setPartName(e.target.value)}
                placeholder="Bomba inyectora"
                className="mt-0 flex-1 rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
              />
              <input
                value={partSerial}
                onChange={(e) => setPartSerial(e.target.value)}
                placeholder="N° de serie"
                className="mt-0 w-40 rounded-md border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-accent-deep focus:outline-none"
              />
              <button
                type="button"
                disabled={!partName.trim() || !partSerial.trim()}
                onClick={handleAddPart}
                className="border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt disabled:opacity-50"
              >
                Agregar
              </button>
            </div>
          )}
        </div>
      </Panel>
```

- [ ] **Step 2: Estado y handlers**

Dentro del componente, con los demás `useState`:

```tsx
  const [observations, setObservations] = React.useState('');
  const [partName, setPartName] = React.useState('');
  const [partSerial, setPartSerial] = React.useState('');
```

Sincronizar cuando llega la orden (junto a donde ya se setean otros campos desde `order`):

```tsx
  React.useEffect(() => {
    setObservations(order?.observations ?? '');
  }, [order?.id, order?.observations]);
```

Y los tres handlers:

```tsx
  /** Se guarda al salir del campo: es una nota larga, no tiene sentido un botón propio. */
  async function handleSaveObservations() {
    if (!order || observations === (order.observations ?? '')) return;
    try {
      await updateWorkOrderObservations(order.id, observations);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleAddPart() {
    if (!order) return;
    try {
      await addReceivedPart(order.id, partName, partSerial);
      setPartName('');
      setPartSerial('');
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDeletePart(id: string) {
    try {
      await deleteReceivedPart(id);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }
```

Usar los nombres reales del archivo para la recarga y el error (`load`/`setError` si es como en las demás pantallas; si difieren, adaptarlos y anotarlo).

- [ ] **Step 3: Compilar y construir**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 4: Probar a mano**

Abrir una de las OT migradas que tenga piezas (la que salió de ING-4 tiene 2). Verificar:
1. La sección "Recepción · Vehículo" muestra las 2 piezas con su número de serie.
2. Agregar una pieza y que aparezca; borrarla y que desaparezca.
3. Escribir una observación, salir del campo, recargar la página y que siga ahí.

Dejar la OT como estaba: la pieza agregada se borra desde la misma pantalla, y la observación se vacía si no tenía.

- [ ] **Step 5: Commit**

`Piezas recibidas y observaciones en el detalle de la OT`

---

### Task 5: Cotizar desde la OT

**Files:**
- Create: `supabase/link-quotation-to-work-order.sql`
- Modify: `src/lib/quotations.ts`
- Modify: `src/pages/WorkOrderDetails.tsx`

**Interfaces:**
- Consumes: `setWorkOrderStatus` de `src/lib/workOrders.ts`; el estado `Cotizado` (Task 1).
- Produces: `linkQuotationToWorkOrder(quotationId: string, workOrderId: string): Promise<void>` en `src/lib/quotations.ts`.

- [ ] **Step 1: La RPC del vínculo**

Crear `supabase/link-quotation-to-work-order.sql`:

```sql
-- ===========================================================================
-- Enganchar una cotización a la OT que la origina
-- ===========================================================================
-- Migración: link_quotation_to_work_order
--
-- El vínculo vive en dos lados (quotations.work_order_id y
-- work_orders.quotation_id) y mover la OT a "Cotizado" es parte del mismo
-- acto. Hacerlo en tres updates sueltos desde el navegador deja estados a
-- medias si uno falla.

create or replace function public.link_quotation_to_work_order(
  p_quotation_id uuid,
  p_work_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cotizado uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if exists (select 1 from quotations where id = p_quotation_id and work_order_id is not null
             and work_order_id <> p_work_order_id) then
    raise exception 'Esa cotización ya está enganchada a otra orden de trabajo.';
  end if;

  select id into v_cotizado from work_order_statuses where label = 'Cotizado';
  if v_cotizado is null then
    raise exception 'Falta el estado "Cotizado" en el ABM de estados de OT.';
  end if;

  update quotations set work_order_id = p_work_order_id where id = p_quotation_id;
  update work_orders set quotation_id = p_quotation_id where id = p_work_order_id;

  -- Solo avanza la OT si todavía está en la recepción: una orden que ya está
  -- en reparación no vuelve para atrás porque se le adjunte un presupuesto.
  update work_orders w
  set status_id = v_cotizado
  from work_order_statuses s
  where w.id = p_work_order_id and s.id = w.status_id and s.label = 'Ingresado';
end;
$$;

grant execute on function public.link_quotation_to_work_order(uuid, uuid) to authenticated;
```

Aplicar con MCP `apply_migration`, nombre `link_quotation_to_work_order`.

- [ ] **Step 2: El cliente**

En `src/lib/quotations.ts`:

```ts
/**
 * Engancha la cotización a la OT que la origina y mueve la orden a
 * "Cotizado". Sirve tanto para la cotización que se arma desde la OT como
 * para una suelta —el presupuesto que se hizo por teléfono— que después se
 * asocia cuando el cliente trae el vehículo.
 */
export async function linkQuotationToWorkOrder(quotationId: string, workOrderId: string): Promise<void> {
  const { error } = await supabase.rpc('link_quotation_to_work_order', {
    p_quotation_id: quotationId,
    p_work_order_id: workOrderId,
  });
  if (error) throw error;
}
```

- [ ] **Step 3: El botón en la OT**

En `src/pages/WorkOrderDetails.tsx`, junto a las acciones del encabezado, un botón que crea la cotización con el cliente y el vehículo ya cargados y la engancha:

```tsx
            {isAdmin && !order.quotationNumber && (
              <Button
                type="button"
                variant="secondary"
                disabled={cotizando}
                onClick={handleCotizar}
              >
                <Receipt size={16} /> {cotizando ? 'Creando…' : 'Cotizar'}
              </Button>
            )}
```

Con el handler:

```tsx
  /**
   * Arma la cotización de esta OT y la deja enganchada. El presupuesto se
   * completa después en el módulo de cotizaciones, que es donde vive la
   * aceptación y el rechazo.
   */
  async function handleCotizar() {
    if (!order) return;
    setCotizando(true);
    try {
      const creada = await createQuotation({
        customerId: order.customer.id,
        vehicleId: order.vehicle?.id ?? null,
        component: order.component ?? '',
        validUntil: defaultValidUntil(),
        // Lo observado al recibir arranca como nota del presupuesto: es el
        // contexto que necesita quien lo arma.
        notes: order.observations ?? '',
      });
      await linkQuotationToWorkOrder(creada.id, order.id);
      navigate(`/cotizacion/${creada.number}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setCotizando(false);
    }
  }
```

`createQuotation` está en [`quotations.ts:194`](../../../src/lib/quotations.ts) y recibe `{ customerId, vehicleId, component, validUntil, notes }`, devolviendo `{ id, number }`. El campo `notes` existía justamente para volcar ahí las observaciones del ingreso: ahora las toma de la OT, que es donde viven.

Agregar `const [cotizando, setCotizando] = React.useState(false);` y los imports que haga falta.

- [ ] **Step 4: Enganchar una cotización que ya existe**

El caso del presupuesto por teléfono: la cotización se hizo antes de que el
vehículo llegara, y al recibirlo hay que asociarla en vez de armar una nueva.

En `src/lib/quotations.ts`, una consulta de las candidatas — las de ese
cliente que todavía no están enganchadas a ninguna orden:

```ts
/**
 * Cotizaciones de este cliente que todavía no pertenecen a ninguna orden.
 * Son las que se pueden enganchar a una OT recién abierta: el presupuesto que
 * se hizo por teléfono, antes de que el vehículo llegara al taller.
 */
export async function fetchUnlinkedQuotations(customerId: string): Promise<QuotationListRow[]> {
  const { data, error } = await supabase
    .from('quotations')
    .select(LIST_SELECT)
    .eq('customer_id', customerId)
    .is('work_order_id', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapQuotationRow);
}
```

Usar el `LIST_SELECT` y el mapeo que el archivo ya tenga para el listado de
cotizaciones (los nombres exactos están en `src/lib/quotations.ts`, cerca de
la línea 107); el tipo devuelto es el mismo que usa el listado.

En `src/pages/WorkOrderDetails.tsx`, al lado del botón "Cotizar", un segundo
botón que abre la lista y engancha la elegida:

```tsx
            {isAdmin && !order.quotationNumber && candidatas.length > 0 && (
              <select
                value=""
                onChange={(e) => e.target.value && handleEnganchar(e.target.value)}
                className={cn(inputClass, 'mt-0 w-56 bg-panel')}
              >
                <option value="">Enganchar una cotización ya hecha…</option>
                {candidatas.map((c) => (
                  <option key={c.id} value={c.id}>{c.number} — $ {formatMoney(c.total)}</option>
                ))}
              </select>
            )}
```

```tsx
  /**
   * El presupuesto ya existía y el vehículo recién llega: se asocia en vez de
   * crear uno nuevo. El selector solo aparece si hay candidatas, para no
   * ensuciar el encabezado de las OT que no lo necesitan.
   */
  async function handleEnganchar(quotationId: string) {
    if (!order) return;
    try {
      await linkQuotationToWorkOrder(quotationId, order.id);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }
```

Cargar las candidatas cuando se conoce el cliente de la orden:

```tsx
  const [candidatas, setCandidatas] = React.useState<QuotationListRow[]>([]);

  React.useEffect(() => {
    if (!order?.customer.id || order.quotationNumber) { setCandidatas([]); return; }
    fetchUnlinkedQuotations(order.customer.id).then(setCandidatas).catch(() => setCandidatas([]));
  }, [order?.customer.id, order?.quotationNumber]);
```

Adaptar el nombre del campo del total al que devuelva el listado real de
cotizaciones.

- [ ] **Step 5: Compilar y construir**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 6: Probar a mano**

Sobre una OT migrada en estado **Ingresado**:
1. El botón "Cotizar" está.
2. Al apretarlo lleva a la cotización nueva, con el cliente y el vehículo de la OT.
3. Volver a la OT: quedó en **Cotizado** y muestra el número de la cotización.
4. El botón "Cotizar" ya no aparece.

Deshacer al terminar: borrar la cotización creada y devolver la OT a "Ingresado".

```sql
-- reemplazar por los valores reales
update public.work_orders set quotation_id = null,
  status_id = (select id from public.work_order_statuses where label='Ingresado')
where number = '<OT>';
delete from public.quotations where number = '<COT>';
```

- [ ] **Step 7: Commit**

`Cotizar desde la orden de trabajo, que queda enganchada al presupuesto`

---

### Task 6: Aceptar y rechazar mueven la OT

**Files:**
- Create: `supabase/apply-quotation-to-work-order.sql`
- Modify: `src/lib/quotations.ts`
- Modify: `src/pages/QuotationDetails.tsx`

**Interfaces:**
- Consumes: `link_quotation_to_work_order` (Task 5); los estados `Autorizada` y `Rechazada` (Task 1).
- Produces: `applyQuotationToWorkOrder(quotationId: string): Promise<{ id: string; number: string } | null>` reemplaza a `convertToWorkOrder`; `rejectQuotationWorkOrder(quotationId: string): Promise<void>`.

- [ ] **Step 1: La RPC que llena la OT existente**

Crear `supabase/apply-quotation-to-work-order.sql`:

```sql
-- ===========================================================================
-- Aceptar la cotización llena la OT que ya existe
-- ===========================================================================
-- Migración: apply_quotation_to_work_order
--
-- Antes, aceptar CREABA la orden. Ahora la orden nació en la recepción, así
-- que aceptar copia los renglones adentro de la que ya está y la autoriza.
--
-- Una cotización suelta —el presupuesto por teléfono, sin OT enganchada— solo
-- queda aceptada: no hay dónde copiar los renglones ni contra qué descontar
-- stock. Eso ocurre después, cuando el cliente trae el vehículo, se abre la
-- OT y se le engancha esta cotización.

create or replace function public.apply_quotation_to_work_order(p_quotation_id uuid)
returns table (result_id uuid, result_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quotation quotations%rowtype;
  v_autorizada uuid;
  v_estado_actual text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_quotation from quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_quotation.status <> 'ACEPTADA' then
    raise exception 'Solo se aplican cotizaciones aceptadas (estado actual: %).', v_quotation.status;
  end if;

  -- Sin OT enganchada no hay nada que hacer todavía: es una cotización suelta.
  if v_quotation.work_order_id is null then
    return;
  end if;

  select s.label into v_estado_actual
  from work_orders w join work_order_statuses s on s.id = w.status_id
  where w.id = v_quotation.work_order_id;

  -- Aceptar dos veces no duplica nada: si la OT ya pasó de Autorizada porque
  -- el trabajo arrancó, no se vuelven a copiar renglones ni a descontar stock,
  -- y el estado no retrocede.
  if v_estado_actual not in ('Ingresado', 'Cotizado') then
    return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
    return;
  end if;

  if not exists (select 1 from quotation_items where quotation_id = p_quotation_id) then
    raise exception 'La cotización no tiene renglones cargados.';
  end if;

  select id into v_autorizada from work_order_statuses where label = 'Autorizada';
  if v_autorizada is null then
    raise exception 'Falta el estado "Autorizada" en el ABM de estados de OT.';
  end if;

  -- Al copiar los renglones se dispara el trigger de stock: acá sí se descuenta.
  insert into work_order_items (work_order_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_quotation.work_order_id, qi.article_id, qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi
  where qi.quotation_id = p_quotation_id;

  update work_orders set status_id = v_autorizada where id = v_quotation.work_order_id;

  return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
end;
$$;

grant execute on function public.apply_quotation_to_work_order(uuid) to authenticated;
```

Aplicar con MCP `apply_migration`, nombre `apply_quotation_to_work_order`.

- [ ] **Step 2: El cliente**

En `src/lib/quotations.ts`, reemplazar `convertToWorkOrder` (línea 259) por:

```ts
/**
 * Aceptar la cotización llena la OT que ya existe: copia los renglones,
 * descuenta el stock y la autoriza, todo en una transacción. Si el stock no
 * alcanza, no cambia nada.
 *
 * Devuelve null cuando la cotización no tiene OT enganchada —el presupuesto
 * por teléfono—: ahí solo queda aceptada, y la OT se abre cuando el cliente
 * trae el vehículo.
 */
export async function applyQuotationToWorkOrder(
  quotationId: string
): Promise<{ id: string; number: string } | null> {
  const { data, error } = await supabase.rpc('apply_quotation_to_work_order', {
    p_quotation_id: quotationId,
  });
  if (error) throw error;
  const row: any = Array.isArray(data) ? data[0] : data;
  return row ? { id: row.result_id, number: row.result_number } : null;
}

/**
 * Rechazar mueve la OT enganchada a "Rechazada", que libera el lugar en la
 * playa. La cotización ya quedó rechazada por updateQuotationStatus; esto es
 * el efecto sobre la orden.
 */
export async function rejectQuotationWorkOrder(quotationId: string): Promise<void> {
  const { data: quotation, error } = await supabase
    .from('quotations')
    .select('work_order_id')
    .eq('id', quotationId)
    .single();
  if (error) throw error;
  if (!quotation?.work_order_id) return;

  const { data: estado, error: errorEstado } = await supabase
    .from('work_order_statuses')
    .select('id')
    .eq('label', 'Rechazada')
    .maybeSingle();
  if (errorEstado) throw errorEstado;
  if (!estado) throw new Error('Falta el estado "Rechazada" en el ABM de estados de OT.');

  const { error: errorUpdate } = await supabase
    .from('work_orders')
    .update({ status_id: estado.id })
    .eq('id', quotation.work_order_id);
  if (errorUpdate) throw errorUpdate;
}
```

- [ ] **Step 3: La pantalla de cotizaciones**

En `src/pages/QuotationDetails.tsx`:

1. Cambiar el import de `convertToWorkOrder` por `applyQuotationToWorkOrder` y `rejectQuotationWorkOrder`.
2. En el handler que llama a `convertToWorkOrder` (línea 146), usar `applyQuotationToWorkOrder` y contemplar el `null`:

```tsx
    const resultado = await applyQuotationToWorkOrder(quotation.id);
    if (resultado) {
      navigate(`/orden/${resultado.number}`);
    } else {
      // Cotización suelta: no hay OT que llenar todavía. Se avisa en vez de
      // dejar al usuario esperando una navegación que no va a pasar.
      setInfo('Cotización aceptada. Cuando el cliente traiga el vehículo, abrí la orden y engancháselá desde ahí.');
      await load();
    }
```

3. En el handler que marca el estado (línea 132), después de marcar `RECHAZADA`, mover la OT:

```tsx
    await updateQuotationStatus(quotation.id, status);
    if (status === 'RECHAZADA') await rejectQuotationWorkOrder(quotation.id);
```

Usar los nombres reales del archivo para navegación, recarga y avisos; si no existe un `setInfo`, mostrar el mensaje con el mecanismo que la pantalla ya use para avisos no destructivos.

- [ ] **Step 4: Compilar y construir**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 5: Probar el circuito completo**

Con una OT migrada en "Ingresado":
1. Cotizar desde la OT, cargarle un renglón de un artículo con stock, aceptarla.
2. La OT tiene que quedar en **Autorizada** con el renglón copiado, y el stock del artículo tiene que haber bajado.
3. En otra OT, cotizar y **rechazar** la cotización: la OT tiene que quedar en **Rechazada**, y **no** aparecer entre las pendientes ni entre las facturables.
4. Aceptar dos veces la misma cotización no tiene que duplicar renglones ni volver a descontar stock.

Verificar el stock con SQL antes y después:

```sql
select code, stock_quantity from public.articles where code = '<código usado>';
```

Deshacer todo al terminar: borrar los renglones copiados, devolver el stock, borrar las cotizaciones de prueba y devolver las OT a "Ingresado".

- [ ] **Step 6: Commit**

`Aceptar o rechazar la cotización mueve la orden de trabajo`

---

### Task 7: La playa cuenta solo vehículos

**Files:**
- Modify: `src/lib/yardCapacity.ts`
- Modify: `src/lib/workOrders.ts`

**Interfaces:**
- Consumes: `work_orders.reception_kind` (Task 1).
- Produces: `fetchYardOccupancy` deja de leer `vehicle_intakes`.

- [ ] **Step 1: La ocupación sale solo de las OT**

En `src/lib/yardCapacity.ts`, reemplazar el cuerpo de `fetchYardOccupancy` por una única consulta:

```ts
/**
 * Ocupan lugar las OT cuyo estado no libera la playa y que recibieron un
 * vehículo: una pieza sobre el mostrador no ocupa un lugar de estacionamiento.
 *
 * Ya no hay que mirar los ingresos ni resolver el vínculo por cotización: la
 * recepción es la propia OT, así que un vehículo recibido es una orden y nada
 * más. Se sigue deduplicando por vehículo porque uno puede tener dos OT
 * activas a la vez.
 */
export async function fetchYardOccupancy(): Promise<YardOccupant[]> {
  const { data, error } = await supabase
    .from('work_orders')
    .select(
      `id, number, created_at, estimated_delivery_date, vehicle_id,
       status:work_order_statuses(label, color, frees_yard),
       customer:customers(name),
       vehicle:vehicles(brand, model, license_plate, size_class)`
    )
    .eq('reception_kind', 'VEHICULO')
    .not('vehicle_id', 'is', null)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const ocupantes: YardOccupant[] = (data ?? [])
    .filter((row: any) => !row.status?.frees_yard)
    .map((row: any) => ({
      kind: 'OT' as const,
      id: row.id,
      number: row.number,
      vehicleId: row.vehicle_id,
      customerName: row.customer?.name ?? '—',
      vehicleLabel: labelDeVehiculo(row.vehicle),
      sizeClass: tamanoDe(row.vehicle, row.number),
      statusLabel: row.status?.label ?? '—',
      statusColor: row.status?.color ?? '#6b7280',
      estimatedDeliveryDate: row.estimated_delivery_date,
      daysInShop: diasEnTaller(row.created_at),
      createdAt: row.created_at,
      otrosRegistros: 0,
    }));

  // Un vehículo ocupa UN lugar aunque tenga dos órdenes abiertas. Gana la más
  // reciente, que es la que refleja en qué anda el taller ahora.
  const porVehiculo = new Map<string, YardOccupant>();
  for (const candidato of ocupantes) {
    const actual = porVehiculo.get(candidato.vehicleId);
    if (!actual) {
      porVehiculo.set(candidato.vehicleId, candidato);
    } else if (candidato.createdAt > actual.createdAt) {
      porVehiculo.set(candidato.vehicleId, { ...candidato, otrosRegistros: actual.otrosRegistros + 1 });
    } else {
      porVehiculo.set(candidato.vehicleId, { ...actual, otrosRegistros: actual.otrosRegistros + 1 });
    }
  }
  return [...porVehiculo.values()];
}
```

El tipo `YardOccupant` conserva `kind`, que ahora siempre vale `'OT'`: la pantalla lo sigue usando para decidir si la fecha de entrega es editable, y dejarlo evita tocar `ShopCapacity.tsx` por un campo que no molesta.

Borrar la función `ganaAlOtro` si queda sin uso.

- [ ] **Step 2: "Pendiente" deja de contar las rechazadas**

En `src/lib/workOrders.ts:318`, cambiar:

```ts
  // Una orden cuyo vehículo ya se fue no está pendiente de nada, esté cerrada
  // o rechazada. Sin la segunda condición, cada rechazo quedaría figurando
  // como trabajo por hacer para siempre.
  const pendingOrders = rows.filter((r) => !r.status.isTerminal && !r.status.freesYard);
```

Verificar que el tipo del `status` de esas filas traiga `freesYard`; si el select de esa consulta no lo pide, agregarlo (`frees_yard`) y mapearlo.

- [ ] **Step 3: Compilar y construir**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 4: Verificar la ocupación**

La ocupación tiene que dar lo mismo que antes de la migración, porque los 8 ingresos pasaron a ser 8 OT de los mismos vehículos. Contar por SQL:

```sql
select count(*) as vehiculos_ocupando from (
  select distinct on (w.vehicle_id) w.vehicle_id
  from public.work_orders w
  join public.work_order_statuses s on s.id = w.status_id
  where s.frees_yard = false and w.reception_kind = 'VEHICULO' and w.vehicle_id is not null
  order by w.vehicle_id, w.created_at desc
) t;
```

Y compararlo con lo que muestra `/disponibilidad-taller`. Los dos números tienen que coincidir. Anotar el valor en el reporte.

Comprobar además que **una OT de pieza suelta no suma**: crear una con `reception_kind = 'PIEZA'` desde la pantalla, ver que la ocupación no cambia, y borrarla.

- [ ] **Step 5: Commit**

`La playa cuenta las OT que recibieron un vehículo, sin pasar por los ingresos`

---

### Task 8: Retirar el módulo de ingresos

Última tarea: recién ahora nada depende de él.

**Files:**
- Delete: `src/pages/VehicleIntakes.tsx`, `src/pages/VehicleIntakeDetails.tsx`, `src/lib/vehicleIntakes.ts`
- Modify: `src/App.tsx`, `src/lib/menuCategories.ts`

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Ver quién los usa todavía**

```bash
grep -rn "vehicleIntakes\|VehicleIntake" src/ --include=*.ts --include=*.tsx
```

Anotar cada resultado. Los únicos esperados son `App.tsx` (rutas e imports) y los tres archivos que se borran. **Si aparece otro consumidor, resolverlo antes de borrar** y anotarlo en el reporte.

- [ ] **Step 2: Sacar las rutas**

En `src/App.tsx`, borrar los dos imports de `VehicleIntakes` y `VehicleIntakeDetails` y las dos rutas:

```tsx
                    <Route path="/ingresos" element={<VehicleIntakes />} />
                    <Route path="/ingresos/:id" element={<VehicleIntakeDetails />} />
```

- [ ] **Step 3: Sacar la tarjeta del menú**

En `src/lib/menuCategories.ts`, borrar de la sección `comprobantes` de la categoría `ventas`:

```ts
          { icon: LogIn, label: 'Ingreso de vehículos', path: '/ingresos', adminOnly: true },
```

Y quitar `LogIn` del import de `lucide-react` si queda sin uso.

- [ ] **Step 4: Borrar los archivos**

```bash
git rm src/pages/VehicleIntakes.tsx src/pages/VehicleIntakeDetails.tsx src/lib/vehicleIntakes.ts
```

Si `git rm` queda bloqueado, borrarlos con `rm` y avisarlo.

**Las tablas `vehicle_intakes`, `vehicle_intake_photos` y `vehicle_intake_parts` no se tocan.** Quedan en la base sin pantalla que las lea: borrar datos del taller en la misma tanda que los mueve no conviene, y si algo salió mal el original sigue ahí. La limpieza es un paso posterior, cuando el taller confirme.

- [ ] **Step 5: Compilar y construir**

```bash
npx tsc --noEmit && npm run build
```

Esperado: `tsc` sin salida. Cualquier error acá es un consumidor que el grep del Step 1 no encontró.

- [ ] **Step 6: Probar a mano**

1. `http://localhost:4000/ingresos` ya no resuelve a la pantalla vieja.
2. La categoría Ventas del menú ya no muestra "Ingreso de vehículos".
3. Recorrer el circuito completo una vez más: recibir → cotizar → aceptar → la OT queda Autorizada.

- [ ] **Step 7: Commit**

`El ingreso de vehículos deja de ser un módulo aparte`

---

## Verificación final

- [ ] `npx tsc --noEmit` sin salida y `npm run build` exitoso.
- [ ] `grep -rn "vehicleIntakes\|VehicleIntake" src/` no devuelve nada.
- [ ] `grep -rn "convertToWorkOrder" src/` no devuelve nada: quedó reemplazada por `applyQuotationToWorkOrder`.
- [ ] La ocupación de la playa coincide entre la pantalla y el SQL de la Task 7.
- [ ] **Ninguna notificación quedó pendiente:** `select count(*) from notifications where status::text not in ('ENVIADO','DESCARTADO')` da 0.
- [ ] Una OT en "Rechazada" no aparece entre las pendientes del tablero ni entre las facturables.
- [ ] Una OT de pieza suelta no descuenta lugar en la playa.
- [ ] Los datos de prueba creados durante las tareas quedaron borrados, y la ocupación volvió al valor que tenía al empezar.
