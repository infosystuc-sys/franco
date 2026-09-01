# Carga de facturas de compra con IA — Diseño

**Fecha:** 1 de septiembre de 2026
**Estado:** en revisión

## Qué se va a construir

Un camino **nuevo y separado** para dar de alta una factura de compra:
subís el PDF o le sacás una foto al papel, Gemini lee los datos, los revisás
contra el original y confirmás. Convive con la carga manual que ya existe
([`PurchaseNew.tsx`](../../../src/pages/PurchaseNew.tsx)) sin reemplazarla —
son dos entradas de menú distintas, para que el operador elija según el caso:
un PDF prolijo del proveedor conviene leerlo con IA; una factura manuscrita o
ilegible se sigue cargando a mano como siempre.

Cubre los dos tipos que ya distingue Compras — `ARTICULOS` (renglones del
catálogo, mueven stock) y `CONCEPTOS` (texto libre, no tocan stock) — desde
el arranque, incluyendo el matcheo de renglones de artículos contra el
catálogo por código de proveedor.

**Contexto de referencia:** existe una app hermana del mismo autor,
`D:\APP\PH_FAC`, que hace exactamente este trabajo (PDF → IA → revisión →
guardado) para otra empresa sobre Tango/AFIP. Su código no se porta tal cual
(Next.js + SQL Server vs. Vite + Supabase acá), pero varias decisiones de
diseño de ese proyecto — comprobadas en producción real — se reutilizan
como patrón: mandar el PDF directo a un modelo con visión de documentos (sin
OCR previo), un JSON Schema por tipo de comprobante, confianza 0–1 por
campo devuelta por el propio modelo, y parseo tolerante de la respuesta.

---

## Decisiones ya tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Proveedor de IA | **Gemini** | Ya está declarado en `package.json` (`@google/genai`) sin usarse en ningún lado — no suma dependencia ni API key nueva. |
| Alcance v1 | **ARTICULOS y CONCEPTOS desde el arranque**, matcheo de renglones solo por código exacto de proveedor (sin fuzzy-matching de texto) | El matcheo por código ya tiene dónde apoyarse: `article_suppliers` guarda el código de cada proveedor por artículo. Fuzzy-matching queda para una v2 si el matcheo por código no alcanza en la práctica. |
| Origen del archivo | **PDF y foto con el celular** | Mismo input `capture="environment"` que ya usan Ingreso de vehículos y Fotos de OT. Cubre la factura que llega por mail y la que trae el proveedor en papel. |
| Arquitectura | **Síncrono, con el resultado crudo persistido en un borrador** (sin cola ni cron) | Mismo esfuerzo que un llamado síncrono simple, pero si el usuario cierra la pestaña a mitad de revisión no se pierde lo que ya leyó la IA. Una cola con reintentos (como en PH_FAC) es la evolución natural si el volumen algún día lo justifica — no hace falta para el volumen de un taller. |
| Separación de la carga manual | **Flujo, página y entrada de menú propias** | Pedido explícito: dos métodos disponibles, el operador elige. No se toca `PurchaseNew.tsx` como pantalla — se extraen a componentes compartidos solo las piezas de edición de renglones/impuestos/totales que hoy están inline ahí, para no duplicar esa lógica de UI entre las dos pantallas. |

---

## Modelo de datos

### Tabla nueva: `purchase_invoice_extractions`

Una fila por cada archivo leído por la IA — es el borrador, desde que se
sube el archivo hasta que se confirma (o se descarta).

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid pk | |
| `kind` | `ARTICULOS` \| `CONCEPTOS` | Elegido por el usuario antes de subir, igual que en la carga manual — no lo infiere la IA. |
| `supplier_id` | uuid, null | Sugerido por match de CUIT extraído contra `suppliers.tax_id`; null si no matcheó. |
| `attachment_storage_path` | text | Ruta en el bucket `purchase-invoice-drafts`. |
| `attachment_mime_type` | text | `application/pdf` o `image/*`. |
| `raw_extraction` | jsonb | Toda la respuesta del modelo: valores + confianza 0–1 por campo, y por renglón su resultado de matcheo (`article_id` o `null`). |
| `status` | `EXTRAIDO` \| `CONFIRMADO` \| `DESCARTADO` \| `ERROR` | |
| `error_message` | text, null | Solo si `status = ERROR`. |
| `purchase_invoice_id` | uuid, null, FK | Se completa recién cuando se confirma y `save_purchase_invoice` tiene éxito. |
| `created_by`, `created_at` | | |

RLS: `select`/`insert`/`update` solo para `is_admin()`, mismo criterio que
el resto de la base. Sin `delete` — un borrador descartado queda con
`status = DESCARTADO`, no se borra (auditoría: qué leyó la IA y qué se
decidió hacer con eso).

Esta tabla resuelve dos cosas con una sola pieza: el estado intermedio de
la revisión, **y** le da a Compras algo que hoy no tiene — un adjunto
permanente del comprobante original. El archivo en Storage queda ligado a
la factura para siempre vía `purchase_invoice_id`, no solo durante la
extracción.

