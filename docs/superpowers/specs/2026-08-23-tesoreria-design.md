# Módulo de tesorería — Diseño

**Fecha:** 23 de agosto de 2026
**Estado:** aprobado

## Qué se va a construir

El libro de caja del taller:

- **Gastos sin factura** — el remisero, el gomero, la ferretería de la esquina.
  Clasificados con el mismo padrón de conceptos que usan las facturas de
  compra de conceptos.
- **Ingresos** y **transferencias entre medios**, para que los saldos tengan
  sentido: sin ingresos la caja chica solo baja, y sin transferencias no se
  puede reflejar el gesto más común del taller, que es sacar de Caja para
  reponer Caja Chica.
- **Medios de pago** con su ABM y su saldo.
- **Cheques de terceros** con su ciclo de vida completo.

---

## Restricciones que definen el diseño

**El saldo no se guarda, se calcula.** Sale del saldo inicial más las partidas
del medio. Un saldo guardado en columna miente en cuanto algo falla a mitad de
camino, y después nadie sabe cuál de los dos números es el bueno.

**"Transferencia recibida" y "transferencia propia" no son medios de pago.**
Son la dirección de un movimiento sobre una cuenta bancaria. La plata que entra
y la que sale de la misma cuenta comparten saldo; separarlas en dos medios daría
dos saldos que nunca cerrarían contra el extracto del banco.

**Un cheque de tercero es un objeto con ciclo de vida, no un importe.** Tiene
número, banco, librador y fecha de cobro, y puede depositarse, endosarse o
rebotar. Tratarlo como un movimiento más haría imposible saber qué hay
realmente en la cartera.

**Tesorería es el libro único de caja**, no un módulo aislado. Cuando llegue
pagos, un pago a proveedor va a crear su movimiento acá con una referencia al
comprobante. Por eso el concepto es opcional en la cabecera: un pago de factura
no es un gasto de librería y no necesita clasificarse como tal.

---

## El movimiento y sus partidas

Un movimiento tiene una cabecera y **una o más partidas**, cada una con su
medio de pago y su importe con signo.

```
EG-00000012  Librería                TR-00000003  Reposición
  Caja Chica      −$ 8.000             Caja           −$ 20.000
                                       Caja Chica     +$ 20.000
```

Se eligió sobre la alternativa —columnas de origen y destino en la cabecera—
por dos razones concretas:

1. El saldo de cualquier medio pasa a ser `saldo inicial + suma de sus
   partidas`, una sola consulta sin casos especiales.
2. Cuando llegue pagos, un pago con parte en efectivo y parte en cheque entra
   sin tocar el modelo. Con columnas fijas habría que migrarlo.

La base valida que las partidas sumen el importe de la cabecera, y que una
transferencia sume cero.

---

## Modelo de datos

### `payment_methods` — el ABM

`kind` (`EFECTIVO` / `BANCO` / `CARTERA_CHEQUES`), nombre, datos bancarios
cuando corresponde, saldo inicial con su fecha, y activo.

**El tipo no es decorativo.** Solo un medio de tipo banco puede recibir el
depósito de un cheque, y la cartera no se mueve con movimientos sueltos sino
desde las operaciones de cheques. Sin tipo, nada impediría depositar un cheque
en la caja chica.

> **Corrección durante la fase 3.** Este documento decía originalmente que el
> saldo de la cartera saldría de los cheques en cartera. No cierra: un cheque
> rechazado vuelve a contar como valor pero su estado ya no es `EN_CARTERA`,
> así que habría dos reglas peleándose por el mismo número. La cartera calcula
> su saldo por partidas como cualquier otro medio; lo que cambia es que sus
> partidas las genera el módulo de cheques, y la carga manual las rechaza.

**Una sola cartera de cheques**, garantizada por un índice único parcial. Con
dos, un cheque no sabría a cuál pertenece y el módulo de cheques tendría que
preguntarlo en cada operación sin ninguna ganancia.

