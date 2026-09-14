import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import forge from 'npm:node-forge@1.3.1';
import { XMLParser } from 'npm:fast-xml-parser@4.5.0';

/*
  Consulta del padrón de ARCA: con el CUIT (o el DNI) alcanza.

  Dar de alta un cliente o un proveedor era copiar a mano razón social,
  condición de IVA y domicilio desde una constancia en PDF. ARCA publica esos
  datos por web service; esto los trae y los devuelve ya con la forma de la
  ficha del sistema.

  ── Por qué vive del lado del servidor ──────────────────────────────────────
  Consultar el padrón exige firmar el pedido con una clave privada. Esa clave
  no puede pisar el navegador: quien la tenga puede consultar el padrón —y, con
  el certificado que corresponda, facturar— a nombre del titular. Vive en
  arca_credentials, una tabla sin policies que solo la llave de servicio lee.

  ── Cómo es el trámite ──────────────────────────────────────────────────────
  Son dos pasos y ARCA los separa a propósito:

    1. WSAA. Se arma un pedido de acceso (TRA), se lo firma con el certificado
       y se lo manda. Devuelve un token y una firma que valen 12 HORAS.
    2. Padrón. Con ese par se consulta cuantas veces haga falta.

  El token se guarda en arca_tickets y se reusa hasta que vence. No es una
  optimización: si se pide un ticket nuevo teniendo uno vigente, ARCA responde
  "ya posee un TA valido" y, si se insiste, bloquea por exceso de tráfico.

  ── Dos servicios, dos tickets ──────────────────────────────────────────────
  El ticket se emite para UN servicio. Buscar por CUIT usa el padrón A5
  (ws_sr_constancia_inscripcion); resolver un DNI a su CUIT usa el A13
  (ws_sr_padron_a13). Cada uno lleva el suyo.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

// ── Direcciones de ARCA ─────────────────────────────────────────────────────
const WSAA_URL = 'https://wsaa.afip.gob.ar/ws/services/LoginCms';
const PADRON_A5_URL = 'https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA5';
const PADRON_A13_URL = 'https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA13';

/** El servicio que habilita la consulta por CUIT. */
const SERVICIO_A5 = 'ws_sr_constancia_inscripcion';
/** El que resuelve un DNI a la lista de CUIT de esa persona. */
const SERVICIO_A13 = 'ws_sr_padron_a13';

const parser = new XMLParser({
  ignoreAttributes: true,
  // Los prefijos de namespace (soapenv:, ns1:) cambian según el servicio y no
  // aportan nada: sin ellos, un mismo camino sirve para las dos respuestas.
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

interface Credencial {
  cuit: string;
  certPem: string;
  keyPem: string;
}

async function credencialDePadron(): Promise<Credencial | null> {
  const { data } = await db
    .from('arca_credentials')
    .select('cuit, cert_pem, key_pem')
    .eq('proposito', 'PADRON')
    .maybeSingle();
  if (!data) return null;
  return { cuit: data.cuit as string, certPem: data.cert_pem as string, keyPem: data.key_pem as string };
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

async function pedirSoap(url: string, cuerpo: string, accion = ''): Promise<string> {
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: accion },
    body: cuerpo,
  });
  const texto = await respuesta.text();
  if (!respuesta.ok && !texto.includes('Envelope')) {
    throw new Error(`ARCA respondió ${respuesta.status}.`);
  }
  return texto;
}

/** Saca el mensaje de una falla SOAP, que es donde ARCA explica qué pasó. */
function fallaSoap(xml: string): string | null {
  const parseado = parser.parse(xml);
  const falla = parseado?.Envelope?.Body?.Fault;
  if (!falla) return null;
  return String(falla.faultstring ?? falla.detail ?? 'Error sin detalle.');
}

