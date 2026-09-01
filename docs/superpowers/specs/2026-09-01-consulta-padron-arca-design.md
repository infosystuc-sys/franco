# Consulta al padrón de ARCA — Diseño

**Fecha:** 1 de septiembre de 2026
**Estado:** en revisión

## Qué se va a construir

Al cargar un cliente o un proveedor, se escribe el CUIT (o el DNI) y un botón
trae los datos del padrón de ARCA para completar el formulario: razón social,
condición frente al IVA y domicilio fiscal. Siempre a pedido: nunca sale a
consultar por su cuenta. Es un solo punto de inserción —
[`FiscalFields.tsx`](../../../src/components/FiscalFields.tsx), el componente
donde hoy se tipea el CUIT — así que clientes y proveedores lo reciben juntos.

**Este trabajo es además el primer escalón de la conexión fiscal que el sistema
todavía no tiene.** Hoy la facturación es interna: `supabase/invoicing.sql`
arranca con "módulo de facturación (sin ARCA)" y los comprobantes se imprimen
con "pendiente de autorización de ARCA". El certificado digital y la
autenticación WSAA que se construyen acá son exactamente los que va a necesitar
la facturación electrónica cuando se encare.

---

## Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Vía de conexión | **Certificado propio del taller** | Sin costo recurrente, sin que los CUIT de los clientes pasen por un tercero, y deja armada la base para facturación electrónica. |
| Estado del certificado | **Hay que tramitarlo** | No existe ninguno todavía. Es trámite del usuario con su clave fiscal; el plan lo detalla pero no puede hacerlo por él. |
| Autocompletado | **Completa lo vacío; pregunta antes de pisar** | Nunca borra en silencio algo que la persona escribió a propósito. |
| Arquitectura | **Una Edge Function, con el ticket de ARCA cacheado en la base** | ARCA rechaza pedidos de login repetidos mientras haya un ticket vigente, así que cachear no es optimización: es requisito. Se auto-repara sola cuando el ticket vence, sin cron. |

---

## Cómo funciona ARCA (lo que condiciona todo el diseño)

No hay API abierta. Cada consulta al padrón necesita un **ticket de acceso**
(token + sign) emitido por WSAA, y para pedirlo hay que firmar un XML con un
**certificado X.509** que el taller tramita en ARCA y al que le autoriza el
servicio puntual.

- El ticket dura **12 horas**. ARCA rechaza un login nuevo mientras el anterior
  siga vigente, así que hay que guardarlo y reutilizarlo.
- Hay dos entornos con certificados distintos: **homologación** (para
  desarrollar) y **producción**.
- Servicios que se usan:
  - `ws_sr_padron_a5` — datos del contribuyente a partir de su CUIT.
  - `ws_sr_padron_a13` — resuelve **DNI a CUIT** (método
    `getIdPersonaListByDocumento`). Puede devolver **varias** CUIT para un mismo
    DNI (por ejemplo, CUIL de empleado y CUIT de monotributista).

---

## Modelo de datos

### Tabla nueva: `arca_auth_tokens`

Una fila por servicio de ARCA. Guarda el ticket vigente para no pedir uno nuevo
en cada consulta.

| Columna | Tipo | Notas |
|---|---|---|
| `service` | text, PK | `ws_sr_padron_a5`, `ws_sr_padron_a13`. |
| `token` | text | El token que devuelve WSAA. |
| `sign` | text | La firma que devuelve WSAA. |
| `expires_at` | timestamptz | Vencimiento que informa el propio ticket. |
| `updated_at` | timestamptz | |

RLS **habilitada y sin ninguna política**, para que nadie la alcance desde el
navegador — ojo que una tabla sin RLS habilitada queda expuesta por PostgREST a
cualquier usuario autenticado. La lee y escribe solo la Edge Function, que con
la service key pasa por encima de RLS. Un token de ARCA en manos del navegador
permitiría consultar el padrón en nombre del taller, así que no sale del
servidor.

### Secretos (Supabase, no en el repo)

- `ARCA_CUIT` — el CUIT del taller, que es quien consulta.
- `ARCA_CERT_PEM` — el certificado.
- `ARCA_KEY_PEM` — la clave privada.
- `ARCA_ENTORNO` — `homologacion` o `produccion`.

### Sin cambios en `customers`, `suppliers` ni `company_settings`

Lo que trae ARCA se vuelca en el formulario que ya existe y se guarda por los
caminos de siempre. No se persiste nada nuevo del padrón: si mañana el
contribuyente cambia de domicilio, lo que vale es lo que el usuario decidió
guardar, no una copia sin dueño.

---

## Backend: Edge Function `consultar-padron-arca`

Sigue el patrón exacto de `supabase/functions/gestionar-empleado/index.ts`:
service key server-side, `verificarAdmin(req)` antes de tocar el body,
`CORS_HEADERS` fijos, helper `json(body, status)`.

Recibe `{ documento }` (7 u 8 dígitos si es DNI, 11 si es CUIT) y hace:

1. **Valida rol admin.** El certificado del taller no se presta a cualquiera con
   sesión.
2. **Resuelve el CUIT.** Si vienen 11 dígitos, ese es. Si vienen 7 u 8, consulta
   `ws_sr_padron_a13` para traducir DNI a CUIT; si devuelve más de uno, corta acá
   y responde la lista para que el usuario elija.