La cartera arranca siempre en cero: los cheques que ya estén en mano se cargan
como cheques, no como saldo inicial. Un importe suelto ahí sería un saldo que
no se corresponde con ningún valor real.

Se siembran **Caja**, **Caja Chica** y **Cheques de terceros**. La cuenta
bancaria **no** se siembra: depende del banco de cada taller, y un placeholder
se copiaría a los movimientos sin que nadie lo revise.

### `treasury_movements` — la cabecera

Tipo (`EGRESO` / `INGRESO` / `TRANSFERENCIA`), correlativo propio por tipo,
fecha, concepto (opcional, de `expense_concepts`), detalle, beneficiario en
texto libre, importe, notas, y anulación con motivo como en el resto del
sistema.

### `treasury_movement_legs` — las partidas

Medio de pago e importe con signo.

### `third_party_checks` — los cheques

Número, banco, librador, fechas de emisión y de cobro, importe y estado:

```
EN CARTERA ─┬─ Depositar → DEPOSITADO ─┬→ ACREDITADO
            │                          └→ RECHAZADO
            └─ Endosar   → ENDOSADO (entregado a un proveedor)
```

**La plata entra al banco al ACREDITAR, no al depositar.** Hasta que el banco
no confirma, los fondos no existen y el valor sigue en riesgo, así que mientras
está depositado sigue contando en la cartera.

| Operación | Movimiento |
|---|---|
| Recibir | `INGRESO` a la cartera |
| Depositar | ninguno — solo cambia el estado |
| Acreditar | `TRANSFERENCIA` cartera → banco |
| Rechazar | si estaba acreditado, `TRANSFERENCIA` banco → cartera |
| Endosar | `EGRESO` de la cartera |

Un cheque rechazado **vuelve a contar en la cartera**: normalmente se le
reclama al cliente o se lo reemplaza, así que el valor sigue existiendo hasta
que se decida darlo de baja.

**Único por `(banco, número)`.** Cargar dos veces el mismo cheque infla la
cartera igual que una factura repetida infla la deuda.

---

## Numeración

Serie propia por tipo de movimiento (`EG-`, `IN-`, `TR-`), tomada con bloqueo
de fila dentro de la misma transacción que inserta el movimiento. Es el mismo
mecanismo que ya usan las facturas de venta.

Tabla y no `sequence` de Postgres, por lo mismo que en facturación: una fila se
deja corregir y una secuencia no.

---

## Fases

| Fase | Qué deja andando |
|---|---|
| **1** | ABM de medios de pago con saldo inicial |
| **2** | Gastos sin factura, ingresos y transferencias, con saldos y arqueo |
| **3** | Cheques de terceros con su ciclo completo |

Fase 3 al final porque los cheques se apoyan en los movimientos: un cheque
entra por un ingreso y sale por un depósito o un endoso. Si el motor de
movimientos no está probado, el ciclo del cheque se construye sobre arena.

---

## Lo que queda afuera, y por qué

- **Cheques propios.** El taller no emite chequera.
- **Conciliación bancaria.** El saldo del sistema no se cruza contra el
  extracto. Es un módulo propio.
- **Pagos a proveedores y cobranzas.** Van a apoyarse en este libro, pero son
  módulos aparte.
- **Arqueo con cierre.** Se muestra el saldo, pero no hay cierre de caja
  diario que congele un período.

---

## Verificación

El repo no tiene runner de tests y se decidió no sumar uno. Queda
`npm run lint`, `npm run build`, las guardas en la base (partidas que cuadran,
correlativo, tipo de medio, duplicados de cheque) y checklist manual.

## Aplicación de las migraciones

El MCP de Supabase no tiene permiso sobre el proyecto de esta app, así que los
archivos se corren a mano en el SQL Editor. En orden:
`supabase/treasury-methods.sql` (fase 1),
`supabase/treasury-movements.sql` (fase 2) y `supabase/treasury-checks.sql`
(fase 3).
