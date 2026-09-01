# Consulta al padrón de ARCA — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un botón junto al campo de CUIT/DNI en la ficha de cliente o proveedor que trae del padrón de ARCA la razón social, la condición frente al IVA y el domicilio fiscal, completando los campos vacíos y preguntando antes de pisar los que ya tienen algo.

**Architecture:** Una Edge Function (`consultar-padron-arca`) concentra todo el trato con ARCA: firma el pedido de login CMS/PKCS#7, cachea el ticket de 12 horas en una tabla propia, resuelve DNI a CUIT cuando hace falta y consulta el padrón. El navegador solo ve datos ya normalizados; el certificado y el ticket nunca salen del servidor. En el frontend todo entra por `FiscalFields.tsx`, el único componente donde se tipea el CUIT, así que clientes y proveedores lo reciben juntos.

**Tech Stack:** React 19 + TypeScript + Vite, Supabase (Postgres + Edge Functions en Deno), `npm:node-forge` para la firma CMS, SOAP crudo por `fetch` (ARCA no ofrece REST en estos servicios).

**Spec:** [docs/superpowers/specs/2026-09-01-consulta-padron-arca-design.md](../specs/2026-09-01-consulta-padron-arca-design.md)

## Global Constraints

- **Certificado propio del taller.** Nada de servicios de terceros: el certificado y la clave privada viven como secretos de Supabase y solo los usa la Edge Function.
- **Siempre a pedido.** La consulta se dispara únicamente con el botón. Nunca al tipear, ni al salir del campo, ni al abrir la ficha. Vale igual para alta y edición.
- **Completa lo vacío; pregunta antes de pisar.** Un campo con valor distinto al de ARCA no se toca sin decisión explícita del usuario.
- **El formulario sigue siendo usable a mano siempre.** ARCA se cae seguido; ninguna falla puede bloquear la carga manual.
- **`name` (nombre comercial) no se toca nunca.** Es el nombre con el que el taller conoce al cliente, no la razón social.
- **No se persiste nada nuevo del padrón.** Lo que trae ARCA se vuelca en el formulario y se guarda por los caminos de siempre.
- **Sin test runner nuevo.** No hay Vitest ni Jest en este repo y no se agrega: la verificación es `npx tsc --noEmit`, `npm run build` y prueba manual con Playwright.
- **Toda Edge Function sigue el patrón de `supabase/functions/gestionar-empleado/index.ts`:** service key server-side, `verificarAdmin(req)` antes de tocar el body, `CORS_HEADERS` fijos, helper `json(body, status)`.

## Bloqueante externo: el certificado

**La Tarea 1 no puede empezar sin esto, y es trámite del usuario.** Para el entorno de homologación:

1. Entrar a **WSASS** (Autogestión de Acceso a APIs de Homologación) con clave fiscal.
2. Generar un certificado de homologación (pide un CSR; WSASS explica cómo generarlo con `openssl`).
3. Autorizar a ese certificado los servicios `ws_sr_padron_a5` y `ws_sr_padron_a13`.

Para producción, lo mismo desde "Administración de Certificados Digitales" con clave fiscal **nivel 3**.

Sin el paso 3 la conexión falla aunque el certificado sea válido, y el error de ARCA no distingue entre "certificado inválido" y "servicio no autorizado".

---

### Task 1: Spike — probar la firma CMS y capturar la respuesta real

**Files:**
- Create: `scripts/spike-arca-padron.ts` (descartable, se borra al final de la tarea)

**Interfaces:**
- Consumes: certificado y clave de **homologación** provistos por el usuario, en `.env` como `ARCA_CERT_PEM`, `ARCA_KEY_PEM`, `ARCA_CUIT`.
- Produces: (a) veredicto sobre si la firma CMS es viable con `node-forge`; (b) el archivo `spike-arca-respuesta.json` con la respuesta cruda de `ws_sr_padron_a5`, del que sale la tabla de mapeo de condición frente al IVA que usa la Tarea 3; (c) las formas exactas de request y response SOAP verificadas.

Esta tarea existe porque es lo único del plan que puede resultar imposible. Todo lo demás es plomería conocida. Si la firma no se puede hacer, el diseño cambia antes de construir nada alrededor.

- [ ] **Step 1: Instalar node-forge**

```bash
npm install node-forge && npm install --save-dev @types/node-forge
```

- [ ] **Step 2: Escribir el spike**