interface Ticket {
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

async function ticketDeArca(servicio: string, cred: Credencial): Promise<Ticket> {
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

// ── Padrón ──────────────────────────────────────────────────────────────────

async function consultarA5(cuit: string, cred: Credencial): Promise<Record<string, any>> {
  const ticket = await ticketDeArca(SERVICIO_A5, cred);
  const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona_v2>
      <token>${ticket.token}</token>
      <sign>${ticket.sign}</sign>
      <cuitRepresentada>${cred.cuit}</cuitRepresentada>
      <idPersona>${cuit}</idPersona>
    </a5:getPersona_v2>
  </soapenv:Body>
</soapenv:Envelope>`;

  const xml = await pedirSoap(PADRON_A5_URL, sobre);
  const falla = fallaSoap(xml);
  if (falla) throw new Error(`Padrón: ${falla}`);

  const respuesta = parser.parse(xml);
  const devuelto = respuesta?.Envelope?.Body?.getPersona_v2Response?.personaReturn;
  if (!devuelto) throw new Error('El padrón no devolvió datos.');
  return devuelto;
}

/**
 * De un DNI a su CUIT. ARCA guarda todo por CUIT: el DNI solo sirve para
 * llegar a él, y solo si esa persona tiene CUIT o CUIL dado de alta.
 */
async function cuitDeDocumento(documento: string, cred: Credencial): Promise<string[]> {
  const ticket = await ticketDeArca(SERVICIO_A13, cred);
  const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a13="http://a13.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a13:getIdPersonaListByDocumento>
      <token>${ticket.token}</token>
      <sign>${ticket.sign}</sign>
      <cuitRepresentada>${cred.cuit}</cuitRepresentada>
      <documento>${documento}</documento>
    </a13:getIdPersonaListByDocumento>
  </soapenv:Body>
</soapenv:Envelope>`;

  const xml = await pedirSoap(PADRON_A13_URL, sobre);
  const falla = fallaSoap(xml);
  if (falla) throw new Error(`Padrón: ${falla}`);

  const respuesta = parser.parse(xml);
  const lista = respuesta?.Envelope?.Body?.getIdPersonaListByDocumentoResponse?.idPersonaListReturn;
  const ids = lista?.idPersona;
  if (!ids) return [];
  return (Array.isArray(ids) ? ids : [ids]).map((v: unknown) => String(v));
}

// ── Traducción a la ficha del sistema ───────────────────────────────────────

function comoLista(valor: unknown): Record<string, any>[] {
  if (!valor) return [];
  return Array.isArray(valor) ? valor : [valor as Record<string, any>];
}

/**
 * La condición frente al IVA, que es lo que define la letra de la factura.
 *
 * ARCA no la publica como un campo: se deduce de en qué regímenes está
 * inscripta la persona. El monotributo manda sobre todo lo demás —un
 * monotributista no es responsable inscripto aunque figure el impuesto—, así
 * que se mira primero.
 */
function condicionFrenteAlIva(persona: Record<string, any>): string {
  if (persona.datosMonotributo) return 'MONOTRIBUTO';

  const impuestos = comoLista(persona.datosRegimenGeneral?.impuesto);
  const activos = impuestos.filter((i) => String(i.estadoImpuesto ?? 'ACTIVO').toUpperCase() !== 'BAJA');

  // 30 es IVA. Si está inscripto, es responsable inscripto.
  if (activos.some((i) => String(i.idImpuesto) === '30')) return 'RESPONSABLE_INSCRIPTO';
  // 32 es IVA exento; algunas personas lo traen solo en la descripción.
  if (activos.some((i) => String(i.idImpuesto) === '32')) return 'EXENTO';
  if (activos.some((i) => /EXENTO/i.test(String(i.descripcionImpuesto ?? '')))) return 'EXENTO';

  // Sin IVA ni monotributo no hay nada que discriminar: es consumidor final.
  return 'CONSUMIDOR_FINAL';
}

function texto(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  const limpio = String(valor).trim();
  return limpio === 'null' ? '' : limpio;
}

function traducir(persona: Record<string, any>) {
  const generales = persona.datosGenerales ?? {};
  const domicilio = generales.domicilioFiscal ?? {};

  const razonSocial = texto(generales.razonSocial);
  const apellido = texto(generales.apellido);
  const nombre = texto(generales.nombre);
  // Las personas físicas vienen con apellido y nombre separados; las jurídicas
  // solo con razón social. El nombre visible del cliente arranca igual a la
  // razón social y después se edita si el taller lo conoce de otra manera.
  const denominacion = razonSocial || [apellido, nombre].filter(Boolean).join(' ');

  return {
    taxId: texto(generales.idPersona) || texto(persona.idPersona),
    legalName: denominacion,
    name: denominacion,
    taxCondition: condicionFrenteAlIva(persona),
    addressStreet: texto(domicilio.direccion),
    addressCity: texto(domicilio.localidad) || texto(domicilio.descripcionProvincia),
    addressState: texto(domicilio.descripcionProvincia),
    addressZip: texto(domicilio.codPostal),
    tipoPersona: texto(generales.tipoPersona),
    estadoClave: texto(generales.estadoClave),
    // Lo que ARCA dice tal cual, por si la traducción de arriba no convence a
    // quien está cargando: prefiere ver el detalle antes que adivinar.
    detalleImpuestos: comoLista(persona.datosRegimenGeneral?.impuesto)
      .map((i) => texto(i.descripcionImpuesto))
      .filter(Boolean),
    categoriaMonotributo: texto(persona.datosMonotributo?.categoriaMonotributo),
  };
}

// ── Entrada ─────────────────────────────────────────────────────────────────

/**
 * Cualquier empleado con sesión puede consultar: dar de alta un cliente es
 * trabajo de mostrador, no de administración. Lo que se exige es que haya una
 * sesión real detrás — la anon key es un JWT bien firmado y pasaría la
 * verificación de la plataforma sin representar a nadie.
 */
async function haySesion(req: Request): Promise<boolean> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!token) return false;
  const { data, error } = await db.auth.getUser(token);
  return !error && Boolean(data?.user?.id);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  if (!(await haySesion(req))) {
    return json({ error: 'Sesión no válida.' }, 401);
  }

