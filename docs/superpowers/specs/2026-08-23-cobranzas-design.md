# Módulo de cobranzas — Diseño

**Fecha:** 23 de agosto de 2026
**Estado:** aprobado

## Qué se va a construir

El recibo de cobranza: se cobran las facturas de venta con los medios de pago
disponibles, admitiendo pagos parciales y el pago de varias facturas con un
solo recibo.

Cierra el circuito. Todo lo que necesita ya estaba esperando: `paid_amount` en
las facturas, `post_treasury_movement` en tesorería, la cartera de cheques y
el tipo `RETENCION` en el padrón de alícuotas.

---

## Restricciones que definen el diseño

**Una retención no es plata.** Si el cliente retiene $2.420, la factura queda
cancelada por los $121.000 completos pero a la caja entran $118.580. La
retención es un crédito fiscal. Tratarla como un cobro haría que el saldo del
banco diga $2.420 de más — y ese error no se nota hasta conciliar.

**Un saldo a favor que no se puede usar es peor que no tenerlo.** Si el cobro
a cuenta solo acumulara un número, el cliente pagaría dos veces o habría que
arreglarlo a mano. Por eso un recibo puede consumir crédito previo.

**El recibo genera un solo movimiento de caja.** No uno por valor: uno con
varias partidas. Es lo que permite que un cobro mitad efectivo y mitad cheque
sea un solo asiento, que es lo que fue.

**El cheque no se carga dos veces.** `receive_check` crea su propio ingreso;
acá el ingreso del recibo ya lleva la partida de la cartera. Llamarla
duplicaría la plata, así que el recibo inserta el cheque directamente y lo
cuelga de su propio movimiento.

---

## Modelo de datos

### `receipts` — la cabecera

Correlativo `REC-00000001`, cliente con snapshot del nombre, fecha, total
cobrado, total imputado, notas, y el movimiento de tesorería que generó.

`on_account_amount` es una columna generada: `total − imputado`. Lo que sobra
queda a cuenta.

### `receipt_allocations` — las imputaciones

Factura e importe. Es lo que permite las dos cosas que se pidieron: un importe
menor al saldo es un pago parcial, y varias filas son varias facturas en un
recibo. Son la misma tabla vista de dos maneras.

### `receipt_values` — con qué se cobró

| Tipo | Qué lleva | ¿Mueve caja? |
|---|---|---|
| `MEDIO_PAGO` | efectivo o banco | sí |
| `CHEQUE` | número, banco, librador, fecha de cobro | sí, a la cartera |
| `RETENCION` | alícuota del padrón + N° de certificado | **no** |
| `SALDO_A_FAVOR` | crédito previo del cliente | **no** |

La base valida que **la suma de los valores sea mayor o igual a la suma de las
imputaciones**.

### El saldo a favor

```
disponible = Σ(cobrado − imputado)  −  Σ(valores de tipo saldo a favor)
```

Sobre los recibos vigentes. Al anular un recibo, sus dos términos desaparecen
juntos, así que el crédito se recalcula solo.

---

## Los tres enganches

**Ventas.** Cada imputación sube `invoices.paid_amount`. El estado de cobro ya
se derivaba de ahí, así que las pantallas de facturación empiezan a mostrar
"Pagada" y "Pago parcial" sin tocarles una línea.

**Tesorería.** Un solo `INGRESO` cuyas partidas son los valores que sí son
plata. Si se cobró todo con retención y saldo a favor, no se genera ninguno:
no entró un peso.

**Cheques.** Entra a la cartera con su ficha, en estado `EN_CARTERA`, colgado
del movimiento del recibo.

---

## Anular

Revierte los tres: baja el `paid_amount`, anula el movimiento de caja y da de
baja el cheque.

**Rechaza la anulación si el cheque ya se depositó o endosó.** A esa altura el
valor salió de las manos del taller y no hay nada que deshacer; forzarlo
dejaría la cartera mintiendo.

Requiere agregar el estado `ANULADO` al ciclo de vida del cheque.

---

## Pantallas

| Ruta | Qué es |
|---|---|
| `/cobranzas` | Recibos y cuenta corriente por cliente: deuda y saldo a favor |
| `/cobranzas/nueva` | Elegir cliente → sus facturas impagas → imputar → cargar valores |
| `/recibo/:id` | El recibo, imprimible |

Las facturas se listan **de más vieja a más nueva**, que es el orden en que
normalmente se cancelan. Hay un botón para repartir el importe cobrado
automáticamente en ese orden.

---

## Una sola fase

Las imputaciones sin los valores no sirven, y los valores sin las imputaciones
tampoco. Partirlo dejaría las dos mitades inutilizables.

---

## Lo que queda afuera, y por qué

- **Notas de crédito de venta.** El módulo de facturación no las tiene: se
  corrige anulando y refacturando.
- **Intereses por mora.** El vencimiento se muestra, pero no se calcula
  recargo.
- **Cobranza automática de saldos a favor.** Aplicar crédito es explícito: se
  carga como un valor más del recibo.

---

## Verificación

El repo no tiene runner de tests y se decidió no sumar uno. Queda
`npm run lint`, `npm run build`, las guardas en la base (valores que cubren
las imputaciones, saldo suficiente por factura, crédito disponible, cheque
duplicado, estado del cheque al anular) y checklist manual.

## Aplicación de la migración

`supabase/receipts.sql`, después de `invoicing.sql`, `treasury-checks.sql` y
`purchase-catalogs.sql`.