```typescript
// scripts/spike-arca-padron.ts
//
// Corrida única y descartable. Responde tres preguntas antes de construir nada:
//   1. ¿Se puede firmar el pedido de login (CMS/PKCS#7) con node-forge?
//   2. ¿WSAA de homologación acepta esa firma y devuelve token + sign?
//   3. ¿Qué devuelve exactamente ws_sr_padron_a5 para un CUIT conocido?
//
// Uso: npx tsx scripts/spike-arca-padron.ts <cuit-a-consultar>

import forge from 'node-forge';
import fs from 'node:fs';

const CUIT_PROPIO = process.env.ARCA_CUIT!;
const CERT_PEM = process.env.ARCA_CERT_PEM!;
const KEY_PEM = process.env.ARCA_KEY_PEM!;
const WSAA_URL = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
const PADRON_A5_URL = 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5';

const cuitConsultado = process.argv[2];
if (!CUIT_PROPIO || !CERT_PEM || !KEY_PEM || !cuitConsultado) {
  console.error('Faltan ARCA_CUIT / ARCA_CERT_PEM / ARCA_KEY_PEM en el entorno, o el CUIT a consultar como argumento.');
  process.exit(1);
}

/** El TRA: el XML que se firma para pedirle un ticket a WSAA. */
function armarTra(servicio: string): string {
  const ahora = new Date();
  const desde = new Date(ahora.getTime() - 10 * 60 * 1000); // 10 min de gracia por desfasaje de reloj
  const hasta = new Date(ahora.getTime() + 10 * 60 * 1000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>
    <generationTime>${desde.toISOString()}</generationTime>
    <expirationTime>${hasta.toISOString()}</expirationTime>
  </header>
  <service>${servicio}</service>
</loginTicketRequest>`;
}

/** Firma el TRA como CMS/PKCS#7 y lo devuelve en base64. Es LA pregunta del spike. */
function firmarCms(tra: string): string {
  const cert = forge.pki.certificateFromPem(CERT_PEM);
  const key = forge.pki.privateKeyFromPem(KEY_PEM);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date().toISOString() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

async function pedirTicket(servicio: string): Promise<{ token: string; sign: string; expira: string }> {
  const cms = firmarCms(armarTra(servicio));
  const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetch(WSAA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: sobre,
  });
  const xml = await res.text();
  fs.writeFileSync('spike-arca-wsaa-crudo.xml', xml, 'utf8');
  if (!res.ok) throw new Error(`WSAA respondió ${res.status}. Respuesta cruda en spike-arca-wsaa-crudo.xml`);

  const sacar = (tag: string) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
  const token = sacar('token');
  const sign = sacar('sign');
  const expira = sacar('expirationTime');
  if (!token || !sign) throw new Error(`WSAA no devolvió token/sign. Respuesta cruda en spike-arca-wsaa-crudo.xml`);
  return { token, sign, expira };
}

async function consultarPadron(token: string, sign: string, cuit: string): Promise<string> {
  const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona>
      <token>${token}</token>
      <sign>${sign}</sign>
      <cuitRepresentada>${CUIT_PROPIO}</cuitRepresentada>
      <idPersona>${cuit}</idPersona>
    </a5:getPersona>
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetch(PADRON_A5_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: sobre,
  });
  return await res.text();
}

const ticket = await pedirTicket('ws_sr_padron_a5');
console.log('OK — WSAA aceptó la firma. Ticket vence:', ticket.expira);

const respuesta = await consultarPadron(ticket.token, ticket.sign, cuitConsultado);
fs.writeFileSync('spike-arca-respuesta.xml', respuesta, 'utf8');
console.log('OK — padrón respondió. Respuesta guardada en spike-arca-respuesta.xml');
console.log(respuesta.slice(0, 3000));
```

- [ ] **Step 3: Correrlo**

Run: `npx tsx scripts/spike-arca-padron.ts <un CUIT conocido>`

En homologación, ARCA suele responder solo para CUIT de prueba; si el CUIT real no devuelve datos, probar con el CUIT propio del taller (que sí figura, por ser el titular del certificado).

**Si falla la firma** (`node-forge` lanza, o WSAA responde rechazando el CMS): parar. Anotar el error exacto y avisar antes de seguir — el diseño de la Tarea 3 cambia. Los dos desvíos más probables y su remedio:
- WSAA rechaza SHA-256: cambiar `digestAlgorithm` a `forge.pki.oids.sha1` y reintentar.
- `node-forge` no resuelve la clave: verificar que `ARCA_KEY_PEM` sea la clave privada en PEM sin passphrase.

**Si funciona:** seguir al paso 4.

- [ ] **Step 4: Extraer de la respuesta lo que necesita la Tarea 3**

Del `spike-arca-respuesta.xml` anotar, para pegarlo en el reporte de la tarea:
1. La ruta exacta a `razonSocial` / `nombre` / `apellido`.
2. La forma exacta de `domicilioFiscal`: **si trae una descripción de provincia además del `idProvincia` numérico**, se usa esa y no hace falta tabla de mapeo. Si trae solo el número, la Tarea 3 incluye la tabla, transcripta del manual oficial de `ws_sr_padron_a5`.
3. Los `idImpuesto` presentes y si existe una sección de monotributo — de acá sale la tabla de condición frente al IVA de la Tarea 3.
4. El namespace real que devolvió el servicio (puede diferir del `a5:` usado arriba).

- [ ] **Step 5: Borrar el spike**

```bash
rm scripts/spike-arca-padron.ts spike-arca-wsaa-crudo.xml spike-arca-respuesta.xml
```

Sin commit de código en esta tarea: es un spike, no queda nada. Sí queda commiteado `package.json` con `node-forge`, que usa la Tarea 3:

```bash
git add package.json package-lock.json
git commit -m "Agregar node-forge para la firma CMS de ARCA"
```

---

### Task 2: Migración — tabla del ticket de ARCA

**Files:**
- Create: `supabase/arca-auth-tokens.sql`

**Interfaces:**
- Produces: tabla `arca_auth_tokens` (`service` text PK, `token` text, `sign` text, `expires_at` timestamptz, `updated_at` timestamptz), con RLS habilitada y sin políticas.

- [ ] **Step 1: Escribir la migración**

```sql
-- Ticket de acceso de ARCA (WSAA), cacheado.
--
-- No es una optimización: ARCA rechaza un pedido de login nuevo mientras el
-- anterior siga vigente, así que hay que guardar el ticket y reutilizarlo
-- durante sus 12 horas de vida.
--
-- Ver docs/superpowers/specs/2026-09-01-consulta-padron-arca-design.md

