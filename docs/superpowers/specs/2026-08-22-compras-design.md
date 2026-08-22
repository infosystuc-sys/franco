# Módulo de compras — Diseño

**Fecha:** 22 de agosto de 2026
**Estado:** aprobado

## Qué se va a construir

Registrar los comprobantes que llegan de proveedores, en dos formas:

- **Facturas de artículos** — llevan artículos del catálogo, mueven stock y
  actualizan el precio de compra.
- **Facturas de conceptos** — gastos sin stock asociado (fletes, energía,
  honorarios).

Todo va a la cuenta corriente del proveedor, para que el módulo de pagos se
monte encima. Se suma además un padrón de alícuotas (IVA, percepciones,
retenciones) y uno de conceptos de gasto.

---

## Restricciones que definen el diseño

**El número lo trae el proveedor.** A diferencia de la venta, acá no se genera
nada: tipo, letra, punto de venta y número se transcriben del papel. El
sistema no numera, valida.

**Cargar dos veces la misma factura es el error más común de compras**, y en
este módulo duplica dos cosas a la vez: la deuda y el stock. La guarda va en
la base, no en la pantalla.

**El comprobante es un registro congelado**, igual que en ventas: guarda copia
de los datos fiscales del proveedor y de las alícuotas aplicadas. Editar el
padrón no puede alterar un comprobante ya cargado.

**Un renglón exento y uno gravado al 0% dan el mismo IVA — cero — pero no van
al mismo renglón del pie.** Sin distinguirlos, el pie y el Libro IVA Compras
salen mal. Es la razón de la columna `vat_treatment`.

**Percepción y retención no son lo mismo y no caen en el mismo módulo.** La
percepción la cobra el proveedor y viene impresa en su factura: suma al total
y a la deuda. La retención la practica el taller al pagar, resta de lo que se
transfiere y genera un certificado. El padrón de alícuotas define las dos; las
retenciones las usa el módulo de pagos, no éste.

---

## Modelo de datos

### `tax_rates` — el padrón de alícuotas

| Campo | Para qué |
|---|---|
| `kind` | `IVA`, `PERCEPCION`, `IMPUESTO_INTERNO`, `RETENCION` |
| `name` | "IVA 21%", "Percepción IIBB Tucumán" |
| `rate` | el porcentaje |
| `base` | `NETO` o `TOTAL` — sobre qué se aplica; varía según el impuesto |
| `jurisdiction` | provincia, para las de Ingresos Brutos |
| `vat_treatment` | solo en las de IVA: `GRAVADO`, `EXENTO`, `NO_GRAVADO` |
| `active` | |

`base` no queda fijo a propósito: hay percepciones sobre el neto y otras sobre
el total con IVA. Clavarlo obligaría a corregir el importe a mano en cada
factura.

Se siembra con la lista de IVA de AFIP (0; 2,5; 5; 10,5; 21; 27) más "Exento"
y "No gravado". Las percepciones **no** se siembran: dependen de la provincia
y del padrón de cada proveedor, y un valor inventado es peor que uno vacío.

### `expense_concepts` — conceptos de gasto

`name`, `active`. Padrón chico para poder agrupar el gasto por tipo, que con
texto libre puro no se puede hacer nunca. El renglón admite igual texto libre
cuando el gasto no encaja en ninguno.

### `suppliers` — un campo nuevo

`payment_terms_days` (default 30). De ahí sale el vencimiento propuesto al
cargar el comprobante, que después se puede pisar.

### `purchase_invoices` — el comprobante

**Encabezado:** `kind` (`ARTICULOS` / `CONCEPTOS`), `doc_type` (`FACTURA` /
`NOTA_CREDITO` / `NOTA_DEBITO`), `letter`, `sales_point`, `number`,
`supplier_id`, snapshot fiscal del proveedor, `issue_date` (la del papel),
`received_date`, `due_date`, `payment_terms_days`.

