import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {
  comoLista,
  credencialArca,
  datosDelCertificado,
  db,
  esAdmin,
  fallaSoap,
  json,
  CORS_HEADERS,
  parser,
  pedirSoap,
  ticketDeArca,
  type Ticket,
} from '../_shared/arca.ts';

/*
  Facturación electrónica con ARCA (WSFEv1).

  ── Fase 1: diagnóstico, y nada más ─────────────────────────────────────────
  Por ahora esta función NO EMITE COMPROBANTES. Se va directo a producción, sin
  pasar por homologación, así que lo primero es poder mirar el estado real de
  ARCA sin tocar nada:

    · que los servidores de ARCA estén arriba;
    · que el certificado cargado sirva y sea del CUIT del taller;
    · qué puntos de venta tiene habilitados el taller para web services;
    · cuál es el último comprobante autorizado de cada uno.

  Todo eso son consultas. Si algo del portal quedó mal —el punto de venta sin
  habilitar, el servicio sin delegar—, aparece acá y no con un cliente
  enfrente esperando la factura.

  Las operaciones que emiten van a ser acciones nuevas de esta misma función,
  en las fases siguientes.
*/

const WSFE_URL = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx';
const WSFE_NS = 'http://ar.gov.afip.dif.FEV1/';
const SERVICIO_WSFE = 'wsfe';

/**
 * Los tipos de comprobante de ARCA que nos importan hoy. La serie interna X no
 * está: no es fiscal y nunca va a ARCA.
 */
const TIPOS_FACTURA = [
  { codigo: 1, letra: 'A' },
  { codigo: 6, letra: 'B' },
] as const;