create table arca_auth_tokens (
  service text primary key,
  token text not null,
  sign text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

-- RLS habilitada y SIN políticas: nadie llega a esta tabla desde el navegador.
-- Una tabla sin RLS habilitada queda expuesta por PostgREST a cualquier usuario
-- autenticado, y acá vive un ticket que permite consultar el padrón en nombre
-- del taller. La Edge Function la usa con la service key, que pasa por encima
-- de RLS.
alter table arca_auth_tokens enable row level security;
```

- [ ] **Step 2: Aplicar la migración**

Usar `apply_migration` (proyecto `mnoqdqjhsylohlvuekfh`) con el nombre `arca_auth_tokens`.

- [ ] **Step 3: Verificar que la tabla existe y que nadie la alcanza**

```sql
select column_name, data_type from information_schema.columns
where table_name = 'arca_auth_tokens' order by ordinal_position;

select relrowsecurity from pg_class where relname = 'arca_auth_tokens';

select count(*) as politicas from pg_policies where tablename = 'arca_auth_tokens';
```

Esperado: 5 columnas; `relrowsecurity` en `true`; `politicas` en 0.

- [ ] **Step 4: Commit**

```bash
git add supabase/arca-auth-tokens.sql
git commit -m "ARCA: tabla para cachear el ticket de acceso de WSAA"
```

---

### Task 3: Edge Function `consultar-padron-arca`

**Files:**
- Create: `supabase/functions/consultar-padron-arca/index.ts`

**Interfaces:**
- Consumes: tabla `arca_auth_tokens` (Task 2); secretos `ARCA_CUIT`, `ARCA_CERT_PEM`, `ARCA_KEY_PEM`, `ARCA_ENTORNO`; los hallazgos del spike (Task 1) sobre forma de respuesta y namespaces.
- Produces: endpoint POST que recibe `{ documento: string }` con `Authorization: Bearer <jwt de admin>` y devuelve una de estas tres formas:
  - `{ tipo: 'datos', datos: { cuit, legalName, taxCondition, addressStreet, addressCity, addressState, addressZip } }`
  - `{ tipo: 'varias-cuit', opciones: [{ cuit, descripcion }] }`
  - `{ error: string }` con status 4xx/5xx.

- [ ] **Step 1: Configurar los secretos**

Desde el dashboard de Supabase (Project Settings → Edge Functions → Secrets), o pedírselo al usuario si no hay acceso: `ARCA_CUIT`, `ARCA_CERT_PEM`, `ARCA_KEY_PEM`, `ARCA_ENTORNO` (`homologacion` para empezar).

- [ ] **Step 2: Escribir la función**

Ajustar los namespaces y la extracción de campos a lo que el spike (Task 1) haya capturado de verdad; lo de abajo es la forma esperada, no adivinada, pero el spike manda.

```typescript
// supabase/functions/consultar-padron-arca/index.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import forge from 'npm:node-forge@1.3.1';

/*
  Consulta el padrón de ARCA para autocompletar la ficha de un cliente o
  proveedor. El certificado del taller y el ticket de acceso viven solo acá:
  con ellos se puede consultar el padrón en nombre del taller, así que no
  salen del servidor.

  Mismo patrón de autorización que gestionar-empleado.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ARCA_CUIT = Deno.env.get('ARCA_CUIT')!;
const ARCA_CERT_PEM = Deno.env.get('ARCA_CERT_PEM')!;
const ARCA_KEY_PEM = Deno.env.get('ARCA_KEY_PEM')!;
const ES_PRODUCCION = Deno.env.get('ARCA_ENTORNO') === 'produccion';

const WSAA_URL = ES_PRODUCCION
  ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
  : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
const PADRON_BASE = ES_PRODUCCION
  ? 'https://aws.afip.gov.ar/sr-padron/webservices'
  : 'https://awshomo.afip.gov.ar/sr-padron/webservices';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

type Autorizacion = { estado: 'admin'; userId: string } | { estado: 'sin-sesion' | 'sin-permiso' };

async function verificarAdmin(req: Request): Promise<Autorizacion> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!token) return { estado: 'sin-sesion' };

  const { data: { user }, error: errorUsuario } = await db.auth.getUser(token);
  if (errorUsuario || !user) return { estado: 'sin-sesion' };

  const { data: perfil, error: errorPerfil } = await db
    .from('profiles').select('role').eq('id', user.id).single();

  if (errorPerfil || !perfil) return { estado: 'sin-sesion' };
  return perfil.role === 'admin' ? { estado: 'admin', userId: user.id } : { estado: 'sin-permiso' };
}

// ── WSAA ───────────────────────────────────────────────────────────────────

function armarTra(servicio: string): string {
  const ahora = new Date();
  const desde = new Date(ahora.getTime() - 10 * 60 * 1000);
  const hasta = new Date(ahora.getTime() + 10 * 60 * 1000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>
    <generationTime>${desde.toISOString()}</generationTime>
    <expirationTime>${hasta.toISOString()}</expirationTime>
  </header>
  <service>${servicio}</service>
</loginTicketRequest>`;
}

function firmarCms(tra: string): string {
  const cert = forge.pki.certificateFromPem(ARCA_CERT_PEM);
  const key = forge.pki.privateKeyFromPem(ARCA_KEY_PEM);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date().toISOString() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

function sacarTag(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? '';
}

/** Devuelve un ticket vigente: el cacheado si sirve, uno nuevo si no. */
async function obtenerTicket(servicio: string): Promise<{ token: string; sign: string }> {
  const { data: guardado } = await db
    .from('arca_auth_tokens').select('token, sign, expires_at').eq('service', servicio).maybeSingle();

  // Margen de 5 minutos: un ticket que vence mientras viaja el pedido no sirve.
  if (guardado && new Date(guardado.expires_at).getTime() > Date.now() + 5 * 60 * 1000) {
    return { token: guardado.token, sign: guardado.sign };
  }

  const cms = firmarCms(armarTra(servicio));
  const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetch(WSAA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: sobre,
  });
  const xml = await res.text();
  const token = sacarTag(xml, 'token');
  const sign = sacarTag(xml, 'sign');
  if (!token || !sign) {
    // El fault de ARCA no distingue "certificado inválido" de "servicio no
    // autorizado", así que el mensaje nombra las dos posibilidades.
    throw new Error(
      'ARCA no aceptó el certificado. Verificá que esté vigente y que tenga ' +
      `autorizado el servicio ${servicio} en el Administrador de Certificados Digitales.`
    );
  }

  const expira = sacarTag(xml, 'expirationTime');
  await db.from('arca_auth_tokens').upsert({
    service: servicio, token, sign, expires_at: expira, updated_at: new Date().toISOString(),
  });

  return { token, sign };
}