**Importes:** `gross_amount`, `line_discount_amount`,
`general_discount_percent`, `general_discount_amount`, `net_taxed`,
`net_exempt`, `net_untaxed`, `vat_amount`, `other_taxes_amount`,
`total_amount`, `settled_amount`.

`settled_amount` es el enganche del módulo de pagos, igual que `paid_amount`
en ventas. Se llama distinto porque en una nota de crédito no es "pagado" sino
"aplicado".

`signed_total` es una columna generada: negativa en las notas de crédito,
positiva en el resto. Así el saldo de un proveedor es una suma y nada más.

**Único:** `(supplier_id, doc_type, letter, sales_point, number)`.

### `purchase_invoice_items` — el cuerpo

Cantidad, precio bruto, `discount_percent` por renglón, `net_amount` ya
descontado, y la alícuota de IVA **congelada** (`vat_rate`, `vat_treatment`)
además del FK.

Exactamente uno de `article_id` / `concept_id` según el `kind` del
comprobante, o ninguno de los dos si es un renglón de texto libre.

### `purchase_invoice_taxes` — el pie

Una fila por percepción o impuesto interno: nombre y porcentaje congelados,
base e importe. **El importe se calcula pero queda editable**: la cuenta del
proveedor a veces redondea distinto y el comprobante tiene que cerrar exacto
igual.

---

## Lo que hace una factura de artículos

Dentro de la misma transacción que la guarda:

1. Repone stock con `adjust_article_stock`, que ya existe y con delta positivo
   repone.
2. Pisa `article_suppliers.purchase_price` con el neto unitario ya
   bonificado, lo que recalcula solo el precio de venta según la utilidad.

**La nota de crédito lleva un tilde "devuelve mercadería"**, marcado por
defecto: la misma NC puede ser una devolución (resta stock) o un ajuste de
precio (no lo toca), y en el papel no se distinguen.

**La nota de crédito nunca actualiza el precio de compra.** Un ajuste puntual
no debería mover la lista de venta.

## Anulación

`void_purchase_invoice` revierte el movimiento de stock. Si los repuestos ya
se consumieron en una orden, `adjust_article_stock` rechaza la anulación por
stock insuficiente — y está bien: no se puede deshacer una compra cuya
mercadería ya salió. El mensaje lo explica en esos términos.

---

## Fases

Cada fase deja algo usable.

### Fase 1 — Cimientos
- ABM de alícuotas.
- ABM de conceptos de gasto.
- Plazo de pago en el ABM de proveedores.

### Fase 2 — Compras de conceptos
- El comprobante completo: encabezado, cuerpo y pie de impuestos.
- Cuenta corriente por proveedor.

### Fase 3 — Compras de artículos
- Renglones con artículo del catálogo.
- Movimiento de stock y actualización del precio de compra.

**Fase 2 antes que 3 a propósito.** El comprobante y el pie de impuestos son
idénticos en las dos, y conviene tenerlos probados antes de sumarles
movimiento de stock encima. Un error en el pie, en conceptos, se corrige y
listo; en artículos ya movió el inventario.

---

## Lo que queda afuera, y por qué

- **Retenciones aplicadas.** El padrón las define; practicarlas es del módulo
  de pagos, porque no existen hasta que se paga.
- **Multimoneda.** Todo en pesos. Una compra en dólares se convierte antes de
  cargarla.
- **Mezclar artículos y conceptos en un mismo comprobante.** Un comprobante es
  de una cosa o de la otra.
- **Órdenes de compra y remitos.** El circuito arranca en la factura recibida.

---

## Verificación

El repo no tiene runner de tests y se decidió no sumar uno. Queda
`npm run lint` y `npm run build`, las guardas en la base (duplicados, stock,
consistencia de importes) y checklist manual.

## Aplicación de las migraciones

El MCP de Supabase no tiene permiso sobre el proyecto de esta app, así que los
archivos se corren a mano en el SQL Editor. Fase 1 es
`supabase/purchase-catalogs.sql`.