  let documento = '';
  try {
    const cuerpo = await req.json();
    documento = String(cuerpo?.documento ?? '').replace(/\D/g, '');
  } catch {
    return json({ error: 'Pedido mal formado.' }, 400);
  }

  if (documento.length !== 11 && (documento.length < 7 || documento.length > 8)) {
    return json(
      { error: 'Ingresá un CUIT de 11 dígitos o un DNI de 7 u 8.' },
      400
    );
  }

  const cred = await credencialDePadron();
  if (!cred) {
    return json(
      { error: 'Todavía no está cargado el certificado de ARCA. Se carga en Configuración.' },
      409
    );
  }

  try {
    let cuit = documento;
    let avisoDni: string | null = null;

    if (documento.length !== 11) {
      const encontrados = await cuitDeDocumento(documento, cred);
      if (encontrados.length === 0) {
        return json({ error: `El DNI ${documento} no tiene CUIT ni CUIL en ARCA.` }, 404);
      }
      cuit = encontrados[0];
      if (encontrados.length > 1) {
        // Pasa con quien tiene CUIT de persona física y además uno de empresa.
        avisoDni = `El DNI tiene ${encontrados.length} claves: se trajo la de ${cuit}.`;
      }
    }

    const persona = await consultarA5(cuit, cred);

    if (persona.errorConstancia) {
      const detalle = texto(persona.errorConstancia?.error ?? persona.errorConstancia);
      return json({ error: `ARCA no da constancia de ${cuit}: ${detalle}` }, 404);
    }

    const datos = traducir(persona);
    if (!datos.taxId) datos.taxId = cuit;

    return json({ datos, aviso: avisoDni });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    // El detalle de ARCA sirve —dice si el certificado venció o si el servicio
    // no está habilitado—, así que se pasa tal cual en vez de esconderlo.
    return json({ error: mensaje }, 502);
  }
});