// ── Padrón ─────────────────────────────────────────────────────────────────

async function soapPadron(servicio: 'personaServiceA5' | 'personaServiceA13', cuerpo: string): Promise<string> {
  const res = await fetch(`${PADRON_BASE}/${servicio}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:svc="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>${cuerpo}</soapenv:Body>
</soapenv:Envelope>`,
  });
  return await res.text();
}

/** DNI a CUIT. Puede devolver varias: un DNI puede tener CUIL y CUIT. */
async function cuitsDeDocumento(documento: string): Promise<string[]> {
  const { token, sign } = await obtenerTicket('ws_sr_padron_a13');
  const xml = await soapPadron('personaServiceA13', `<svc:getIdPersonaListByDocumento>
      <token>${token}</token><sign>${sign}</sign>
      <cuitRepresentada>${ARCA_CUIT}</cuitRepresentada>
      <documento>${documento}</documento>
    </svc:getIdPersonaListByDocumento>`);
  return [...xml.matchAll(/<idPersona>(\d+)<\/idPersona>/g)].map((m) => m[1]);
}

/**
 * ARCA no devuelve la condición frente al IVA: devuelve los impuestos en los
 * que el contribuyente está inscripto, y de ahí se deduce.
 *
 * Los ids de abajo son el punto de partida; el spike de la Task 1 confirma
 * cuáles aparecen de verdad. Es el dato que más caro sale equivocado: una
 * condición mal deducida cambia qué letra de comprobante corresponde emitir,
 * así que ante la duda se devuelve CONSUMIDOR_FINAL, que es lo que el usuario
 * más probablemente corrija a ojo.
 */
