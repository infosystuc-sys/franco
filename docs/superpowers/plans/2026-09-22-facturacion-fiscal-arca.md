# Facturación fiscal con ARCA (WSFEv1)

**Fecha:** 2026-09-22
**Estado:** propuesta — nada implementado todavía

### Decisiones tomadas (22/09)
- Portal de ARCA: **PV 1 habilitado como Web Services y `wsfe` delegado a RIVAI**. Listo.
- **Directo a producción, sin homologación.** (Se había elegido homologación y se
  revirtió.) Por eso la fase 1 es solo lectura: es la única red de seguridad.
- **Punto de venta propio para la app: el 3.** El PV 1 lo sigue usando el sistema
  actual y el 2 ya estaba ocupado. El 3 quedó dado de alta en ARCA (23/09). Ver punto 3.
- **Nota de crédito después.** Fase 5 queda para una segunda etapa.

### Avance
- **Fase 1 hecha (22/09).** `facturacion-arca` desplegada con la acción
  `diagnostico`; WSAA sacado a `supabase/functions/_shared/arca.ts`. Botón
  "Probar conexión con ARCA" en Configuración, en la tarjeta del certificado de
  facturación. Verificado: rechaza sin sesión (401) y sin rol admin (403), y
  `FEDummy` de producción responde OK con el mismo sobre que arma la función.
- **Diagnóstico corrido y verificado (23/09).** Certificado cargado, CUIT
  correcto, vence en 725 días. PV 0001 habilitado (2122 A / 74 B — el del
  sistema actual). **PV 0003 habilitado, 0/0 — nunca facturó.** "Todo en
  orden para facturar." Fase 1 cerrada.
- **`sales_point` sigue en 1 a propósito.** Se pasa a 3 en el mismo momento en
  que se enciende el CAE real (fase 3). Si se cambiara antes, cualquier factura
  emitida con el CAE simulado tomaría un número del PV 3 que ARCA no conoce, y
  la primera factura real chocaría contra ella en el índice único.

Pedir el CAE a ARCA al emitir una factura, en vez del CAE simulado de hoy.

---

## 1. De dónde partimos

Buena parte del camino ya está hecho, y conviene saber qué se reusa antes de
decidir cuánto trabajo es esto.

### Lo que ya existe y sirve

| Pieza | Dónde | Estado |
|---|---|---|
| **WSAA completo** | `supabase/functions/consultar-padron/index.ts` | Firma PKCS#7 con node-forge, SOAP a LoginCms, cacheo del ticket en `arca_tickets`. **Andando en producción.** |
| Tabla de certificados | `arca_credentials` | Con el lugar `FACTURACION` ya reservado. RLS sin policies: solo la llave de servicio lee. |
| Cargar certificado | `guardar_certificado_arca()` | Valida encabezados PEM. Ya usada para PADRON. |
| Columnas del CAE | `invoices.cae`, `cae_due_date`, `cae_simulated` | Creadas, hoy con valor simulado. |
| Dos series separadas | `sales_point` (1) y `sales_point_internal` (90000) | La X nunca debe ir a ARCA. Ya está aparte. |
| Letra según el cliente | `invoiceTypeFor()` | A para Responsable Inscripto, B para el resto. |

**WSAA es la parte difícil de AFIP y está resuelta.** Eso reduce el trabajo a la
mitad de lo que sería desde cero.

### El certificado nuevo

```
CN=RIVAI, serialNumber=CUIT 30718401972
Emisor: CN=Computadores, O=AFIP, C=AR
Vigencia: 18/09/2026 → 17/09/2028
```

El CUIT **coincide** con el de `company_settings` (Luciano Diesel S.R.L.,
Responsable Inscripto, punto de venta 1). Es el certificado correcto.

Ojo con un detalle: el certificado de PADRON que está cargado es de **otro
CUIT** (20418705516). Eso está bien para consultar padrón —a ARCA solo le
importa quién firma— pero para facturar el certificado tiene que ser del CUIT
que emite. Por eso van en filas distintas de la misma tabla.

### Lo que falta

1. La Edge Function que pide el CAE (`FECAESolicitar`).
2. Que la numeración salga de ARCA y no de nuestro contador.
3. Resolver la atomicidad: pedir el CAE es una llamada externa que no puede
   vivir dentro de una transacción.
4. Nota de crédito electrónica. Hoy `void_invoice()` solo cambia un estado a
   `ANULADA`, y eso **no es válido fiscalmente**: una factura con CAE existe
   para ARCA y solo se revierte con una NC que tiene su propio CAE.
5. El QR del comprobante (RG 4892).
6. La condición frente al IVA del receptor (RG 5616), obligatoria desde 2024.

---

## 2. El problema central: la atomicidad

