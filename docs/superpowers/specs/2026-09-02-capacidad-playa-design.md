# Capacidad de recepción de la playa — Diseño

**Fecha:** 2 de septiembre de 2026
**Estado:** en revisión

## Qué se va a construir

Saber cuántos vehículos más entran en la playa, hoy y en los próximos días.

Se configura un cupo por tamaño de vehículo (chico, mediano, grande), cada
vehículo que está físicamente en el taller descuenta del cupo de su tamaño, y
la fecha estimada de finalización de la OT proyecta cuándo se libera cada
lugar. Al recibir un vehículo, la pantalla de ingreso muestra cuánto lugar
queda para ese tamaño.

**Todo lo que está en el taller ocupa playa.** Cada ingreso de vehículo y cada
OT confirmada cuenta como un lugar de playa. No se reparte por sector ni se
deduce de quién atiende el vehículo.

---

## Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Dónde se ubica cada vehículo | **Todo en playa**, sin relación con el empleado | Dónde está parado un vehículo no depende de quién lo atiende. Atarlo al sector del empleado hacía que una OT sin empleado asignado no ocupara nada, y que reasignar un mecánico "moviera" un camión de lugar sin que nadie lo tocara. |
| Unidad del cupo | **Tamaño** (chico/mediano/grande), no tipo de vehículo | El sistema clasifica por tipo (Camión/Utilitario, Maquinaria vial, Agrícola, Grupo electrógeno, Embarcación, Otro), pero eso no dice cuánto lugar ocupa: un grupo electrógeno y un camión son tipos distintos y espacios muy distintos. |
| De dónde sale el tamaño | **Por vehículo, con default por tipo** | "Camión / Utilitario" mete en la misma bolsa una Transit y un Scania. El default evita cargarlo a mano siempre; la corrección evita mentir. |
| Qué ocupa lugar | **Ingresos sin OT + OT confirmadas** | Es lo único que refleja el lugar real. Hoy la ocupación cuenta solo OT según el sector del empleado asignado, y deja afuera vehículos que están físicamente en el taller. |
| Cuándo se libera | **Al retirar el vehículo**, no al terminar la OT | Un vehículo terminado que nadie retiró sigue ocupando lugar. |
| Proyección | Fecha estimada de finalización **más un margen configurable** | Casi nadie retira el mismo día que termina. Sin margen, la pantalla promete lugar que no va a haber. |
| Laboratorios | **Salen de la pantalla** | Sus paneles se calculaban con el sector del empleado. Sin esa relación quedarían siempre en cero, y un panel que siempre marca cero confunde más de lo que informa. |

---

## Tres hallazgos del código que condicionan el diseño

### `is_terminal` habilita facturar, así que "Retirado" no puede reemplazar a "Terminado"

El flujo de estados hoy termina en "Terminado", marcado como terminal. Y
`is_terminal` es lo que habilita emitir la factura de una OT
([`workOrders.ts:36`](../../../src/lib/workOrders.ts),
[`invoices.ts:351`](../../../src/lib/invoices.ts),
[`InvoiceNew.tsx:156`](../../../src/pages/InvoiceNew.tsx)).

Si "Retirado" pasara a ser el estado final y "Terminado" dejara de serlo, no
se podría facturar una OT hasta que el cliente retire el vehículo — al revés
de como funciona un taller, donde se factura para que se lo lleve.

**Por eso "Retirado" se agrega como estado terminal adicional**, sin tocar
"Terminado". No hay reglas de transición entre estados, así que pasar de uno
al otro no necesita nada especial.

### Los ingresos necesitan un cierre propio

De los 10 ingresos cargados, solo 2 derivaron en una OT (ING-1 y ING-2). Los
**8 restantes son vehículos sin orden de trabajo**: están en el taller y no
los cuenta nadie.

Peor: si el cliente rechaza el presupuesto y se lleva el vehículo, hoy no hay
forma de registrarlo. Ese ingreso ocuparía lugar para siempre.

**Por eso el ingreso suma un estado de cierre**, para la salida que no pasa por
una OT.

### Ya existe una tabla de cupo por sector, y queda a medias

`workplace_capacity` tiene una fila por sector (Laboratorio 1, Laboratorio 2,
Playa) con un único número de cupo, y la pantalla la usa para los tres paneles
([`shopCapacity.ts:14`](../../../src/lib/shopCapacity.ts)).