function deducirCondicion(xml: string): string {
  if (/<datosMonotributo>/.test(xml)) return 'MONOTRIBUTO';
  const impuestos = [...xml.matchAll(/<idImpuesto>(\d+)<\/idImpuesto>/g)].map((m) => Number(m[1]));
  if (impuestos.includes(30)) return 'RESPONSABLE_INSCRIPTO';
  if (impuestos.includes(32) || impuestos.includes(34)) return 'EXENTO';
  return 'CONSUMIDOR_FINAL';
}

async function datosDeCuit(cuit: string) {
  const { token, sign } = await obtenerTicket('ws_sr_padron_a5');
  const xml = await soapPadron('personaServiceA5', `<svc:getPersona>
      <token>${token}</token><sign>${sign}</sign>
      <cuitRepresentada>${ARCA_CUIT}</cuitRepresentada>
      <idPersona>${cuit}</idPersona>
    </svc:getPersona>`);

  if (/No existe persona con ese id|persona no encontrada/i.test(xml)) return null;

  const razonSocial = sacarTag(xml, 'razonSocial');
  const apellido = sacarTag(xml, 'apellido');
  const nombre = sacarTag(xml, 'nombre');

  return {
    cuit,
    legalName: razonSocial || [apellido, nombre].filter(Boolean).join(', '),
    taxCondition: deducirCondicion(xml),
    addressStreet: sacarTag(xml, 'direccion'),
    addressCity: sacarTag(xml, 'localidad'),
    // Si el servicio devuelve la descripción, se usa; si solo trae el id
    // numérico, se deja vacío antes que inventar una provincia equivocada.
    addressState: sacarTag(xml, 'descripcionProvincia'),
    addressZip: sacarTag(xml, 'codPostal'),
  };
}

// ── Endpoint ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  const autorizacion = await verificarAdmin(req);
  if (autorizacion.estado === 'sin-sesion') return json({ error: 'No autorizado.' }, 401);
  if (autorizacion.estado === 'sin-permiso') return json({ error: 'No autorizado.' }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Cuerpo inválido: se esperaba JSON.' }, 400);
  }

  const documento = String(body.documento ?? '').replace(/\D/g, '');
  if (documento.length !== 11 && documento.length !== 8 && documento.length !== 7) {
    return json({ error: 'El documento tiene que ser un DNI de 7 u 8 dígitos, o un CUIT de 11.' }, 400);
  }

  try {
    let cuit = documento;

    if (documento.length < 11) {
      const cuits = await cuitsDeDocumento(documento);
      if (cuits.length === 0) return json({ error: 'Ese DNI no tiene CUIT en el padrón de ARCA.' }, 404);
      if (cuits.length > 1) {
        const opciones = [];
        for (const candidato of cuits) {
          const datos = await datosDeCuit(candidato);
          opciones.push({ cuit: candidato, descripcion: datos?.legalName ?? 'Sin datos en el padrón' });
        }
        return json({ tipo: 'varias-cuit', opciones });
      }
      cuit = cuits[0];
    }

    const datos = await datosDeCuit(cuit);
    if (!datos) return json({ error: 'ARCA no tiene datos para ese CUIT.' }, 404);
    return json({ tipo: 'datos', datos });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    // El mensaje del certificado ya viene explicado desde obtenerTicket; el
    // resto casi siempre es ARCA caído, que se cae seguido.
    return json({
      error: mensaje.includes('certificado')
        ? mensaje
        : 'ARCA no está respondiendo. Cargá los datos a mano y probá más tarde.',
    }, 502);
  }
});
```

- [ ] **Step 3: Desplegar**

Usar `deploy_edge_function` (proyecto `mnoqdqjhsylohlvuekfh`, `verify_jwt: true`).

- [ ] **Step 4: Probar contra homologación**

Con el dev server corriendo (`npm run dev`, `localhost:4000`) y sesión de admin abierta, desde la consola del navegador. Vite sirve los módulos del proyecto, así que se puede importar el cliente real de la app:

```js
const { supabase } = await import('/src/lib/supabase.ts');
const { data, error } = await supabase.functions.invoke('consultar-padron-arca', {
  body: { documento: '<CUIT propio del taller>' },
});
console.log(data, error);
```

Esperado: `{ tipo: 'datos', datos: { ... } }` con la razón social del taller. Verificar además que la segunda llamada **no** vuelva a pedir ticket:

```sql
select service, expires_at, updated_at from arca_auth_tokens;
```

`updated_at` tiene que quedar igual entre la primera y la segunda consulta.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/consultar-padron-arca/
git commit -m "Edge Function: consultar el padrón de ARCA por CUIT o DNI"
```

