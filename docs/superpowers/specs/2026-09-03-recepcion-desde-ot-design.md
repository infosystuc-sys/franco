# La recepción arranca en la OT — Diseño

**Fecha:** 3 de septiembre de 2026
**Estado:** en revisión

## Qué se va a construir

Que recibir un vehículo sea abrir una orden de trabajo.

Hoy el circuito arranca en un módulo aparte —Ingreso de vehículos— que deriva
en una cotización, y recién cuando el cliente la acepta nace la OT. Pero el
cliente deja el vehículo **antes** de que haya nada que cotizar: eso es lo que
el circuito no refleja. El vehículo pasa días en el taller sin orden que lo
represente.

La recepción pasa a ser el alta de la OT. La OT nace en **Ingresado**, se
cotiza desde ahí, y la aceptación o el rechazo —que se siguen manejando en el
módulo de cotizaciones— la mueven de estado.

**El módulo de Ingreso de vehículos desaparece.** Un vehículo que entra es una
OT, y no hay dos lugares donde mirar.

---

## Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Módulo de ingresos | **Desaparece** | La recepción pasa a ser el alta de la OT. Conservarlo dejaría dos pantallas para una sola cosa. |
| Estados nuevos | **Ingresado → Cotizado → Autorizada** | "Autorizada" ya existe y ya significa "el cliente aceptó". "Cotizado" y "en espera de aceptación" son el mismo momento: la cotización salió y se espera respuesta. Un estado, no dos. |
| Cotización rechazada | **Estado nuevo "Rechazada"** | Deja ver en el listado cuántos presupuestos se perdieron, separado del vehículo que sí se reparó y retiró. |
| Piezas sueltas | **OT sin vehículo, con marca de qué se recibió** | Una bomba sobre el mostrador no ocupa un lugar de estacionamiento. Sin esa distinción, la cuenta de la playa miente. |
| Cotizaciones sueltas | **Siguen existiendo y no crean OT** | Un presupuesto por teléfono no es un vehículo en el taller. Si después el cliente lo trae, se abre la OT y se le engancha esa cotización. |
| Los 10 ingresos cargados | **Los 8 sin OT se convierten en OT** | Son vehículos que hoy están en el taller. Descartarlos los borraría de la vista y de la cuenta de la playa. |

---

## Tres hallazgos del código que condicionan el diseño

### Crear una OT le manda un WhatsApp al cliente

El disparador `work_orders_enqueue_created` encola una notificación
`LINK_SEGUIMIENTO` por cada OT insertada, con el link de seguimiento.

La migración crea 8 OT de una vez. Sin precaución, eso son **8 mensajes reales
a clientes reales**, avisándoles de una orden que para ellos no es nueva.

**Por eso la migración descarta esas notificaciones dentro de la misma
transacción** que inserta las OT: nunca llegan a existir como pendientes fuera
de ella. `notifications.work_order_id` permite identificarlas con precisión.

### "Rechazada" no puede ser terminal, y el motivo no es el que parece

La razón obvia para no marcarla terminal es que `is_terminal` habilita
facturar, y una OT rechazada no tiene nada que cobrar. Pero hay una razón más
dura, que se descubre mirando el disparador de precios.

`block_terminal_while_price_pending` salta cuando una OT pasa de un estado no
terminal a uno terminal, tiene cotización, y su total difiere del presupuestado
sin autorización. Una OT en **Cotizado todavía no tiene renglones copiados** —
se copian recién al aceptar. Su total es cero contra un presupuesto que no lo
es, y no hay autorización de por medio.

Es decir: **si "Rechazada" fuera terminal, rechazar una cotización quedaría
bloqueado por el guard de precios.** No habría forma de registrar el rechazo.

**Por eso "Rechazada" queda no terminal**, con `frees_yard` en verdadero.

Eso deja un cabo: los listados que consideran "pendiente" a toda OT no terminal
([`workOrders.ts:318`](../../../src/lib/workOrders.ts)) la mostrarían como
pendiente para siempre. **Se ajusta esa noción**: una OT está pendiente si no
es terminal **y** su estado no libera la playa. Dicho en castellano, una orden
cuyo vehículo ya se fue no está pendiente de nada, esté cerrada o rechazada.

### La OT ya tiene fotos, pero no tiene piezas

