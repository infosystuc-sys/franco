import { createClient } from 'jsr:@supabase/supabase-js@2';
import forge from 'npm:node-forge@1.3.1';
import { XMLParser } from 'npm:fast-xml-parser@4.5.0';

/*
  Lo común a todo lo que habla con ARCA: el certificado, el permiso de acceso
  (WSAA) y el ida y vuelta SOAP.

  Sale de consultar-padron, que lo tenía adentro. La facturación necesita
  exactamente lo mismo y copiarlo dejaría dos versiones de un código que firma
  con una clave privada: un arreglo en una no llegaría a la otra. Por ahora
  solo lo usa facturacion-arca; consultar-padron sigue con su copia hasta que
  se lo pase acá en un cambio aparte, para no tocar algo que anda en el mismo
  movimiento que se agrega algo nuevo.

  ── El ticket de acceso ─────────────────────────────────────────────────────
  WSAA devuelve un token y una firma que valen 12 HORAS, para UN servicio. Se
  guardan en arca_tickets y se reusan hasta que vencen. No es optimización: si
  se pide uno nuevo teniendo uno vigente, ARCA responde "ya posee un TA valido"
  y, si se insiste, bloquea por exceso de tráfico.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

const WSAA_URL = 'https://wsaa.afip.gob.ar/ws/services/LoginCms';

/**
 * Cuánto se espera a ARCA antes de rendirse. ARCA a veces no contesta nunca en
 * vez de contestar con un error; sin un límite, la pantalla quedaría esperando
 * hasta que la plataforma mate la función, sin decir por qué.
 */
const ESPERA_MAXIMA_MS = 25_000;