Hoy `_create_invoice()` reserva el número y escribe la factura en **una sola
transacción**. Con ARCA eso deja de ser posible, y es el punto donde más fácil
se rompe todo.

Tres cosas no pueden pasar:

- **Número sin CAE.** ARCA exige numeración correlativa estricta por punto de
  venta y tipo. Un número que nunca recibió CAE deja un hueco, y todas las
  facturas siguientes son rechazadas con error 10016.
- **CAE sin factura.** Si ARCA otorga el CAE y nuestra escritura falla después,
  el comprobante existe para ARCA y no para nosotros. Reintentar pide un número
  nuevo y el anterior queda colgado.
- **CAE duplicado.** Reintentar a ciegas puede pedir dos CAE para el mismo
  comprobante.

### La solución: tres fases y ARCA como fuente de verdad

```
Fase 1 (transacción)   reservar el número, estado PENDIENTE_CAE
Fase 2 (fuera)         llamar a ARCA — puede fallar, tardar o cortarse
Fase 3 (transacción)   guardar el CAE, estado EMITIDA
```

Si la fase 2 falla o no se sabe qué pasó, la factura **queda en
`PENDIENTE_CAE`** y no se inventa nada. Un trabajo de reconciliación le
pregunta a ARCA con `FECompConsultar` qué pasó realmente con ese número:

- ARCA tiene CAE para ese número → se guarda (fase 3) y queda EMITIDA.
- ARCA no lo conoce → se reintenta con el mismo número.

**ARCA es la fuente de verdad, no nuestra base.** Esa es la regla que evita
tanto el hueco como el duplicado.

Esto implica un estado nuevo en `invoice_status` y que la pantalla sepa
mostrarlo: una factura en `PENDIENTE_CAE` no se imprime ni se manda al cliente.

---

## 3. La numeración — con otro sistema emitiendo en paralelo

ARCA lleva su propio contador por (punto de venta, tipo de comprobante). El
nuestro está hoy en cero para A, B y X.

### Lo que ya existe
**El lugar para fijar el próximo número ya está hecho**: Configuración,
tabla de numeración, respaldada por `fijar_proximo_numero()`, que se niega a
retroceder por debajo de lo que ya emitimos nosotros.

### Por qué no alcanza con eso
El otro sistema sigue emitiendo en el PV 1. Un número cargado a mano queda
viejo en cuanto el otro sistema factura:

```
lunes      fijamos el próximo en 1500
martes     el otro sistema emite 1500, 1501 y 1502
miércoles  pedimos el 1500  →  ARCA rechaza con 10016
```

La numeración manual solo sirve si nadie más toca ese punto de venta.

### La solución: preguntarle a ARCA justo antes de emitir
En cada emisión, `FECompUltimoAutorizado` inmediatamente antes de
`FECAESolicitar`, y usar ese número + 1. ARCA sabe el último número real sin
importar qué sistema lo emitió. El campo manual queda como referencia visible,
pero **ARCA manda**.

Queda una carrera de un segundo: los dos sistemas preguntan a la vez, los dos
reciben "último = 1502" y los dos piden el 1503. Uno es rechazado. Se resuelve
reintentando con número fresco ante el 10016, sin intervención.

### La alternativa limpia: un punto de venta propio
**Recomendado.** Habilitar un PV nuevo solo para esta app (quedó el 3: el 2 estaba ocupado).
Cada sistema tiene su contador, no hay carreras y no hay que fijar números a
mano nunca. Es la práctica habitual cuando se migra entre sistemas: el día que
el sistema viejo deja de usarse, simplemente se deja de usar su PV.

Cuesta un trámite más en el portal y que las facturas de la app salgan con otra
numeración (`0003-…` en vez de `0001-…`). Legalmente no hay diferencia.

---

## 4. Lo que hay que hacer en el portal de ARCA

**Producción — hecho (22/09):**
- ~~Habilitar el punto de venta 1 como "Factura Electrónica — Web Services"~~
- ~~Delegar el servicio `wsfe` al alias RIVAI~~

**Homologación — pendiente:**
1. En *WSASS — Autogestión Certificados Homologación*, subir el `.req` de
   `E:\CERT` y descargar el `.crt` de homologación.
2. En el mismo WSASS, crear la autorización del alias al servicio `wsfe`.

~~**PV propio:** habilitar el PV 3 como~~ Hecho (23/09). Se habilitó el PV 3 como
"Factura Electrónica — Web Services".

---

## 5. Fases de implementación

### Fase 0 — Certificado de homologación y ambientes
El certificado de `E:\CERT` es de **producción**. Homologación necesita el
suyo, tramitado en *WSASS — Autogestión Certificados Homologación*.

