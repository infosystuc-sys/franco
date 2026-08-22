# Módulo de facturación (sin ARCA) — Diseño

**Fecha:** 21 de agosto de 2026
**Estado:** aprobado

## Qué se va a construir

Emitir facturas a partir de una orden de trabajo terminada. Todas salen en
cuenta corriente con vencimiento a los 7 días. Sin conexión a ARCA: el
comprobante no lleva CAE ni código de barras, pero **su forma es la que ARCA
va a pedir**, para que la integración futura no obligue a migrar datos ni a
renumerar lo ya emitido.

Es el paso previo al módulo de cobranzas, que se apoya sobre el saldo que
esta capa deja registrado.

---

## Restricciones que definen el diseño

**El comprobante es un registro congelado, no una vista.** Si mañana se
corrige el CUIT de un cliente o cambia el precio de un artículo, la factura
ya emitida no puede moverse. Por eso guarda copia de los datos del cliente,
del emisor y de los renglones, y no los lee por join al imprimirse.

**El correlativo no se puede repetir ni saltear.** Es lo que vuelve al
comprobante oponible. Se toma dentro de la misma transacción que inserta la
factura, con bloqueo de fila.

**Nada fiscal se calcula en el navegador.** La app es un sitio estático:
cualquiera puede llamar a la API de Supabase con la anon key. La letra del
comprobante, el IVA y el número los decide la base. El navegador propone
renglones; no propone totales.

**Cobranzas viene después y no puede obligar a migrar.** El estado de cobro
se deriva de un importe (`paid_amount`), no de un enum. Cobranzas solo va a
mover ese número.

---

## Modelo de datos — `supabase/invoicing.sql`

### `company_settings` — el emisor

Una sola fila, forzada por `id boolean primary key check (id)`. Razón social,
CUIT, condición frente al IVA, **punto de venta**, ingresos brutos, inicio de
actividades y domicilio.

Es el faltante que el diseño de WhatsApp ya había señalado: hoy se guarda la
condición de IVA del *cliente*, que define si la factura es A o B, pero no
existen los datos del taller. Sin ellos no se puede facturar.

### `invoice_sequences` — la numeración

`(invoice_type, sales_point) → last_number`, tomada con `for update`.

Tabla y no `sequence` de Postgres a propósito: cuando entre ARCA hay que poder
**sincronizar** el correlativo con el último número que AFIP dio por
autorizado. Una secuencia de Postgres no se deja corregir cómodamente; una
fila sí.

### `invoices`

| Grupo | Campos | Para qué |
|---|---|---|
| Identidad | `invoice_type` (A/B/C), `sales_point`, `number`, `full_number` generado | `0001-00000001`, el formato de ARCA |
| Origen | `work_order_id`, `customer_id` | trazabilidad |
| Snapshot cliente | `customer_name`, `customer_legal_name`, `customer_tax_id`, `customer_tax_condition`, `customer_address` | la factura no cambia si el cliente se edita |
| Snapshot emisor | `issuer_legal_name`, `issuer_tax_id`, `issuer_tax_condition`, `issuer_address`, `issuer_gross_income`, `issuer_activity_start_date` | ídem, si cambian los datos del taller |
| Cuenta corriente | `issue_date`, `due_date`, `payment_terms_days` (7) | el vencimiento se congela al emitir |
| Importes | `net_amount`, `vat_amount`, `total_amount`, `paid_amount` (default 0) | `paid_amount` es el enganche de cobranzas |
| Estado | `status` (`EMITIDA` \| `ANULADA`), `voided_at`, `voided_reason` | |

**El estado de cobro no está en el enum.** Se deriva: `paid_amount = 0` →
impaga; `0 < paid_amount < total` → parcial; `>= total` → pagada. Y "vencida"
sale de `due_date` con saldo pendiente, igual que `isExpired` en cotizaciones.
Cobranzas no va a necesitar migrar el enum.

**Una OT tiene como máximo una factura activa**, garantizado en la base:

```sql
create unique index invoices_una_activa_por_ot
  on invoices (work_order_id) where status = 'EMITIDA';
```

Ese índice parcial hace las dos cosas de una vez: impide facturar dos veces la
misma orden, y deja que anular libere la OT para refacturar. No hace falta
ninguna columna nueva en `work_orders`.

### `invoice_items`

Copia congelada de los renglones: código, descripción, cantidad, precio
unitario neto, subtotal y posición. `article_id` queda con `on delete set
null` — sirve para reportes, pero la factura no depende de que el artículo
siga existiendo.

---

## La letra del comprobante y el IVA

`articles.unit_price` es **neto** (así lo fija `price-lists.sql`), de modo que
los renglones son netos y el IVA se calcula sobre el total.

| Emisor | Cliente | Comprobante | IVA |
|---|---|---|---|
| Responsable Inscripto | Responsable Inscripto | **A** | 21% discriminado |
| Responsable Inscripto | CF / Monotributo / Exento | **B** | 21% incluido, no se discrimina |
| Monotributo / Exento | cualquiera | **C** | sin IVA (`vat_amount = 0`) |