La fila de Playa queda **reemplazada** por el cupo por tamaño: un solo número
para toda la playa no distingue un grupo electrógeno de un Scania, que es
justamente el problema a resolver. Las filas de los laboratorios **se dejan
donde están**, sin uso por ahora — borrarlas perdería un dato que el taller ya
cargó, por si más adelante se retoma el tema.

---

## Modelo de datos

### `vehicles`: tamaño

Columna nueva `size_class` con valores `CHICO`, `MEDIANO`, `GRANDE`.

Al dar de alta o editar un vehículo se propone según el tipo, y queda
editable:

| Tipo de vehículo | Tamaño propuesto |
|---|---|
| Camión / Utilitario | GRANDE |
| Maquinaria vial | GRANDE |
| Maquinaria agrícola | GRANDE |
| Embarcación | MEDIANO |
| Otro | MEDIANO |
| Grupo electrógeno | CHICO |

Los 8 vehículos ya cargados se completan con el valor que les corresponde por
tipo. La columna es `not null` con default `MEDIANO`: un vehículo sin tamaño
haría que la cuenta mienta en silencio, que es peor que asumir el caso medio.

### Tabla nueva `yard_capacity`

Una fila por tamaño, con el cupo de la playa.

| Columna | Tipo | Notas |
|---|---|---|
| `size_class` | text, PK | `CHICO`, `MEDIANO`, `GRANDE`. |
| `capacity` | int not null | Cuántos entran de ese tamaño. |
| `updated_at` | timestamptz | |

Sembrada con las tres filas en cero: un cupo en cero es honesto —significa "no
configurado"— mientras que sembrar un número inventado haría que la pantalla
afirme algo que nadie decidió.

RLS: lectura para cualquier usuario autenticado (la pantalla de ingreso la
consulta), escritura solo admin.

### `work_order_statuses`: qué estado libera la playa

Columna nueva `frees_yard boolean not null default false`, marcada en el
estado "Retirado".

**La regla no se ata al nombre del estado.** Los estados son un ABM que el
usuario administra: si mañana renombra "Retirado" a "Entregado", una regla
basada en el texto se rompería sin aviso. La marca sigue el mismo criterio que
`is_initial` y `is_terminal`, que ya existen.

Se agrega el estado "Retirado" con `is_terminal = true` y `frees_yard = true`,
después de "Terminado".

### `vehicle_intakes`: cierre sin OT

El enum `vehicle_intake_status` suma el valor `CERRADO`, para el ingreso cuyo
vehículo se fue sin llegar a una orden de trabajo.

### `company_settings`: margen de retiro

Columna nueva `yard_pickup_grace_days int not null default 2`: cuántos días
después de la fecha estimada de finalización se asume que el vehículo se
retira, a los fines de la proyección.

---

## La migración de las OT ya terminadas

Hay **8 OT en "Terminado"**, creadas entre el 18 y el 28 de agosto. Con la
regla nueva —"Terminado" todavía ocupa lugar, solo "Retirado" lo libera— esas
8 pasarían a contar como vehículos en la playa, y la ocupación daría 19 en vez
de 11.

Serían 19 vehículos en un taller que tiene lugar para bastantes menos: la
cuenta arrancaría mintiendo desde el primer día.

**Por eso la migración pasa esas 8 OT a "Retirado".** Son historia previa a
que esta función existiera, y sus vehículos no están en el taller. Los dos
estados son terminales, así que el cambio no altera si esas OT se pueden
facturar ni ninguna otra cosa que dependa de `is_terminal`.

De acá en adelante la regla vale plena: una OT que se termina sigue ocupando
lugar hasta que alguien la marca "Retirado".

---

## Qué ocupa lugar, exactamente

Un vehículo ocupa un lugar en la playa si se cumple una de estas dos, que son
excluyentes entre sí:

1. **Tiene un ingreso abierto sin OT:** el ingreso no está `CERRADO` y su
   cotización todavía no derivó en una orden de trabajo.
2. **Tiene una OT confirmada:** el estado de la orden no está marcado con
   `frees_yard`.