**Se puede reusar el mismo pedido.** El `.req` que está en `E:\CERT` sirve
para WSASS: se sube, se obtiene un `.crt` de homologación firmado con la misma
clave privada, y después se crea la autorización al servicio `wsfe` también
ahí. No hace falta generar otra clave.

En el código, **el ambiente pasa a ser un dato, no una constante**:

| | Homologación | Producción |
|---|---|---|
| WSAA | `wsaahomo.afip.gov.ar` | `wsaa.afip.gob.ar` |
| WSFE | `wswhomo.afip.gov.ar/wsfev1` | `servicios1.afip.gov.ar/wsfev1` |

Hoy la URL de WSAA está fija en producción dentro de `consultar-padron`. Hay
que sacarla a configuración, y separar por ambiente tanto los certificados
como los tickets en caché: un ticket de homologación no sirve en producción.

Cargar el `.crt` y el `.key` como `FACTURACION` por la pantalla de
Configuración, que ya usa `guardar_certificado_arca()`.

**El `.key` no entra al repositorio.** `.gitignore` ya excluye `*.key`, `*.crt`,
`*.pem` y `*.csr`, y hoy no hay ninguno versionado. Los archivos se quedan en
`E:\CERT` y su contenido va a la base por la pantalla.

### Fase 1 — Probar la conexión sin emitir nada
Edge Function nueva que reusa el WSAA de `consultar-padron` y llama tres
métodos **de solo lectura**:

- `FEDummy` — ARCA está arriba.
- `FECompUltimoAutorizado` — el último número de cada serie.
- `FEParamGetCotizacion` / `FEParamGetTiposIva` — que el ticket sirve.

Esto prueba certificado, delegación y punto de venta **sin emitir un solo
comprobante**. Si algo del portal quedó mal, se descubre acá y no con un
cliente enfrente.

### Fase 2 — El estado PENDIENTE_CAE
El cambio de esquema y de `_create_invoice()` descrito en el punto 2. Todavía
sin llamar a ARCA: la factura nace pendiente y un paso manual la pasa a
emitida. Se prueba la máquina de estados aislada del web service.

### Fase 3 — Pedir el CAE de verdad
`FECAESolicitar` para Factura A (tipo 1) y B (tipo 6).

Lo que hay que armar bien:

- **Concepto 3** (productos y servicios), que es lo que hace el taller. Obliga
  a mandar `FchServDesde`, `FchServHasta` y `FchVtoPago`.
- **IVA discriminado** por alícuota. Hoy todo es 21% (id 5), pero la estructura
  tiene que soportar varias.
- **DocTipo/DocNro**: 80 con CUIT para la A; para la B, 96 (DNI) o 99
  (consumidor final sin identificar) según lo que tenga el cliente.
- **`CondicionIVAReceptorId`** (RG 5616), obligatorio. Se deriva del
  `tax_condition` del cliente, que ya tenemos.
- Que los importes cierren al centavo con lo que calculamos: ARCA rechaza si
  `ImpTotal` no es exactamente la suma de sus partes.

### Fase 4 — El comprobante impreso
- **QR obligatorio** (RG 4892): JSON con CUIT, PV, tipo, número, importe y CAE,
  en base64, bajo `https://www.afip.gob.ar/fe/qr/?p=`. Se dibuja en el cliente;
  no requiere servicio.
- CAE y su vencimiento en el pie.
- Que la X **no** lleve QR ni diga CAE: no es fiscal.

### Fase 5 — Nota de crédito electrónica
Reemplazar el `void_invoice()` actual para las facturas con CAE real: emitir
NC A (tipo 3) o NC B (tipo 8), con su numeración, su CAE y el comprobante
asociado. Las facturas de la serie interna siguen anulándose como hoy.

**Esta fase se puede diferir**, pero hasta que exista no hay forma legal de
revertir una factura fiscal. Conviene no pasar mucho tiempo entre la fase 3 y
esta.

### Fase 6 — Reconciliación
Un trabajo periódico (pg_cron, como el de WhatsApp) que busca facturas en
`PENDIENTE_CAE` de más de unos minutos y las resuelve contra
`FECompConsultar`.

---

## 6. Decisión abierta

**¿La app comparte el PV 1 con el sistema actual, o tiene uno propio?**
Ver punto 3. Recomendado: uno propio. Si se comparte, funciona igual, con la
consulta a ARCA antes de cada emisión y reintento automático.

---

## 7. Lo que NO cambia

- La serie interna X sobre el PV 90000 sigue igual: no es fiscal, no va a ARCA,
  no lleva CAE ni QR.
- El circuito de la OT, la cotización y la cobranza no se tocan.
- El cálculo de IVA y totales ya existe y es el mismo.