---

### Task 4: `src/lib/arcaPadron.ts`

**Files:**
- Create: `src/lib/arcaPadron.ts`

**Interfaces:**
- Consumes: Edge Function `consultar-padron-arca` (Task 3).
- Produces:
  - `interface DatosPadron { cuit: string; legalName: string; taxCondition: TaxCondition; addressStreet: string; addressCity: string; addressState: string; addressZip: string }`
  - `interface OpcionCuit { cuit: string; descripcion: string }`
  - `type ResultadoPadron = { tipo: 'datos'; datos: DatosPadron } | { tipo: 'varias-cuit'; opciones: OpcionCuit[] }`
  - `interface CampoEnConflicto { campo: keyof FiscalEntityInput; etiqueta: string; valorActual: string; valorArca: string }`
  - `consultarPadron(documento: string): Promise<ResultadoPadron>`
  - `compararConFormulario(datos: DatosPadron, form: FiscalEntityInput): { aCompletar: Partial<FiscalEntityInput>; enConflicto: CampoEnConflicto[] }`
  - `documentoConsultable(taxId: string): boolean`

- [ ] **Step 1: Escribir el archivo**

```typescript
import { supabase } from '@/src/lib/supabase';
import { isValidCuit, type FiscalEntityInput, type TaxCondition } from '@/src/lib/fiscal';

/**
 * Consulta al padrón de ARCA para autocompletar la ficha de un cliente o
 * proveedor. Siempre a pedido: la dispara el botón, nunca el tipeo.
 *
 * El certificado y el ticket de acceso viven en la Edge Function; desde acá
 * solo se ven datos ya normalizados.
 */

export interface DatosPadron {
  cuit: string;
  legalName: string;
  taxCondition: TaxCondition;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
}

export interface OpcionCuit {
  cuit: string;
  descripcion: string;
}

export type ResultadoPadron =
  | { tipo: 'datos'; datos: DatosPadron }
  | { tipo: 'varias-cuit'; opciones: OpcionCuit[] };

export interface CampoEnConflicto {
  campo: keyof FiscalEntityInput;
  etiqueta: string;
  valorActual: string;
  valorArca: string;
}

/** Un DNI de 7 u 8 dígitos, o un CUIT de 11 con dígito verificador válido. */
export function documentoConsultable(taxId: string): boolean {
  const digitos = taxId.replace(/\D/g, '');
  if (digitos.length === 7 || digitos.length === 8) return true;
  if (digitos.length === 11) return isValidCuit(digitos);
  return false;
}

async function describeFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error) return String(body.error);
    } catch {
      // El cuerpo no era JSON: se sigue con el mensaje genérico de abajo.
    }
  }
  return error instanceof Error ? error.message : 'No se pudo consultar el padrón de ARCA.';
}

export async function consultarPadron(documento: string): Promise<ResultadoPadron> {
  const { data, error } = await supabase.functions.invoke('consultar-padron-arca', {
    body: { documento: documento.replace(/\D/g, '') },
  });
  if (error) throw new Error(await describeFunctionError(error));
  if (!data?.tipo) throw new Error('ARCA respondió algo inesperado.');
  return data as ResultadoPadron;
}

/** Los campos que ARCA puede completar, con el nombre que ve el usuario. */
const CAMPOS: { campo: keyof DatosPadron & keyof FiscalEntityInput; etiqueta: string }[] = [
  { campo: 'legalName', etiqueta: 'Razón social' },
  { campo: 'taxCondition', etiqueta: 'Condición frente al IVA' },
  { campo: 'addressStreet', etiqueta: 'Domicilio' },
  { campo: 'addressCity', etiqueta: 'Localidad' },
  { campo: 'addressState', etiqueta: 'Provincia' },
  { campo: 'addressZip', etiqueta: 'Código postal' },
];

/**
 * Separa lo que se puede completar solo de lo que hay que preguntar.
 *
 * `name` (nombre comercial) queda afuera a propósito: es el nombre con el que
 * el taller conoce al cliente, no la razón social, y pisarlo sería molesto.
 * El CUIT tampoco entra: es lo que el usuario acaba de tipear para consultar.
 */
export function compararConFormulario(
  datos: DatosPadron,
  form: FiscalEntityInput
): { aCompletar: Partial<FiscalEntityInput>; enConflicto: CampoEnConflicto[] } {
  const aCompletar: Partial<FiscalEntityInput> = {};
  const enConflicto: CampoEnConflicto[] = [];

  for (const { campo, etiqueta } of CAMPOS) {
    const valorArca = String(datos[campo] ?? '').trim();
    const valorActual = String(form[campo] ?? '').trim();
    if (!valorArca) continue;
    if (valorArca === valorActual) continue;

    if (valorActual === '') {
      (aCompletar as Record<string, unknown>)[campo] = valorArca;
    } else {
      enConflicto.push({ campo, etiqueta, valorActual, valorArca });
    }
  }

  return { aCompletar, enConflicto };
}
```