`work_order_photos` existe, con su propio bucket
([`workOrders.ts:619`](../../../src/lib/workOrders.ts)). No hay nada que
construir de ese lado.

Lo que la OT no tiene es la lista de piezas recibidas con número de serie, que
hoy vive en `vehicle_intake_parts`. Ni el campo de observaciones de la
recepción.

---

## Modelo de datos

### `work_orders`

| Cambio | Detalle |
|---|---|
| `vehicle_id` | Pasa a ser **opcional**: una OT de pieza suelta puede no tener vehículo. |
| `reception_kind` | Columna nueva, `text not null default 'VEHICULO'`, con check en `VEHICULO` / `PIEZA`. |
| `observations` | Columna nueva, `text`. Lo que hoy guarda el ingreso. |

**Por qué `reception_kind` y no deducirlo de si hay vehículo.** El caso común
es "traigo la bomba del Scania patente XYZ": el vehículo está en el padrón y se
elige, pero el camión no está en la playa. Deducir la marca de `vehicle_id`
haría que esa OT descuente un lugar que no ocupa. La marca dice qué entró, no
a qué pertenece.

### Tabla nueva `work_order_received_parts`

Las piezas recibidas, iguales a las de `vehicle_intake_parts` pero colgando de
la OT.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `work_order_id` | uuid not null | FK a `work_orders`, on delete cascade. |
| `name` | text not null | |
| `serial_number` | text not null | |
| `created_at` | timestamptz not null | |

RLS con el mismo criterio que las demás tablas hijas de la OT.

### Estados nuevos en `work_order_statuses`

| Estado | `is_initial` | `is_terminal` | `frees_yard` | `notifies_client` |
|---|---|---|---|---|
| **Ingresado** | sí | no | no | no |
| **Cotizado** | no | no | no | no |
| **Rechazada** | no | no | **sí** | no |

"Autorizada" **deja de ser el estado inicial** —hoy lo es— y conserva todo lo
demás. No hay ninguna OT en ese estado, así que el cambio no toca datos.

Orden: Ingresado, Cotizado, Autorizada, Esp. Repuestos, En Reparación,
Calibración, Terminado, Retirado, y Rechazada al final por estar fuera de la
línea principal.

**Los tres nacen sin aviso automático.** El alta ya manda su propio mensaje con
el link de seguimiento, y la cotización tiene su circuito de envío aparte.
Activar el aviso de "Cotizado" es tildar una casilla en el ABM de estados, sin
tocar código.

---

## El circuito

### Recepción

Órdenes → Nueva. Se elige el cliente y qué se recibe: un vehículo o una pieza
suelta. Si es un vehículo, se elige cuál. Si es una pieza, el vehículo es
opcional —sirve para saber de qué equipo salió— y la OT no descuenta lugar.

Se cargan fotos, piezas recibidas con su número de serie, y observaciones. La
OT nace en **Ingresado**.

### Cotización

Desde la OT, un botón **Cotizar** arma la cotización con el cliente y el
vehículo ya cargados, y la OT pasa a **Cotizado**. Si ya existe una cotización
suelta para ese cliente —el presupuesto que se hizo por teléfono— se puede
enganchar esa en lugar de crear una nueva.

### Aceptación y rechazo

Se siguen manejando en el módulo de cotizaciones, que no cambia. Lo que cambia
es que la decisión ahora mueve la OT:

| En cotizaciones | La OT pasa a | Qué más ocurre |
|---|---|---|
| Aceptada | **Autorizada** | Se copian los renglones y se descuenta el stock. |
| Rechazada | **Rechazada** | Libera el lugar en la playa. |

**La conversión cambia de sentido.** Hoy `convert_quotation_to_work_order`
*crea* la OT. Pasa a llenar la OT que ya existe: copia los renglones, descuenta
el stock y la mueve a Autorizada, todo en una transacción como ahora. Si el
stock no alcanza, no cambia nada.

**Aceptar dos veces no duplica nada.** Si la OT vinculada ya pasó de
Autorizada —porque el trabajo arrancó—, volver a marcar la cotización como
aceptada no vuelve a copiar renglones, no vuelve a descontar stock y no
retrocede el estado. Hoy ese doble clic crearía una segunda OT; con el
circuito nuevo no hace nada.

