# Módulo de pagos a proveedores — Diseño

**Fecha:** 23 de agosto de 2026
**Estado:** aprobado

## Qué se va a construir

La orden de pago: se cancelan los comprobantes de compra con los medios de
pago disponibles, admitiendo pagos parciales, el pago de varios comprobantes y
la aplicación de notas de crédito.

Es el espejo de cobranzas
([spec](2026-08-23-cobranzas-design.md)). Todo lo que allá se decidió —pago
parcial, varios comprobantes, pago a cuenta, anulación que revierte todo— vale
igual acá. Este documento registra **solo lo que cambia**.

---

## Diferencia 1: las imputaciones llevan signo

Compras sí tiene notas de crédito, a diferencia de ventas. La orden imputa
facturas y notas de débito en **positivo** y notas de crédito en **negativo**:

```
FC A 0003-00012345   + $ 494.000
NC A 0003-00000212   − $  48.000
─────────────────────────────────
A pagar                $ 446.000
```

Así `imputado = suma de las imputaciones` sigue siendo una suma, sin casos
especiales. La base valida que el signo coincida con el tipo de comprobante:
una nota de crédito en positivo sería pagarle de más al proveedor por una
devolución.

`settled_amount` sube por el **valor absoluto** en los dos casos: en una
factura es lo que se pagó, en una nota de crédito es lo que se consumió de
ella.

### Compensación sin pago

Si una nota de crédito cancela exactamente una factura, la orden no mueve
plata: importe cero, sin valores. Se admite —es una operación real— y por eso
el total puede ser cero. Lo que se rechaza es una orden sin imputaciones y sin
valores, que no sería nada.

---

## Diferencia 2: el cheque se consume, no se crea

| | Cobranzas | Pagos |
|---|---|---|
| Cheque | el recibo **crea** uno nuevo en cartera | la orden **consume** uno existente |
| Se carga | tipeando número, banco, librador | eligiéndolo de una lista |
| Estado resultante | `EN_CARTERA` | `ENDOSADO` |

**No se llama a `endorse_check`.** Esa función postea su propio egreso, y el
egreso de la orden ya lleva la partida de la cartera: llamarla sacaría la
plata dos veces. Es la misma trampa que en cobranzas con `receive_check`.

Solo se ofrecen cheques en estado `EN_CARTERA`.

---

## Diferencia 3: la retención es al revés

Allá el cliente retenía y quedaba un crédito fiscal a favor del taller. Acá el
taller retiene y **le queda debiendo ese importe a ARCA**.

En los dos casos el efecto sobre el comprobante y la caja es el mismo: la
factura queda saldada por el total y la caja se mueve por menos.

**El sistema no lleva el pasivo con ARCA.** Se guarda la retención con su
alícuota y número de certificado, para el libro de retenciones. Lo que después
se deposita se carga como un gasto normal en Tesorería. Llevar el pasivo sería
otro subsistema: otra tabla, otra pantalla y su propio circuito de
vencimientos.

---

## Diferencia 4: anular devuelve el cheque a la cartera

En cobranzas, anular un recibo se **rechaza** si el cheque ya se depositó o
endosó: a esa altura salió de las manos del taller.

Acá es al revés. Si la orden de pago fue un error, el cheque sigue en poder
del taller: vuelve a `EN_CARTERA` y se limpia el endoso.

---

## Modelo de datos

- **`payment_orders`** — correlativo `OP-00000001`, proveedor con snapshot,
  fecha, total, imputado, a cuenta (columna generada), movimiento de
  tesorería, anulación.
- **`payment_order_allocations`** — comprobante de compra e importe **con
  signo**.
- **`payment_order_values`** — `MEDIO_PAGO`, `CHEQUE_ENDOSADO`, `RETENCION`,
  `SALDO_A_FAVOR`.

El movimiento de tesorería es **un solo `EGRESO`** con varias partidas,
sumando únicamente los valores que son plata.

---

## Pantallas

| Ruta | Qué es |
|---|---|
| `/pagos` | Órdenes y cuenta corriente por proveedor: deuda y saldo a favor |
| `/pagos/nueva` | Elegir proveedor → sus comprobantes pendientes → imputar → valores |
| `/pago/:id` | La orden, imprimible |

Los comprobantes se listan **de más viejo a más nuevo, con las notas de
crédito mezcladas** en la misma tabla: se pagan y se compensan juntos, y
separarlos obligaría a mirar dos lugares para entender un solo saldo.

---

## Verificación

El repo no tiene runner de tests y se decidió no sumar uno. Queda
`npm run lint`, `npm run build`, las guardas en la base (signo según tipo de
comprobante, saldo suficiente, cheque en cartera, crédito disponible, valores
que cubren lo imputado) y checklist manual.

## Aplicación de la migración

`supabase/payment-orders.sql`, después de `purchases.sql` y
`treasury-checks.sql`.