### Bucket nuevo: `purchase-invoice-drafts`

Privado, mismas políticas que `vehicle-intakes` y `work-order-photos`
(`storage.objects` restringido a `is_admin()`). El cliente sube el archivo
directo al bucket — la Edge Function nunca recibe el binario por el body,
solo la ruta ya subida.

### Sin cambios en `purchase_invoices`, `purchase_invoice_items`, `purchase_invoice_taxes` ni `save_purchase_invoice`

La confirmación llama a la misma RPC de siempre, con los mismos controles
que ya tiene (duplicados, alícuotas válidas, stock, precio de compra). Cero
riesgo de que este camino nuevo debilite las validaciones del camino manual.

---

## Backend: Edge Function `extraer-factura-compra`

Recibe `{ attachment_storage_path, mime_type, kind }`. Hace, en orden:

1. **Valida rol admin** (mismo patrón que `gestionar-empleado`/`enviar-factura`: la API key de Gemini vive server-side, nunca en el cliente).
2. **Descarga el archivo** del bucket con la service key.
3. **Arma el pedido a Gemini** con el archivo como `document`/`image` inline (visión nativa, sin OCR previo) y `responseSchema` — un schema por `kind`:
   - `ARTICULOS`: encabezado (proveedor, CUIT, tipo/letra, punto de venta, número, fechas, condición de pago) + array de renglones (código impreso, descripción, cantidad, precio unitario, % bonificación, alícuota de IVA) + IVA discriminado por alícuota + percepciones + total.
   - `CONCEPTOS`: mismo encabezado + array de renglones de texto libre (descripción, importe, alícuota) — sin código de artículo.
   - Cada campo viene acompañado de su confianza 0–1, devuelta por el propio modelo (mismo mecanismo que PH_FAC).
4. **Parsea la respuesta tolerante**: campo faltante → vacío, campo de más → se descarta, solo se marca `ERROR` si el JSON no parsea o falta el objeto raíz. Nunca lanza por un campo raro.
5. **Matchea proveedor**: CUIT extraído contra `suppliers.tax_id`, exacto. Sin match → `supplier_id` queda null, se elige a mano en la revisión.
6. **Si `kind = ARTICULOS`, matchea renglones**: por cada línea con código impreso, busca en `article_suppliers` el artículo cuyo código de proveedor coincida (para el `supplier_id` ya resuelto en el paso anterior). Sin código, sin match, o proveedor sin resolver todavía → el renglón queda marcado `sin matchear`, se resuelve a mano en la revisión con el mismo `PurchaseArticlePicker` que ya existe.
7. **Inserta el borrador** en `purchase_invoice_extractions` con `status = EXTRAIDO` (o `ERROR` con el motivo, si algo de lo anterior falló de forma irrecuperable) y devuelve el id.

---

## Frontend: flujo propio, no integrado a `PurchaseNew.tsx`

### Entrada de menú

Categoría "Compras" suma una segunda tarjeta junto a la actual (que hoy solo
tiene `path: '/compras'`, sin `newPath`): **"Compras · Cargar con IA"**,
siguiendo el mismo patrón `newPath` que ya usan Facturación/Cobranzas/Pagos/
Cheques (`menuCategories.ts`). Las dos tarjetas quedan visibles una al lado
de la otra — el operador elige el método por factura, no una vez para
siempre.

### Rutas nuevas (propuesta, ajustable al planificar)

- `/compras-ia` — landing: lista de borradores `EXTRAIDO` pendientes de
  confirmar ("Facturas leídas por IA sin confirmar") + botón para subir una
  nueva.
- `/compras-ia/nueva/:kind` — paso 1: subir el archivo (PDF o foto). Llama a
  la Edge Function y muestra un spinner ("Leyendo la factura…") mientras
  responde.
- `/compras-ia/revisar/:extraccionId` — paso 2: pantalla de revisión.

### Pantalla de revisión

Visualmente parecida al formulario de carga manual (mismos campos de
encabezado, misma tabla de renglones, mismo panel de totales), pero es una
**página distinta** con:

- El PDF/foto original visible al costado (un `<iframe>`/`<embed>` para PDF,
  `<img>` para foto — no hace falta portar `pdfjs-dist` de PH_FAC, alcanza
  con el visor nativo del navegador para cotejar a ojo).
- Un chip de confianza (rojo/ámbar/gris) junto a cada campo que vino de la
  IA, mismo criterio visual que PH_FAC.
- Los renglones de ARTICULOS sin matchear, resaltados y con el
  `PurchaseArticlePicker` abierto de entrada para resolverlos — no se puede
  confirmar con un renglón sin artículo asignado (misma regla que ya aplica
  `save_purchase_invoice` en la carga manual).
- Botón "Reintentar lectura" si `status = ERROR` — reprocesa el mismo
  archivo ya subido, sin pedir que se vuelva a subir.

Al confirmar: llama a `savePurchaseInvoice` **sin cambios respecto a hoy**,
y si tiene éxito, marca el borrador `CONFIRMADO` con el `purchase_invoice_id`
resultante.