**Una cotización suelta aceptada solo se marca aceptada.** No hay OT donde
copiar los renglones ni contra qué descontar stock. Eso ocurre después, cuando
el cliente trae el vehículo, se abre la OT y se le engancha esa cotización.

---

## Dos efectos fuera del módulo

### La capacidad de playa se simplifica

Desaparece la mitad de la regla —los ingresos sin OT— y con ella el enredo del
vínculo por cotización.

Queda: **ocupan lugar las OT cuyo estado no libera la playa y cuyo
`reception_kind` es `VEHICULO`.** La deduplicación por vehículo se conserva,
porque un vehículo puede tener dos OT activas a la vez.

### La noción de "pendiente" deja de contar las rechazadas

Una OT está pendiente si no es terminal **y** su estado no libera la playa.
Sin este ajuste, cada rechazo quedaría figurando como trabajo por hacer.

---

## La migración

### Los 8 ingresos sin OT

| Ingresos | Estado de la OT nueva |
|---|---|
| ING-3, ING-4, ING-8, ING-9, ING-10 | **Ingresado** |
| ING-5, ING-6, ING-7 | **Cotizado**, con su `quotation_id` enganchado |

Cada una arrastra cliente, vehículo, observaciones y `reception_kind =
'VEHICULO'`. Las 2 piezas de ING-4 pasan a `work_order_received_parts`.

**La única foto que existe** (también de ING-4) se copia del bucket
`vehicle-intakes` al bucket `work-order-photos` con un script, porque copiar
archivos entre buckets no se puede hacer desde SQL.

Los 2 ingresos que ya derivaron en OT (ING-1 e ING-2) no se convierten: su
información ya vive en esas órdenes.

### Las notificaciones

En la misma transacción del insert, las notificaciones que el disparador de
alta genere para esas 8 OT se marcan como descartadas.

### Lo que se borra y lo que queda

Se borran las pantallas de Ingresos, `src/lib/vehicleIntakes.ts` y la tarjeta
del menú.

**Las tablas `vehicle_intakes`, `vehicle_intake_photos` y
`vehicle_intake_parts` quedan en la base**, sin pantalla que las lea. Borrar
datos del taller en la misma migración que los mueve no es algo que convenga
hacer: si algo salió mal, el original sigue ahí. La limpieza es un paso
posterior, cuando el taller confirme que quedó todo bien.

---

## No entra en esta versión

- **Reabrir una OT rechazada.** Si el cliente cambia de opinión, se abre una
  OT nueva. Un estado terminal que se pueda revertir es una función aparte.
- **Recibir varias piezas de clientes distintos en una sola OT.** Una OT es de
  un cliente.
- **Borrar las tablas de ingresos.** Queda para una limpieza posterior.
- **Cambiar el módulo de cotizaciones.** Sigue igual: solo se le agrega que su
  decisión mueva la OT vinculada.

---

## Pruebas

Sin test runner: la convención del proyecto es `npx tsc --noEmit`,
`npm run build` y prueba manual con Playwright sobre datos reales.

- Recibir un vehículo crea una OT en Ingresado y **suma** un lugar en la playa.
- Recibir una pieza suelta crea una OT y **no** suma lugar, ni siquiera cuando
  se le elige el vehículo del que salió.
- Cotizar desde la OT la pasa a Cotizado.
- Aceptar la cotización pasa la OT a Autorizada, copia los renglones y
  descuenta el stock. Si el stock no alcanza, no cambia nada.
- Rechazarla pasa la OT a Rechazada **sin que el guard de precios lo impida**,
  libera el lugar, y esa OT no aparece ni en facturables ni entre las
  pendientes.
- Una cotización suelta aceptada **no** crea ninguna OT.
- Aceptar dos veces la misma cotización no duplica renglones ni vuelve a
  descontar stock.
- Enganchar una cotización existente a una OT recién abierta funciona, y
  aceptarla después llena esa OT.
- **Después de migrar, la ocupación de la playa sigue dando 5.** Los 8
  ingresos pasan a ser 8 OT de los mismos vehículos, así que la deduplicación
  da el mismo resultado. Otro número significa que algo salió mal.
- La migración **no deja ninguna notificación pendiente**: se verifica que no
  haya filas en estado pendiente para esas 8 OT.