- [ ] **Step 2: Verificar**

Run: `npx tsc --noEmit`
Expected: sin errores.

Nota sobre `taxCondition`: viene como string desde la función y se tipa como `TaxCondition`. Si `tsc` se queja del ensanchamiento, agregar en `consultarPadron` una validación que caiga a `'CONSUMIDOR_FINAL'` cuando el valor no sea uno de los cuatro de `TAX_CONDITIONS` — nunca dejar pasar una condición que el formulario no sepa mostrar.

- [ ] **Step 3: Commit**

```bash
git add src/lib/arcaPadron.ts
git commit -m "ARCA: lib de consulta al padrón y comparación con el formulario"
```

---

### Task 5: El botón en `FiscalFields.tsx`

**Files:**
- Modify: `src/components/FiscalFields.tsx`

**Interfaces:**
- Consumes: `consultarPadron`, `compararConFormulario`, `documentoConsultable`, tipos `DatosPadron`/`OpcionCuit`/`CampoEnConflicto` (Task 4).
- Produces: nada que consuma otra tarea. `FiscalFields` mantiene su firma actual (`{ form, patch, nameLabel, namePlaceholder, legalNamePlaceholder, activeLabel }`), así que `CustomerModal` y `SupplierModal` no se tocan.

- [ ] **Step 1: Agregar el estado y el handler**

Al principio del componente, junto a `const cuitInvalid = ...`:

```typescript
  const [buscando, setBuscando] = React.useState(false);
  const [errorArca, setErrorArca] = React.useState<string | null>(null);
  const [conflictos, setConflictos] = React.useState<CampoEnConflicto[]>([]);
  const [opcionesCuit, setOpcionesCuit] = React.useState<OpcionCuit[] | null>(null);

  const puedeConsultar = documentoConsultable(form.taxId) && !buscando;

  async function traerDeArca(documento: string) {
    setBuscando(true);
    setErrorArca(null);
    setOpcionesCuit(null);
    setConflictos([]);
    try {
      const resultado = await consultarPadron(documento);
      if (resultado.tipo === 'varias-cuit') {
        setOpcionesCuit(resultado.opciones);
        return;
      }
      const { aCompletar, enConflicto } = compararConFormulario(resultado.datos, form);
      // El CUIT resuelto se aplica siempre: si se consultó por DNI, es el dato
      // que el usuario vino a buscar.
      patch({ ...aCompletar, taxId: resultado.datos.cuit });
      setConflictos(enConflicto);
    } catch (err) {
      setErrorArca(err instanceof Error ? err.message : 'No se pudo consultar el padrón.');
    } finally {
      setBuscando(false);
    }
  }
```

Y los imports arriba del archivo:

```typescript
import {
  compararConFormulario,
  consultarPadron,
  documentoConsultable,
  type CampoEnConflicto,
  type OpcionCuit,
} from '@/src/lib/arcaPadron';
```

- [ ] **Step 2: Agregar el botón junto al campo de CUIT**

Reemplazar el `<label>` del CUIT (el que hoy tiene `CUIT / CUIL` y el input con `form.taxId`) por:

```tsx
          <label className={labelClass}>
            CUIT / CUIL / DNI
            <div className="mt-1 flex gap-2">
              <input
                value={form.taxId}
                onChange={(e) => patch({ taxId: e.target.value })}
                className={cn(inputClass, 'mt-0 font-mono', cuitInvalid && 'border-danger bg-danger-soft')}
                placeholder="30-71044366-8"
              />
              <button
                type="button"
                onClick={() => traerDeArca(form.taxId)}
                disabled={!puedeConsultar}
                title="Traer los datos del padrón de ARCA"
                className="shrink-0 rounded-md border border-line bg-panel px-3 text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:border-accent-deep disabled:opacity-40"
              >
                {buscando ? 'Buscando…' : 'Traer de ARCA'}
              </button>
            </div>
            {cuitInvalid && (
              <span className="block mt-1 text-[10px] font-normal normal-case text-danger">
                CUIT/CUIL inválido (dígito verificador incorrecto).
              </span>
            )}
            {errorArca && (
              <span className="block mt-1 text-[10px] font-normal normal-case text-danger">{errorArca}</span>
            )}
          </label>
```