function escaparXml(valor: string): string {
  return valor.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sobreWsfe(metodo: string, cuerpo = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${WSFE_NS}">
  <soap:Header/>
  <soap:Body>
    <ar:${metodo}>${cuerpo}</ar:${metodo}>
  </soap:Body>
</soap:Envelope>`;
}

function bloqueAuth(ticket: Ticket, cuit: string): string {
  return `<ar:Auth><ar:Token>${escaparXml(ticket.token)}</ar:Token><ar:Sign>${escaparXml(ticket.sign)}</ar:Sign><ar:Cuit>${cuit}</ar:Cuit></ar:Auth>`;
}

/**
 * Llama un método de WSFE y devuelve su nodo Result. Los errores de negocio de
 * WSFE no vienen como falla SOAP sino adentro del resultado, en Errors: se
 * devuelven aparte para que quien llama decida si son graves.
 */
async function llamarWsfe(metodo: string, cuerpo = ''): Promise<{ resultado: any; errores: string[] }> {
  const xml = await pedirSoap(WSFE_URL, sobreWsfe(metodo, cuerpo), `${WSFE_NS}${metodo}`);
  const falla = fallaSoap(xml);
  if (falla) throw new Error(`WSFE ${metodo}: ${falla}`);

  const resultado = parser.parse(xml)?.Envelope?.Body?.[`${metodo}Response`]?.[`${metodo}Result`];
  if (resultado === undefined) throw new Error(`WSFE ${metodo} no devolvió resultado.`);

  const errores = comoLista<{ Code?: string; Msg?: string }>(resultado?.Errors?.Err)
    .map((e) => `${e.Code ?? '?'}: ${e.Msg ?? 'sin detalle'}`);
  return { resultado, errores };
}

// ── El diagnóstico ──────────────────────────────────────────────────────────

interface PuntoDeVenta {
  numero: number;
  /** CAE = web services, que es lo que usamos. CAEA es otro régimen. */
  tipoEmision: string;
  bloqueado: boolean;
  fechaBaja: string | null;
  ultimos: Record<string, number | string>;
}

async function diagnostico() {
  const avisos: string[] = [];

  // 1. ARCA arriba. FEDummy no pide autenticación: si esto falla, el problema
  //    es de ARCA o de la red, no nuestro.
  const dummy = await llamarWsfe('FEDummy');
  const servidores = {
    aplicacion: String(dummy.resultado?.AppServer ?? '?'),
    baseDeDatos: String(dummy.resultado?.DbServer ?? '?'),
    autenticacion: String(dummy.resultado?.AuthServer ?? '?'),
  };
  if (Object.values(servidores).some((v) => v !== 'OK')) {
    avisos.push('Algún servidor de ARCA no responde OK. Lo demás puede fallar por eso, no por nuestra configuración.');
  }

  // 2. El certificado.
  const cred = await credencialArca('FACTURACION');
  if (!cred) {
    return {
      servidores,
      certificado: null,
      puntosDeVenta: [],
      puntoDeVentaConfigurado: null,
      avisos: [...avisos, 'Todavía no está cargado el certificado de facturación. Se carga en Configuración.'],
    };
  }

  const { data: taller } = await db
    .from('company_settings')
    .select('tax_id, sales_point')
    .maybeSingle();
  const cuitTaller = String(taller?.tax_id ?? '').replace(/\D/g, '');

  const delCert = datosDelCertificado(cred.certPem);
  const diasParaVencer = Math.floor((delCert.vence.getTime() - Date.now()) / 86_400_000);
  const certificado = {
    cuit: delCert.cuit ?? cred.cuit,
    vence: delCert.vence.toISOString().slice(0, 10),
    diasParaVencer,
    coincideConTaller: (delCert.cuit ?? cred.cuit) === cuitTaller,
  };
  if (!certificado.coincideConTaller) {
    avisos.push(
      `El certificado es del CUIT ${certificado.cuit} y el taller está cargado con ${cuitTaller || '(sin CUIT)'}. ` +
      'Para facturar tienen que coincidir: el CAE se pide a nombre de quien emite.'
    );
  }
  if (diasParaVencer < 30) {
    avisos.push(`El certificado vence en ${diasParaVencer} días. Hay que renovarlo en ARCA antes de esa fecha.`);
  }

  // 3. Autenticarse. Si el servicio wsfe no está delegado al certificado, es
  //    acá donde ARCA lo dice.
  const ticket = await ticketDeArca(SERVICIO_WSFE, cred);
  const auth = bloqueAuth(ticket, certificado.cuit);

  // 4. Qué puntos de venta tiene habilitados el taller para web services.
  const ptos = await llamarWsfe('FEParamGetPtosVenta', auth);
  const listados = comoLista<Record<string, string>>(ptos.resultado?.ResultGet?.PtoVenta);
  if (listados.length === 0) {
    avisos.push(
      'ARCA no devuelve ningún punto de venta habilitado para web services' +
      (ptos.errores.length ? ` (${ptos.errores.join('; ')})` : '') +
      '. Hay que dar de alta uno como "Factura Electrónica — Web Services".'
    );
  }

  // 5. El último comprobante autorizado de cada uno, por letra. Es lo que
  //    decide desde qué número sigue la app.
  const puntosDeVenta: PuntoDeVenta[] = [];
  for (const p of listados) {
    const numero = Number(p.Nro);
    const ultimos: Record<string, number | string> = {};
    for (const tipo of TIPOS_FACTURA) {
      const r = await llamarWsfe(
        'FECompUltimoAutorizado',
        `${auth}<ar:PtoVta>${numero}</ar:PtoVta><ar:CbteTipo>${tipo.codigo}</ar:CbteTipo>`
      );
      ultimos[tipo.letra] = r.errores.length ? r.errores.join('; ') : Number(r.resultado?.CbteNro ?? 0);
    }
    puntosDeVenta.push({
      numero,
      tipoEmision: String(p.EmisionTipo ?? ''),
      bloqueado: String(p.Bloqueado ?? 'N').toUpperCase() === 'S',
      fechaBaja: p.FchBaja && p.FchBaja !== 'NULL' ? String(p.FchBaja) : null,
      ultimos,
    });
  }

  const configurado = Number(taller?.sales_point ?? 0) || null;
  if (configurado && !puntosDeVenta.some((p) => p.numero === configurado)) {
    avisos.push(
      `El taller está configurado para facturar por el punto de venta ${configurado}, ` +
      'y ARCA no lo tiene habilitado para web services.'
    );
  }

  return { servidores, certificado, puntosDeVenta, puntoDeVentaConfigurado: configurado, avisos };
}

// ── Entrada ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  // Facturar es administración, no mostrador: a diferencia del padrón, que
  // puede consultarlo cualquiera con sesión, esto es solo para admin.
  if (!(await esAdmin(req))) {
    return json({ error: 'Solo un administrador puede usar la facturación electrónica.' }, 403);
  }

  let accion = '';
  try {
    accion = String((await req.json())?.accion ?? '');
  } catch {
    return json({ error: 'Pedido mal formado.' }, 400);
  }

  try {
    switch (accion) {
      case 'diagnostico':
        return json(await diagnostico());
      default:
        return json({ error: `Acción desconocida: ${accion || '(vacía)'}.` }, 400);
    }
  } catch (err) {
    // El detalle de ARCA sirve —dice si el certificado venció o si el servicio
    // no está delegado—, así que se pasa tal cual en vez de esconderlo.
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