Vive como función pura `invoiceTypeFor(emisor, cliente)` en
`src/lib/invoices.ts` para que la pantalla pueda anticipar la letra, y **la
RPC la recalcula** antes de insertar. La del navegador es una previsualización;
la que vale es la de la base.

---

## RPCs

Mismo patrón que `convert_quotation_to_work_order`: una sola transacción del
lado de la base, y si algo falla no queda nada a medias.

### `issue_invoice(p_work_order_id, p_items, p_notes)`

Valida en orden: `is_admin()` → la OT existe (`for update`) → **está en
`TERMINADO`** → no tiene ya una factura `EMITIDA` → hay renglones →
`company_settings` está cargado. Después calcula letra y totales, toma el
correlativo e inserta factura y renglones.

El `for update` sobre la OT es lo que hace que un doble clic no emita dos
facturas.

Si faltan los datos del taller, el mensaje es accionable: *"Cargá los datos
fiscales del taller en Configuración"* — no un error de constraint.

### `void_invoice(p_invoice_id, p_reason)`

`is_admin()`, estado `EMITIDA`, **`paid_amount = 0`** y motivo no vacío.

La guarda de `paid_amount` es la importante: sin ella, cobranzas heredaría
facturas anuladas con cobros imputados encima, que es un agujero contable que
después no se cierra.

### RLS

`select` solo admin, igual que cotizaciones y proveedores: la facturación es
información comercial y el operario no la ve. La escritura pasa solo por las
RPCs.

---

## Pantallas

| Ruta | Qué es |
|---|---|
| `/facturar/:otNumber` | El proceso de facturación: emisor, cliente, la letra calculada con su porqué, fechas, renglones editables, totales, notas y "Emitir factura" |
| `/factura/:id` | La factura emitida, que es **a la vez el documento imprimible**. Botón Anular |
| `/facturas` | Listado con KPIs (emitidas · por cobrar · vencido), filtros y buscador |
| `/configuracion` | Los datos fiscales del taller |

`/factura/:id` va por id y no por número porque una factura A y una B comparten
correlativo: `0001-00000012` no identifica a una sola.

### El borrador vive en memoria

"Facturar" **no** crea una fila. La pantalla copia los renglones de la OT al
estado de React, se editan ahí, y recién al confirmar la RPC crea la factura
ya numerada y congelada.

La alternativa —una fila en estado `BORRADOR`— obligaba a decidir si un
borrador cuenta como "OT ya facturada", dejaba correlativos consumidos en
falso y llenaba el listado y la cuenta corriente de comprobantes a medio
hacer. El costo de esta decisión es que cerrar la pantalla pierde los ajustes,
aceptable en un flujo de dos minutos.

### En la orden de trabajo

- `TERMINADO` y sin factura → botón **Facturar**.
- Sin terminar → deshabilitado, diciendo por qué.
- Ya facturada → deja de ser un botón y pasa a ser un link a la factura,
  simétrico al *"Nace de la cotización COT-…"* que la pantalla ya tiene.

### Impresión

La pantalla de detalle lleva `@media print`: esconde menú, barra superior,
pie y botones, y deja el comprobante solo, en A4. "Guardar como PDF" del
navegador alcanza. Sin librerías nuevas, y funciona igual dentro de la app
Android.

---

## Cambio en código existente

`ItemsEditor` tiene el cuadro de totales con IVA 21% clavado, y en una factura
C el IVA es cero. Se le agrega una prop opcional `totals?: React.ReactNode`
que reemplaza ese cuadro. Los tres llamadores actuales no se tocan.

Es el cambio mínimo: la alternativa era duplicar el editor de renglones para
la factura, y entonces cualquier arreglo habría que hacerlo dos veces.

---

## Verificación

El repo no tiene runner de tests y se decidió no sumar uno. Queda:

- `npm run lint` (`tsc --noEmit`) y `npm run build`.
- Las guardas que importan —letra, totales, correlativo, doble facturación,
  anulación con cobros— están **en la base**, donde no dependen de que la
  interfaz se comporte bien.
- Checklist manual de flujo end-to-end.

---

## Lo que queda afuera, y por qué

- **ARCA / CAE.** Es el pedido explícito. El modelo ya deja el lugar: tipo,
  punto de venta, correlativo y condiciones de IVA en el formato que el
  servicio pide.
- **Nota de crédito.** Corregir se hace anulando y refacturando. La nota de
  crédito es un comprobante fiscal propio y tiene sentido recién con ARCA
  conectado.
- **Facturar varias OT en un solo comprobante.** Una OT, una factura.
- **Cuenta corriente por cliente y cobros.** Es el módulo siguiente. Esta capa
  le deja `due_date` y `paid_amount` listos.

---

## Aplicación de la migración

El MCP de Supabase no tiene permiso sobre el proyecto de esta app
(`mnoqdqjhsylohlvuekfh`), así que `supabase/invoicing.sql` se corre a mano en
el SQL Editor. El archivo queda además como registro del esquema, igual que
el resto de `supabase/*.sql`.