export const parser = new XMLParser({
  ignoreAttributes: true,
  // Los prefijos de namespace (soapenv:, ns1:) cambian según el servicio y no
  // aportan nada: sin ellos, un mismo camino sirve para todas las respuestas.
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

// ── El certificado ──────────────────────────────────────────────────────────

export type PropositoArca = 'PADRON' | 'FACTURACION';

export interface Credencial {
  cuit: string;
  certPem: string;
  keyPem: string;
}

export async function credencialArca(proposito: PropositoArca): Promise<Credencial | null> {
  const { data } = await db
    .from('arca_credentials')
    .select('cuit, cert_pem, key_pem')
    .eq('proposito', proposito)
    .maybeSingle();
  if (!data) return null;
  return { cuit: data.cuit as string, certPem: data.cert_pem as string, keyPem: data.key_pem as string };
}

/**
 * Lo que dice el certificado de sí mismo: a nombre de qué CUIT está y hasta
 * cuándo sirve. Se lee del certificado y no de lo que se tipeó al cargarlo,
 * porque es el certificado lo que ARCA mira.
 */
export function datosDelCertificado(certPem: string): { cuit: string | null; vence: Date } {
  const cert = forge.pki.certificateFromPem(certPem);
  const serie = cert.subject.getField({ name: 'serialNumber' })?.value
    ?? cert.subject.attributes.find((a: { type: string }) => a.type === '2.5.4.5')?.value;
  const cuit = typeof serie === 'string' ? serie.replace(/\D/g, '') || null : null;
  return { cuit, vence: cert.validity.notAfter };
}

// ── WSAA: conseguir el permiso de acceso ────────────────────────────────────

/**
 * La hora en el formato que ARCA acepta: hora de Argentina con su huso escrito.
 * Mandarla en UTC con "Z" hace que rechace el pedido por vencido o por futuro,
 * según de qué lado del reloj caiga.
 */
function horaArgentina(fecha: Date): string {
  const corrida = new Date(fecha.getTime() - 3 * 60 * 60 * 1000);
  return `${corrida.toISOString().slice(0, 19)}-03:00`;
}

function armarTra(servicio: string): string {
  const ahora = new Date();
  // Diez minutos para atrás y para adelante: cubre cualquier diferencia de
  // reloj entre este servidor y el de ARCA sin dejar el pedido vivo de más.
  const desde = horaArgentina(new Date(ahora.getTime() - 10 * 60 * 1000));
  const hasta = horaArgentina(new Date(ahora.getTime() + 10 * 60 * 1000));
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>
    <generationTime>${desde}</generationTime>
    <expirationTime>${hasta}</expirationTime>
  </header>
  <service>${servicio}</service>
</loginTicketRequest>`;
}

/**
 * Firma el pedido en CMS (PKCS#7), que es lo que WSAA espera: el XML adentro
 * del sobre firmado, no el XML y la firma por separado.
 */
function firmarTra(tra: string, cred: Credencial): string {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  const certificado = forge.pki.certificateFromPem(cred.certPem);
  p7.addCertificate(certificado);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(cred.keyPem),
    certificate: certificado,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

export async function pedirSoap(url: string, cuerpo: string, accion = ''): Promise<string> {
  let respuesta: Response;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: accion },
      body: cuerpo,
      signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`ARCA no respondió en ${ESPERA_MAXIMA_MS / 1000} segundos. Suele ser momentáneo: probá de nuevo en un rato.`);
    }
    throw new Error(`No se pudo llegar a ARCA: ${err instanceof Error ? err.message : String(err)}`);
  }
  const texto = await respuesta.text();
  if (!respuesta.ok && !texto.includes('Envelope')) {
    throw new Error(`ARCA respondió ${respuesta.status}.`);
  }
  return texto;
}

/** Saca el mensaje de una falla SOAP, que es donde ARCA explica qué pasó. */
export function fallaSoap(xml: string): string | null {
  const parseado = parser.parse(xml);
  const falla = parseado?.Envelope?.Body?.Fault;
  if (!falla) return null;
  return String(falla.faultstring ?? falla.detail ?? 'Error sin detalle.');
}

/** ARCA devuelve un solo elemento suelto o una lista según cuántos haya. */
export function comoLista<T = Record<string, any>>(valor: unknown): T[] {
  if (valor === undefined || valor === null || valor === '') return [];
  return (Array.isArray(valor) ? valor : [valor]) as T[];
}

export interface Ticket {
  token: string;
  sign: string;
  expira: Date;
}

async function ticketGuardado(servicio: string): Promise<Ticket | null> {
  const { data } = await db
    .from('arca_tickets')
    .select('token, sign, expira')
    .eq('servicio', servicio)
    .maybeSingle();
  if (!data) return null;
  const expira = new Date(data.expira as string);
  // Cinco minutos de margen: un ticket que vence mientras viaja la consulta
  // deja un error que no se entiende del otro lado.
  if (expira.getTime() - Date.now() < 5 * 60 * 1000) return null;
  return { token: data.token as string, sign: data.sign as string, expira };
}

export async function ticketDeArca(servicio: string, cred: Credencial): Promise<Ticket> {
  const vigente = await ticketGuardado(servicio);
  if (vigente) return vigente;

  const cms = firmarTra(armarTra(servicio), cred);
  const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const xml = await pedirSoap(WSAA_URL, sobre);
  const falla = fallaSoap(xml);
  if (falla) throw new Error(`WSAA: ${falla}`);

  const respuesta = parser.parse(xml);
  const devuelto = respuesta?.Envelope?.Body?.loginCmsResponse?.loginCmsReturn;
  if (!devuelto) throw new Error('WSAA no devolvió el ticket de acceso.');

  // Adentro viene otro XML, escapado. fast-xml-parser ya desescapa el texto,
  // así que lo que queda es un documento entero listo para parsear de nuevo.
  const adentro = parser.parse(String(devuelto));
  const credenciales = adentro?.loginTicketResponse?.credentials;
  const cabecera = adentro?.loginTicketResponse?.header;
  if (!credenciales?.token || !credenciales?.sign) {
    throw new Error('El ticket de ARCA vino incompleto.');
  }

  const expira = new Date(String(cabecera?.expirationTime ?? Date.now() + 12 * 3600 * 1000));
  await db.from('arca_tickets').upsert(
    {
      servicio,
      token: String(credenciales.token),
      sign: String(credenciales.sign),
      expira: expira.toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'servicio' }
  );

  return { token: String(credenciales.token), sign: String(credenciales.sign), expira };
}

// ── Quién llama ─────────────────────────────────────────────────────────────

/**
 * Hay sesión real y el usuario es admin. La misma regla que is_admin() en la
 * base: profiles.role = 'admin'.
 *
 * No alcanza con la verificación de JWT de la plataforma: la anon key es un JWT
 * bien firmado y la pasaría sin representar a nadie.
 */
export async function esAdmin(req: Request): Promise<boolean> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!token) return false;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user?.id) return false;
  const { data: perfil } = await db
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .maybeSingle();
  return perfil?.role === 'admin';
}
