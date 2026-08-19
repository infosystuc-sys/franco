# Envío por WhatsApp y facturación electrónica — Diseño

**Fecha:** 19 de agosto de 2026
**Estado:** propuesta, pendiente de aprobación

## Qué se va a construir

Que el cliente reciba por WhatsApp, sin que nadie del taller tenga que copiar
y pegar nada:

1. El **link de seguimiento** al abrirse la orden.
2. Un **aviso en cada cambio de estado** de su reparación.
3. La **cotización** para aprobar, con su link.
4. La **factura electrónica** de ARCA al finalizar.

Los cuatro se envían de forma automática.

---

## Restricciones que definen la arquitectura

Estas no son preferencias: condicionan lo que se puede construir.

**La clave de Evolution API no puede estar en el navegador.** La app es un
sitio estático: todo lo que incluya viaja al equipo del cliente. Si la clave
está ahí, cualquiera puede leerla y mandar WhatsApps haciéndose pasar por el
taller. Lo mismo, y peor, con el certificado de ARCA. Tiene que haber una capa
de servidor en el medio.

**El certificado de ARCA es un secreto de nivel fiscal.** Con él se emiten
comprobantes a nombre del taller. No va al repositorio, no va al navegador, y
conviene que no salga del servidor donde se use.

**Evolution API se cae.** Es un servicio propio corriendo en un servidor: se
reinicia, pierde la sesión de WhatsApp, se queda sin red. Si un aviso se manda
"al pasar" y falla, se pierde en silencio y el cliente nunca se entera. Hace
falta una cola con reintentos, no un disparo directo.

**Los envíos automáticos multiplican los mensajes.** Elegiste automático en
cada cambio. Con cinco estados por orden, cada reparación genera al menos
cinco mensajes. Una corrección de estado mal hecha dispara un mensaje al
cliente que no se puede deshacer. El diseño incluye guardas para eso.

---

## Arquitectura

```
                    ┌──────────────────────────────┐
  Navegador  ─────▶ │  Supabase (Postgres + RLS)   │
  (la app)          │                              │
                    │  trigger: cambia el estado   │
                    │        ↓                     │
                    │  tabla notifications (cola)  │
                    └──────────┬───────────────────┘
                               │ pg_cron cada minuto
                               ▼
                    ┌──────────────────────────────┐
                    │  Edge Function "despachar"   │
                    │  (Supabase, guarda secretos) │
                    └──────────┬───────────────────┘
                               │ HTTPS + apikey
                               ▼
                    ┌──────────────────────────────┐
                    │  Evolution API (tu servidor) │
                    └──────────────────────────────┘
```

**Por qué una cola y no un disparo directo.** El trigger no llama a Evolution:
escribe una fila en `notifications` con estado `pendiente`. Un proceso separado
la toma, intenta enviarla y marca el resultado. Si Evolution está caído, la
fila queda pendiente y se reintenta. Nada se pierde, y queda registro de qué
se mandó, a quién y cuándo.

**Por qué Supabase Edge Functions.** Ya tenés Supabase; no suma
infraestructura. Los secretos viven ahí, fuera del alcance del navegador. Y
`pg_cron` puede invocarlas sin que haya nadie con la app abierta — que es
justamente el caso de un aviso automático.

**ARCA es la excepción.** La firma del certificado X.509 que exige el
servicio de autenticación de ARCA es incómoda de hacer en el entorno de las
Edge Functions. Va en un servicio Node chico, en el mismo servidor donde ya
corre Evolution API. Se detalla en la fase 4.

---

## Modelo de datos

### `notifications` — la cola

| Campo | Para qué |
|---|---|
| `id` | |
| `work_order_id` / `quotation_id` | a qué se refiere |
| `kind` | `link_seguimiento`, `cambio_estado`, `cotizacion`, `factura` |
| `to_phone` | teléfono ya normalizado, congelado al encolar |
| `body` | el texto exacto que se envía |
| `media_url` | el PDF, cuando corresponde |
| `status` | `pendiente`, `enviado`, `fallido`, `descartado` |
| `attempts` | para cortar después de N intentos |
| `last_error` | qué respondió Evolution |
| `dedupe_key` | **único**: impide mandar dos veces lo mismo |
| `created_at` / `sent_at` | |

`dedupe_key` es la pieza que evita el peor error de esta integración: mandar
el mismo aviso repetido. Para un cambio de estado sería
`ot:<id>:estado:EN_REPARACION`. Si alguien corrige el estado y vuelve a
pasarlo, el índice único rechaza el duplicado y el cliente no recibe dos
mensajes iguales.

### Cambios en tablas existentes

**`customers`**
- `phone_e164` — el teléfono normalizado (`5491155550001`). Se calcula al
  guardar; el campo actual queda como está para no romper nada.
- `whatsapp_opt_out` — el cliente que pide no recibir mensajes.

**Datos fiscales del taller** (tabla nueva `company_settings`)
Hoy guardamos la condición de IVA del *cliente*, que define si la factura es A
o B. Pero **no tenemos los datos del taller**: CUIT, razón social, punto de
venta, condición frente al IVA. Sin eso no se puede facturar. Es un faltante
que hay que cubrir antes de la fase 4.

---

## El problema de los teléfonos

Hoy están como texto libre:

```
"+54 9 11 5555-0001"    ← con espacios y guión
""                       ← vacío
```