- [ ] **Step 3: Agregar el panel de conflictos y el selector de CUIT**

Dentro del bloque de datos fiscales, después del `</div>` que cierra la grilla de dos columnas donde viven el CUIT y la condición frente al IVA — es decir, entre esa grilla y el cierre de esa sección:

```tsx
      {opcionesCuit && (
        <div className="border border-line bg-panel-alt p-3">
          <p className="text-xs font-semibold text-text">
            Ese DNI tiene más de una CUIT en el padrón. ¿Cuál corresponde?
          </p>
          <ul className="mt-2 space-y-1">
            {opcionesCuit.map((opcion) => (
              <li key={opcion.cuit}>
                <button
                  type="button"
                  onClick={() => traerDeArca(opcion.cuit)}
                  className="w-full text-left text-xs hover:text-accent-deep"
                >
                  <span className="font-mono">{opcion.cuit}</span>
                  <span className="ml-2 text-text-soft">{opcion.descripcion}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {conflictos.length > 0 && (
        <div className="border border-state-wait/40 bg-state-wait/10 p-3">
          <p className="text-xs font-semibold text-text">
            ARCA trae otros valores para estos campos. Lo que ya tenías cargado no se tocó.
          </p>
          <ul className="mt-2 space-y-2">
            {conflictos.map((conflicto) => (
              <li key={conflicto.campo} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0">
                  <span className="block font-semibold text-text">{conflicto.etiqueta}</span>
                  <span className="block text-text-soft">
                    Tenés: {conflicto.valorActual} · ARCA: {conflicto.valorArca}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    patch({ [conflicto.campo]: conflicto.valorArca } as Partial<FiscalEntityInput>);
                    setConflictos((actuales) => actuales.filter((c) => c.campo !== conflicto.campo));
                  }}
                  className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
                >
                  Usar el de ARCA
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              const todos = Object.fromEntries(conflictos.map((c) => [c.campo, c.valorArca]));
              patch(todos as Partial<FiscalEntityInput>);
              setConflictos([]);
            }}
            className="mt-2 text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
          >
            Usar todos los de ARCA
          </button>
        </div>
      )}
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit && npm run build`
Expected: los dos limpios (los warnings preexistentes de chunk-size e `import.meta` en `server.cjs` son normales).

- [ ] **Step 5: Commit**

```bash
git add src/components/FiscalFields.tsx
git commit -m "ARCA: botón para traer los datos del padrón en clientes y proveedores"
```

---

### Task 6: Prueba end-to-end con datos reales

**Files:** ninguno (verificación manual).

- [ ] **Step 1: Caso principal — CUIT que existe, ficha vacía**

Con Playwright en `localhost:4000`: abrir Clientes → Nuevo cliente, escribir el CUIT del propio taller (que figura en el padrón por ser el titular del certificado), tocar "Traer de ARCA".

Verificar: se completan razón social, condición frente al IVA y domicilio; `name` (nombre comercial) **no** se toca; no aparece el panel de conflictos.

- [ ] **Step 2: Caso de conflicto — campo ya cargado y distinto**

En la misma ficha, cambiar a mano la razón social por otra cosa y volver a tocar "Traer de ARCA".

Verificar: la razón social **no** se pisa; aparece el panel amarillo con "Tenés / ARCA"; al tocar "Usar el de ARCA" se aplica y esa fila desaparece.

- [ ] **Step 3: Caso de error — CUIT inexistente**

Escribir un CUIT con dígito verificador válido pero inexistente (por ejemplo `20-00000000-0` si valida; si no, cualquiera que ARCA no reconozca) y consultar.

Verificar: mensaje "ARCA no tiene datos para ese CUIT", el formulario sigue editable, no se borra nada de lo tipeado.

- [ ] **Step 4: Caso DNI**

Consultar por un DNI de 8 dígitos conocido. Verificar que resuelve a CUIT y completa, o que muestra el selector si devuelve varias.

- [ ] **Step 5: Verificar que el ticket se reutiliza**

```sql
select service, expires_at, updated_at from arca_auth_tokens;
```

Después de varias consultas seguidas, `updated_at` tiene que seguir siendo el de la primera: si sube en cada consulta, el cacheo no está funcionando y ARCA va a terminar bloqueando por exceso de logins.

- [ ] **Step 6: Limpiar**

Borrar el cliente de prueba si se llegó a guardar. Si solo se abrió el modal sin guardar, no queda nada.

- [ ] **Step 7: Reportar al usuario**

Confirmar qué casos se probaron en vivo y cuáles no (por ejemplo, si en homologación no había un DNI de prueba con varias CUIT, decirlo en vez de darlo por probado).