### Qué se extrae de `PurchaseNew.tsx` para no duplicar

Para que las dos pantallas (manual y revisión de IA) editen renglones,
impuestos y totales de forma idéntica sin copiar y pegar JSX, se extraen de
`PurchaseNew.tsx` — sin cambiar su comportamiento — tres piezas presentacionales:

- `PurchaseItemRow` (edición de un renglón: artículo o concepto, cantidad,
  precio, bonificación, alícuota).
- `PurchaseTaxRow` (percepciones/impuestos del pie).
- `PurchaseTotalsSummary` (el panel de totales, incluido el control cruzado
  "Total del comprobante" declarado vs. calculado).

La lógica de negocio (`computePurchaseTotals`, `savePurchaseInvoice`,
`describePurchaseError`, tipos) ya vive en
[`src/lib/purchases.ts`](../../../src/lib/purchases.ts) y no se toca — las
dos pantallas la importan igual.

---

## Prompt y schema — lecciones de PH_FAC a reaplicar (no a copiar)

- Un JSON Schema por `kind`, con los campos de encabezado + el array de
  renglones — atento al techo de campos que tolera el structured output de
  Gemini (PH_FAC midió empíricamente ~35 para Claude; **hay que remedirlo
  para Gemini, no asumir el mismo número**).
- Evaluar si conviene "cadena vacía en vez de null" para campos ausentes —
  en Claude evitaba que las uniones de tipo penalizaran el límite de campos;
  si el compilador de schema de Gemini tiene la misma restricción, se
  reaplica; si no, se usa `null` sin más.
- Confianza 0–1 devuelta por el modelo, por campo — mismo mecanismo, mismo
  criterio de semáforo en la UI.
- Instrucción explícita de "quién es el proveedor vs. quién es el taller",
  comparando el CUIT extraído contra el CUIT propio del taller (hay que
  confirmar dónde vive ese dato en Ludiesel — ver "a verificar" más abajo).
- Lectura literal de importes, sin normalizar decimales en el prompt — el
  parseo a número se hace después, en código propio, portando la idea de
  `normalizarImporte` de PH_FAC (formato argentino con puntos y comas
  mixtos) reescrita para Ludiesel.

---

## Manejo de errores

- Falla el llamado a Gemini (error, timeout) → el borrador queda
  `status = ERROR` con el motivo; la revisión no se pierde, se reintenta
  sobre el mismo archivo ya subido.
- Respuesta mal formada → parseo tolerante como se describió arriba; solo
  un JSON verdaderamente ilegible cuenta como `ERROR`.
- Factura duplicada → la protege la misma restricción que ya existe en
  `save_purchase_invoice` (único por proveedor + tipo + letra + punto de
  venta + número, con estado `REGISTRADA`) — sin trabajo nuevo, se hereda
  automáticamente por confirmar a través de la misma RPC.

---

## No entra en esta v1 (explícito, para no derivar solo)

- Fuzzy-matching de renglones por descripción — solo matcheo exacto por
  código de proveedor. Si en la práctica muchas facturas no traen código
  legible, se evalúa después.
- Cola con reintentos automáticos / procesamiento en lote sin supervisión —
  arquitectura síncrona alcanza para el volumen de un taller.
- Reemplazar o deshabilitar la carga manual — quedan las dos, en paralelo,
  para siempre (no es una migración con fecha de corte).
- Feature flag — es aditivo (una tarjeta de menú más), no hace falta apagarlo
  condicionalmente.

---

## A verificar antes de armar el plan de implementación

Ninguno de estos bloquea el diseño, pero conviene resolverlos antes de
convertir esto en tareas concretas:

1. Nombre exacto de la columna de "código del proveedor" en
   `article_suppliers` (confirmado que existe, falta el nombre literal).
2. Dónde vive el CUIT/razón social propios del taller en Ludiesel (para la
   instrucción del prompt "quién es el proveedor vs. nosotros").
3. Si existe un modal de alta rápida de proveedor — para cuando la IA lee un
   proveedor que todavía no está en `suppliers` (si no existe, hay que
   decidir si se agrega o si en v1 alcanza con un mensaje "cargalo primero en
   Proveedores").
4. Techo real de campos del structured output de Gemini (medir, no asumir
   el de Claude).
5. Costo de Gemini con visión + structured output, para estimar el gasto
   recurrente al volumen real de facturas del taller.
6. Si el proyecto tiene un test runner instalado (Vitest/Jest) — condiciona
   si conviene portar el estilo de tests de `extraccion.test.ts` de PH_FAC
   (fixture JSON + mock del SDK, sin pegarle a la API real en tests).

---

## Testing (una vez resuelto el punto 6 de arriba)

- Unit: parseo tolerante de la respuesta de Gemini (con fixture JSON, sin
  llamar a la API real) y la función de matcheo de renglones contra
  `article_suppliers`.
- Manual end-to-end: una factura ARTICULOS y una CONCEPTOS reales, subida,
  revisada y confirmada, siguiendo el patrón ya establecido en este
  proyecto (Playwright con datos reales, limpieza de datos de prueba
  después).