3. **Consigue el ticket.** Lee `arca_auth_tokens`; si está vencido o no existe,
   firma un pedido de login (CMS/PKCS#7) contra WSAA, guarda el ticket nuevo y
   sigue.
4. **Consulta `ws_sr_padron_a5`** con el CUIT.
5. **Normaliza la respuesta** a la forma que entiende el formulario y la
   devuelve.

### Normalización de la respuesta

ARCA no devuelve la condición frente al IVA como tal: devuelve los impuestos en
los que el contribuyente está inscripto, y de ahí se deduce. El criterio de
partida es: impuesto 30 corresponde a Responsable Inscripto; la presencia de
datos de monotributo corresponde a Monotributo; el impuesto 34 (IVA no
alcanzado) o exento corresponde a Exento; sin nada de eso, Consumidor Final.

**La tabla definitiva de este mapeo se fija con la respuesta real del spike**
(ver más abajo), no con estos números tomados de documentación de terceros. Es
el dato que más caro sale equivocado: una condición mal deducida cambia qué
letra de comprobante corresponde emitir.

El resto del mapeo es directo:

| Campo del formulario | De dónde sale |
|---|---|
| `legalName` | `razonSocial` (jurídica) o apellido y nombre (física) |
| `taxId` | El CUIT resuelto |
| `taxCondition` | Deducido de los impuestos, según arriba |
| `addressStreet` | `domicilioFiscal.direccion` |
| `addressCity` | `domicilioFiscal.localidad` |
| `addressState` | `domicilioFiscal.idProvincia`, traducido a nombre |
| `addressZip` | `domicilioFiscal.codPostal` |

`name` (nombre comercial) **no** se toca: es el nombre con el que el taller
conoce al cliente, y rara vez coincide con la razón social.

---

## Frontend: dentro del formulario que ya existe

Todo ocurre en `FiscalFields.tsx`, que hoy ya tiene el input de CUIT y la
validación de dígito verificador.

- **Siempre a pedido.** Un botón "Traer de ARCA" al lado del campo del
  documento. Nunca consulta sola: ni al tipear, ni al salir del campo, ni al
  abrir la ficha. Vale igual para el alta y para la edición.
- El botón queda deshabilitado mientras el documento no tenga una longitud
  válida (7 u 8 dígitos, o 11 con dígito verificador correcto), así no se
  gastan consultas en un CUIT a medio escribir.
- **Campos vacíos:** se completan directo.
- **Campos con algo distinto:** no se tocan. Aparece un panel chico con una fila
  por campo en conflicto — qué tenés contra qué dice ARCA — y se aplica lo que se
  elija, campo por campo o todo junto.
- **DNI con varias CUIT:** se muestran las opciones con su razón social para
  elegir, en vez de adivinar.

El formulario sigue siendo enteramente usable a mano. ARCA se cae seguido: si no
responde, se avisa y se sigue tipeando.

---

## Manejo de errores

Cada falla tiene que decir qué hacer, no solo que algo salió mal:

| Qué pasó | Qué se muestra |
|---|---|
| Certificado vencido o sin el servicio autorizado | "El certificado de ARCA no está habilitado para consultar el padrón" y qué trámite hacer |
| El CUIT no existe en el padrón | "ARCA no tiene datos para ese CUIT" |
| ARCA no responde | "ARCA no está respondiendo. Cargá los datos a mano y probá más tarde." |
| DNI sin CUIT asociada | "Ese DNI no tiene CUIT en el padrón" |

Ninguna bloquea la carga manual.

---

## No entra en esta versión

- **Facturación electrónica.** Se construye la base de autenticación, no la
  emisión de comprobantes.
- **Refrescar padrones en lote.** Nada de recorrer los clientes existentes
  actualizándolos contra ARCA.
- **Guardar la constancia en PDF.**
- **Consultar por razón social.** ARCA no ofrece búsqueda por nombre en estos
  servicios.

---

## Riesgo principal y cómo se saca de encima primero

Lo único que puede no funcionar es la **firma CMS/PKCS#7 del pedido de login
dentro de una Edge Function de Deno**. Todo lo demás es plomería conocida.

Por eso la primera tarea del plan es un spike de una sola corrida: firmar y
obtener un ticket contra **homologación**, y guardar la respuesta cruda de
`ws_sr_padron_a5` para un CUIT conocido. Ese spike resuelve dos cosas a la vez:
prueba que la firma es posible en Deno, y da la respuesta real con la que se fija
la tabla de mapeo de condición frente al IVA.

Si la firma no se puede hacer en Deno, el diseño cambia antes de construir nada
alrededor.

---

## Lo que tiene que hacer el usuario antes de que esto sirva

Es trámite propio, con la clave fiscal del taller. No lo puede hacer el sistema:

1. Tener clave fiscal **nivel 3**.
2. Generar el certificado digital en ARCA (para homologación primero, y después
   para producción).
3. Autorizar a ese certificado los servicios `ws_sr_padron_a5` y
   `ws_sr_padron_a13`.
4. Pasar el certificado y la clave privada para cargarlos como secretos.

Sin el paso 3 la conexión falla aunque el certificado sea válido, y el error de
ARCA no dice cuál de los dos falta — por eso el mensaje de error de arriba lo
explica.

---

## Pruebas

Sin test runner nuevo: se sigue la convención del proyecto (`npx tsc --noEmit`,
`npm run build`, y prueba manual con Playwright contra datos reales).

- El spike prueba la firma y la consulta contra homologación.
- La prueba de punta a punta se hace con un CUIT real conocido — el del propio
  taller y el de un proveedor ya cargado — verificando que los datos que trae
  coinciden con la constancia de inscripción pública.
- Se prueban los dos caminos del autocompletado: campos vacíos (completa) y
  campos con datos distintos (pregunta).