Evolution API necesita `5491155550001`. Las reglas argentinas tienen trampa:

- El **9** después del 54 marca celular. Sin él, el mensaje no llega.
- El **15** del formato local no va: `11 15 5555-0001` → `5491155550001`.
- Los números de otras provincias tienen característica de 2 a 4 dígitos.

Se resuelve con una función de normalización más validación al guardar el
cliente: si el número no se puede normalizar, se avisa en el formulario en vez
de descubrirlo cuando el mensaje no llega. Los clientes ya cargados hay que
revisarlos: **de los 5 actuales, uno tiene el teléfono vacío**.

---

## Fases

Cada fase deja algo usable. No hace falta esperar al final.

### Fase 1 — Cimientos (sin enviar nada todavía)
- Normalización de teléfonos y validación en el ABM de clientes.
- Tabla `notifications` y su cola.
- Edge Function que envía por Evolution API, con reintentos.
- Pantalla interna para ver la cola: qué se mandó, qué falló y por qué.
- **Modo prueba**: todo se encola pero se envía a un número propio, no al
  cliente. Permite verificar los textos sin molestar a nadie.

### Fase 2 — Cotizaciones
Va antes que los avisos de estado: es el mensaje que mueve la aguja del
negocio, porque de él depende que el trabajo se apruebe.

- Token público en la cotización y portal donde el cliente la ve.
- Envío por WhatsApp al pasar a "Enviada".
- Botones de aceptar y rechazar, con las guardas de la sección anterior.
- Aviso al taller cuando el cliente decide.

### Fase 3 — Link de seguimiento y cambios de estado
- Trigger que encola al crearse la orden y en cada cambio de estado.
- Textos por estado, revisados uno por uno.
- Respeto del `whatsapp_opt_out`.
- Se sale del modo prueba cuando los textos estén aprobados.

### Fase 4 — Factura electrónica de ARCA
Es un módulo grande y con reglas propias. Merece su propio documento de
diseño. A grandes rasgos:
- Datos fiscales del taller (CUIT, punto de venta, condición de IVA).
- Autenticación con certificado (WSAA) y caché del ticket, que dura 12 horas.
- Solicitud del CAE (WSFEv1).
- El tipo de comprobante sale de cruzar la condición del taller con la del
  cliente — que ya guardamos.
- Generación del PDF con el CAE y su código de barras.
- Envío por WhatsApp del PDF.
- Ambiente de homologación primero, producción después.

**Esta fase no debería empezar hasta que las tres anteriores estén andando.**
Un error acá no es un mensaje mal mandado: es un comprobante fiscal mal
emitido.

---

## Riesgos

**El número de WhatsApp puede quedar bloqueado.** Evolution API maneja WhatsApp
Web con un número real, por fuera de lo que WhatsApp permite. Mitigaciones:
usar un número dedicado, no el personal; ritmo de envío limitado; no escribirle
a quien no es cliente. Si el taller depende de ese número para atender, el
bloqueo duele.

**Los envíos automáticos no se pueden deshacer.** Corregir un estado cargado
por error va a mandarle un mensaje al cliente. El `dedupe_key` evita el
duplicado, pero no el primer envío. Vale la pena considerar una demora de unos
minutos antes de despachar, que dé lugar a corregir.

**Evolution API es un servicio que hay que mantener.** Si el servidor se cae o
la sesión se desvincula, los avisos dejan de salir. La pantalla de la cola
sirve para darse cuenta; conviene además un aviso cuando se acumulen fallos.

---

## Decisiones tomadas

1. **Envío inmediato**, sin demora de gracia. Un estado cargado por error le
   llega al cliente. El `dedupe_key` evita el mensaje repetido, no el primero.
2. **El cliente acepta o rechaza la cotización desde el link.** Ver abajo.
3. **Número dedicado** para el sistema, separado del que atiende el taller.
   Si WhatsApp bloquea el número, el taller sigue trabajando.
4. **Los datos fiscales del taller** se cargan antes de la fase 4.

---

## Aceptación de cotizaciones desde el link

Es la parte con más riesgo del plan, porque un desconocido pasa a modificar
datos. El acceso público hasta ahora era de solo lectura.

**Modelo de amenaza.** El link lleva un token aleatorio, igual que el de
seguimiento: no se puede enumerar. Quien lo tiene, es porque el taller se lo
mandó a ese cliente. Es el mismo criterio con el que funciona cualquier link
de aprobación o de firma electrónica.

**Lo que se permite**, y nada más:

- Pasar de `EMITIDA` o `ENVIADA` a `ACEPTADA` o `RECHAZADA`.
- Nada más. No se pueden tocar renglones, precios, ni volver atrás.

**Guardas, todas en la base y no en la interfaz:**

| Guarda | Por qué |
|---|---|
| Solo desde `EMITIDA` o `ENVIADA` | Una cotización ya resuelta no se toca |
| Rechaza si ya tiene OT | Ya se convirtió: es un hecho consumado |
| Rechaza si está vencida | El precio ya no vale |
| Registra fecha y origen de la decisión | Queda constancia de quién aceptó y cuándo |

**Lo que sigue siendo del taller:** aceptar no convierte la cotización en orden
de trabajo. Eso lo sigue haciendo un admin con un botón. El cliente aprueba el
presupuesto; el taller decide cuándo abre la orden y descuenta el stock.

**Si el cliente se equivoca**, el taller puede reabrir la cotización — ya
existe ese botón.
