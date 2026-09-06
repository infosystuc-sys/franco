# La playa se mide en celdas

**Fecha:** 2026-09-06
**Reemplaza:** `2026-09-02-capacidad-playa-design.md` (cupos por tamaño)

## El problema con lo que hay

Hoy la playa se configura como tres cupos independientes —tantos chicos,
tantos medianos, tantos grandes— y cada vehículo descuenta del cupo de su
tamaño. Eso modela un taller que tuviera tres playas separadas, una por
tamaño, y no es así: hay un solo espacio físico y lo que entra en él depende
de cómo se combinan los vehículos.

El taller razona en celdas. Una celda admite **un vehículo grande** o **hasta
tres medianos**. Un camión ocupa la celda entera; tres utilitarios comparten
una. Esa es la unidad real de decisión cuando alguien llama para preguntar si
hay lugar.

Solo se consideran dos medidas: mediano y grande. Chico desaparece.

## El cálculo

Todo el modelo es una fórmula:

```
celdas ocupadas = grandes + techo(medianos / 3)
celdas libres   = celdas del taller − celdas ocupadas
```

Ejemplo con 10 celdas, 2 vehículos grandes y 4 medianos: los grandes toman 2
celdas; los 4 medianos entran en 2 celdas (una con 3, otra con 1). Ocupadas 4,
**quedan 6**.

Un quinto mediano entra en la celda a medio llenar: siguen quedando 6.

**El hueco no se publica.** La celda con un solo mediano tiene lugar para dos
más, pero eso no se muestra como disponibilidad. Lo disponible son celdas
enteras. Publicar el hueco haría que el número subiera y bajara sin que entre
ni salga nada del taller, y nadie podría explicarlo.

**Puede dar negativo.** Si hay más vehículos que celdas, el número se muestra
igual, marcado. Una playa desbordada es un hecho a la vista, no un error a
esconder.

## Quién ocupa una celda

Ocupa toda orden de trabajo que:

- recibió un vehículo (`reception_kind = 'VEHICULO'` y `vehicle_id` no nulo), y
- está en un estado que todavía no libera la playa (`frees_yard = false`).

Hoy liberan **Retirado** y **Rechazada**. **Terminado no libera**: el trabajo
está hecho pero el camión sigue estacionado, y la celda sigue tomada hasta que
alguien lo retira de verdad.

Esto no cambia respecto de lo que ya hace la aplicación. Lo que se elimina es
el **margen de retiro configurable** (hoy 2 días después de la fecha estimada):
la celda ya no se libera por vencimiento de una fecha, sino por el cambio de
estado a Retirado.

Un vehículo con dos órdenes abiertas a la vez ocupa **una** celda, no dos. La
deduplicación por vehículo que ya existe se conserva.

## La línea de tiempo

Una fila por cada uno de los próximos 14 días: cuántas celdas quedarían libres
ese día, suponiendo que cada orden se retire en su fecha estimada de
finalización.

Es una proyección, no una promesa, y la pantalla lo dice: una fecha estimada
que se corre arrastra todo lo que viene atrás.

### Cada día se calcula entero, no por diferencia

Para cada día de la ventana hay que **rehacer la cuenta completa**: filtrar qué
órdenes siguen ocupando ese día y volver a aplicar
`grandes + techo(medianos / 3)`.

Lo que NO se puede hacer es partir de las celdas libres de hoy e ir sumando las
salidas de cada día. El techo no es aditivo y da resultados equivocados: con 4
medianos ocupando 2 celdas, que se vaya **uno solo** libera una celda entera
(quedan 3, que entran en 1). Sumar «se fue un mediano, liberó un tercio de
celda» no da ese resultado.

### Hasta qué día ocupa

Una orden con fecha estimada `F` ocupa **hasta `F` inclusive**, y deja de ocupar
a partir del día siguiente. El trabajo termina ese día; recién después la celda
queda disponible. Es el criterio pesimista, coherente con el resto: se prefiere
mostrar la celda ocupada un día de más que prometerla un día antes de tiempo.

### Los dos casos que la proyección no puede resolver

**Sin fecha estimada.** No debería haber ninguna nueva —la fecha pasa a ser
obligatoria en el alta— pero las órdenes anteriores a este cambio la tienen
vacía. Ocupan toda la ventana proyectada y se cuentan aparte: «N sin fecha
estimada».