El vínculo entre ingreso y OT es la cotización (`vehicle_intakes.quotation_id`
contra `work_orders.quotation_id`): cuando el ingreso deriva en OT, la
ocupación pasa del punto 1 al 2 sin contar dos veces. Cuando la OT llega a
"Retirado", el lugar se libera. Cuando el ingreso se cierra sin OT, también.

Nada de esto mira al empleado asignado.

---

## La proyección

Para cada vehículo ocupando lugar, la fecha en que se espera que se libere:

- **Con OT y fecha estimada de finalización:** esa fecha más
  `yard_pickup_grace_days`.
- **Con OT sin fecha estimada, o ingreso sin OT:** no hay fecha. Estos
  vehículos se muestran aparte, como "sin fecha de salida", en vez de
  inventarles una.

Con los datos de hoy esto pesa: de los 11 vehículos que ocupan lugar, **solo 3
tienen fecha estimada** — el resto va a caer en "sin fecha de salida". La
proyección sirve, pero recién se vuelve útil cuando el taller carga esa fecha.

La pantalla muestra, por tamaño y para los próximos días, cuántos lugares
habría libres si todo saliera según lo estimado. Es una proyección, no una
promesa: se rotula como tal, porque una fecha estimada que se corre arrastra
todo lo demás.

---

## Dónde se ve

### Disponibilidad del taller

La pantalla pasa a ser de la playa y nada más:

- Un panel por tamaño (chico, mediano, grande): cupo configurado, ocupado,
  libre.
- La proyección de los próximos días.
- La lista de lo que está en el taller, con ingresos y OT en la misma tabla.

Se van los tres paneles por sector, el aviso de "órdenes sin empleado asignado
(y por lo tanto sin sector conocido)" y la columna "Sector" de la tabla: los
tres salían de la relación con el empleado, que deja de existir.

### Alta de ingreso de vehículo

Al elegir el vehículo, se muestra cuánto lugar queda para su tamaño: por
ejemplo, "Quedan 2 de 5 lugares para vehículos grandes".

**No bloquea el ingreso.** Si no hay lugar, avisa pero deja continuar: el
vehículo ya está en la puerta del taller, y un sistema que impide registrarlo
solo consigue que el dato deje de cargarse.

### Configuración

Los tres cupos por tamaño y el margen de días de retiro.

---

## No entra en esta versión

- **Reservar un lugar para una fecha futura.** Esto mide ocupación, no agenda
  turnos.
- **Ubicaciones dentro de la playa.** No hay mapa ni número de lugar: se cuenta
  cuántos entran, no dónde va cada uno.
- **Capacidad de los laboratorios.** Salen de la pantalla; su cupo queda
  guardado en `workplace_capacity` sin uso.
- **Histórico de ocupación.** Se calcula el estado de hoy y la proyección
  hacia adelante; no se guarda una serie para mirar hacia atrás.

---

## Pruebas

Sin test runner nuevo: la convención del proyecto es `npx tsc --noEmit`,
`npm run build` y prueba manual con Playwright sobre datos reales.

- Después de la migración, la ocupación tiene que dar **11 vehículos**: 8
  ingresos sin OT (ING-3 a ING-10) más 3 OT confirmadas (OT-977906, OT-5002,
  OT-5010). ING-1 e ING-2 no se cuentan como ingreso porque derivaron en OT.
- Sin la migración de las 8 OT terminadas daría 19. Si da 19, la migración no
  corrió.
- Con el default de tamaño por tipo, esos 11 caen **todos en GRANDE** (6
  camiones, 4 agrícolas, 1 maquinaria vial): no hay ni un vehículo chico ni
  mediano cargado hoy. Sirve para verificar el reparto por tamaño, pero
  conviene además cambiarle el tamaño a alguno a mano y confirmar que se mueve
  de columna.
- El contraste con lo que se ve hoy: la pantalla actual muestra 3 vehículos
  ocupando el taller. Son 11.
- Reasignar el empleado de una OT **no** tiene que cambiar la ocupación.
- Una OT sin empleado asignado igual tiene que ocupar lugar.
- Marcar una OT como "Retirado" tiene que liberar su lugar, y **no** tiene que
  afectar si esa OT se puede facturar.
- Cerrar un ingreso sin OT tiene que liberar su lugar.
- Cambiar el margen de días tiene que correr las fechas de la proyección.
- Los 8 vehículos sin fecha estimada tienen que aparecer en "sin fecha de
  salida" y no romper el cálculo.