**Vencidas.** La fecha estimada ya pasó y la orden sigue sin marcarse Retirado.
La celda está ocupada de hecho. Ocupan toda la ventana proyectada y se cuentan
aparte: «N vencidas».

En los dos casos el criterio es el mismo y es deliberadamente pesimista:
**prometer un lugar que está ocupado es el error caro**; contar de más solo
hace perder una venta. Los contadores existen para que se vea cuánto del
número es conservador.

## Qué cambia en cada pantalla

### Configuración

Los tres cupos por tamaño se reemplazan por un único campo: **celdas del
taller**. Desaparece el campo de margen de retiro.

### Alta de vehículo

El selector de tamaño queda con dos opciones y **sin preselección**: hay que
elegir.

Hoy se autocompleta según el tipo de vehículo, y el tipo no dice cuánto lugar
ocupa — «Camión / Utilitario» mete en la misma bolsa una Transit y un Scania.
Una adivinanza equivocada corrompe la cuenta de la playa en silencio, sin que
nadie se entere hasta que el camión no entra. Con dos opciones, elegir es un
clic.

### Alta de orden de trabajo

Se agrega **fecha estimada de finalización, obligatoria**, únicamente cuando lo
que se recibe es un vehículo. Una pieza suelta no ocupa celda, así que ahí la
fecha no cumple ninguna función y pedirla sería un campo obligatorio sin motivo
—de los que se terminan llenando con cualquier cosa—.

Vuelve además el **aviso de lugar disponible** al elegir el vehículo, ahora
expresado en celdas. Este aviso existía y se perdió cuando la recepción pasó a
la orden de trabajo: vivía en `VehicleIntakes.tsx`, que se borró en esa
migración. Es informativo y **nunca bloquea el alta**: el vehículo ya está en la
puerta del taller, y un sistema que impide registrarlo solo consigue que el
dato deje de cargarse.

### Disponibilidad del taller

- Celdas libres, como número principal.
- La línea de tiempo de 14 días.
- Los contadores de «sin fecha estimada» y «vencidas».
- La tabla de ocupantes, que se conserva: qué vehículos hay, de quién, en qué
  estado, desde cuándo y con qué entrega estimada.

## Datos

### Tamaños

`SizeClass` pasa de `'CHICO' | 'MEDIANO' | 'GRANDE'` a `'MEDIANO' | 'GRANDE'`.

Ningún vehículo usa `CHICO` hoy (los 8 existentes son `GRANDE`), así que la
migración de datos no toca ninguna fila. Lo único que hay que corregir es
`SIZE_BY_VEHICLE_TYPE`, donde `GENERADOR` sugiere `CHICO`: pasa a `MEDIANO`.

Si más adelante apareciera una fila con `CHICO`, la migración debe fallar
ruidosamente en vez de reasignarla sola: el tamaño decide cuánto lugar ocupa y
adivinarlo es exactamente lo que este diseño evita.

### Cantidad de celdas

La tabla `yard_capacity` (tres filas, una por tamaño) se elimina. La cantidad
de celdas pasa a `app_settings` con la clave `yard_cells`, que es donde ya
viven los valores escalares de configuración del taller (`default_markup_percent`
sigue el mismo patrón). Una tabla propia existía solo porque había tres valores
indexados por tamaño; con un único número deja de tener sentido.

Valor inicial: **10**. Es un punto de partida configurable, no una medición del
taller — hay que revisarlo en Configuración.

### Fecha estimada

`work_orders.estimated_delivery_date` **queda nullable en la base**. Hacerla
`NOT NULL` rompería las órdenes que ya existen sin fecha y las que se creen por
caminos que no son el alta de recepción.

La obligatoriedad vive en el alta de la orden, y las viejas sin fecha caen en
el contador de «sin fecha estimada», que es justamente para hacerlas visibles.

### Margen de retiro

El ajuste `yardPickupGraceDays` se elimina de Configuración y del cálculo.

## Fuera de alcance

- **Qué celda ocupa cada vehículo.** No se modela: no hace falta saber dónde
  está parado cada uno, solo cuántas celdas quedan.
- **Reservas de entrada a futuro.** La proyección responde «cuántas celdas
  habrá libres el jueves», pero no permite reservar una para un vehículo que
  todavía no llegó. La ocupación arranca cuando la orden se abre.
- **Tamaños más allá de mediano y grande.** Explícitamente diferido.
- **Bloquear el ingreso por falta de lugar.** El aviso informa; la decisión es
  del taller.
