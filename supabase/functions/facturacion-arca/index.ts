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

  ── Las acciones ────────────────────────────────────────────────────────────
  · diagnostico  — solo lectura: que ARCA esté arriba, que el certificado sirva
                   y sea del CUIT del taller, qué puntos de venta hay
                   habilitados y el último número de cada serie.
  · parametros   — solo lectura: la tabla de condiciones frente al IVA del
                   receptor, tal como la publica ARCA.
  · emitir       — le pide el CAE a una factura que está en PENDIENTE_CAE.

  ── Por qué la emisión está partida ─────────────────────────────────────────
  Pedir el CAE es una llamada a un tercero, y no puede vivir adentro de la
  transacción que escribe la factura. Entonces la factura nace en
  PENDIENTE_CAE con su número reservado (eso lo hace _create_invoice en la
  base), acá se le pide el CAE, y recién si ARCA autoriza se la pasa a EMITIDA
  con confirmar_cae().

  Si esta función falla, tarda o se corta, la factura QUEDA PENDIENTE y no se
  inventa nada. ARCA es la fuente de verdad, no nuestra base: ante la duda se
  le pregunta con FECompConsultar, no se adivina. Esa es la regla que evita a
  la vez el hueco en la numeración y el CAE duplicado.
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

/** Las notas de crédito. Cada tipo lleva su propio correlativo en ARCA. */
const TIPOS_NOTA_CREDITO: Record<string, number> = { A: 3, B: 8, C: 13 };

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

// ── Emitir: pedirle el CAE a ARCA ───────────────────────────────────────────

/**
 * RG 5616: desde 2024 el comprobante tiene que declarar la condición frente al
 * IVA del receptor. Nuestras cuatro condiciones contra los códigos de ARCA.
 * La acción `parametros` devuelve la tabla viva para poder contrastarla.
 */
const CONDICION_IVA_RECEPTOR: Record<string, number> = {
  RESPONSABLE_INSCRIPTO: 1,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  MONOTRIBUTO: 6,
};

/** ARCA quiere las fechas como YYYYMMDD y los importes con dos decimales. */
const aFechaArca = (iso: string) => String(iso).slice(0, 10).replace(/-/g, '');
const deFechaArca = (v: string) => {
  const s = String(v ?? '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};
const importe = (v: unknown) => Number(v ?? 0).toFixed(2);

async function parametros() {
  const cred = await credencialArca('FACTURACION');
  if (!cred) throw new Error('Todavía no está cargado el certificado de facturación.');

  const delCert = datosDelCertificado(cred.certPem);
  const ticket = await ticketDeArca(SERVICIO_WSFE, cred);
  const auth = bloqueAuth(ticket, delCert.cuit ?? cred.cuit);

  const r = await llamarWsfe('FEParamGetCondicionIvaReceptor', auth);
  return {
    condicionesIvaReceptor: comoLista<Record<string, string>>(
      r.resultado?.ResultGet?.CondicionIvaReceptor,
    ),
    errores: r.errores,
    /** Lo que esta función asume hoy, para poder comparar sin salir de acá. */
    loQueAsumimos: CONDICION_IVA_RECEPTOR,
  };
}

interface PedidoDeCae {
  auth: string;
  cbteTipo: number;
  ptoVta: number;
  numero: number;
  docTipo: number;
  docNro: string;
  fecha: string;
  vencimientoPago: string;
  neto: unknown;
  iva: unknown;
  total: unknown;
  condicionIva: number;
  /** El comprobante que esta nota de crédito revierte. */
  asociado?: { tipo: number; ptoVta: number; numero: number; cuit: string; fecha: string };
}

interface RespuestaDeCae {
  aprobada: boolean;
  cae: string | null;
  caeVence: string | null;
  resultado: string;
  errores: string[];
  observaciones: string[];
}

/**
 * FECAESolicitar, que es igual para los dos comprobantes que emitimos: lo
 * único que cambia es el tipo, y que la nota de crédito arrastra el
 * comprobante asociado. Una sola función para que no existan dos armados del
 * mismo sobre que después se corrigen por separado.
 */
async function solicitarCae(p: PedidoDeCae): Promise<RespuestaDeCae> {
  const asociado = p.asociado
    ? `<ar:CbtesAsoc><ar:CbteAsoc>` +
      `<ar:Tipo>${p.asociado.tipo}</ar:Tipo>` +
      `<ar:PtoVta>${p.asociado.ptoVta}</ar:PtoVta>` +
      `<ar:Nro>${p.asociado.numero}</ar:Nro>` +
      `<ar:Cuit>${p.asociado.cuit}</ar:Cuit>` +
      `<ar:CbteFch>${p.asociado.fecha}</ar:CbteFch>` +
      `</ar:CbteAsoc></ar:CbtesAsoc>`
    : '';

  const detalle =
    `<ar:Concepto>3</ar:Concepto>` +
    `<ar:DocTipo>${p.docTipo}</ar:DocTipo>` +
    `<ar:DocNro>${p.docNro}</ar:DocNro>` +
    `<ar:CbteDesde>${p.numero}</ar:CbteDesde>` +
    `<ar:CbteHasta>${p.numero}</ar:CbteHasta>` +
    `<ar:CbteFch>${p.fecha}</ar:CbteFch>` +
    `<ar:ImpTotal>${importe(p.total)}</ar:ImpTotal>` +
    `<ar:ImpTotConc>0.00</ar:ImpTotConc>` +
    `<ar:ImpNeto>${importe(p.neto)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>0.00</ar:ImpOpEx>` +
    `<ar:ImpTrib>0.00</ar:ImpTrib>` +
    `<ar:ImpIVA>${importe(p.iva)}</ar:ImpIVA>` +
    // Concepto 3 es productos y servicios, que es lo que hace el taller, y
    // obliga a declarar el período del servicio y el vencimiento del pago.
    `<ar:FchServDesde>${p.fecha}</ar:FchServDesde>` +
    `<ar:FchServHasta>${p.fecha}</ar:FchServHasta>` +
    `<ar:FchVtoPago>${p.vencimientoPago}</ar:FchVtoPago>` +
    `<ar:MonId>PES</ar:MonId>` +
    `<ar:MonCotiz>1</ar:MonCotiz>` +
    `<ar:CondicionIVAReceptorId>${p.condicionIva}</ar:CondicionIVAReceptorId>` +
    asociado +
    // Id 5 es la alícuota del 21%. Hoy el taller factura todo al 21%; el día
    // que haya otra, acá van varios AlicIva y la base tiene que traerlos
    // discriminados en vez de un único importe de IVA.
    `<ar:Iva><ar:AlicIva>` +
    `<ar:Id>5</ar:Id>` +
    `<ar:BaseImp>${importe(p.neto)}</ar:BaseImp>` +
    `<ar:Importe>${importe(p.iva)}</ar:Importe>` +
    `</ar:AlicIva></ar:Iva>`;

  const cuerpo =
    `${p.auth}<ar:FeCAEReq>` +
    `<ar:FeCabReq>` +
    `<ar:CantReg>1</ar:CantReg>` +
    `<ar:PtoVta>${p.ptoVta}</ar:PtoVta>` +
    `<ar:CbteTipo>${p.cbteTipo}</ar:CbteTipo>` +
    `</ar:FeCabReq>` +
    `<ar:FeDetReq><ar:FECAEDetRequest>${detalle}</ar:FECAEDetRequest></ar:FeDetReq>` +
    `</ar:FeCAEReq>`;

  const { resultado, errores } = await llamarWsfe('FECAESolicitar', cuerpo);
  const det = comoLista<Record<string, any>>(resultado?.FeDetResp?.FECAEDetResponse)[0];

  return {
    aprobada: String(resultado?.FeCabResp?.Resultado ?? '') === 'A' && !!det?.CAE,
    cae: det?.CAE ? String(det.CAE) : null,
    caeVence: det?.CAEFchVto ? deFechaArca(det.CAEFchVto) : null,
    resultado: String(resultado?.FeCabResp?.Resultado ?? '?'),
    errores,
    observaciones: comoLista<{ Code?: string; Msg?: string }>(det?.Observaciones?.Obs)
      .map((o) => `${o.Code ?? '?'}: ${o.Msg ?? 'sin detalle'}`),
  };
}

/** El número que sigue en ARCA para ese punto de venta y tipo. */
async function ultimoAutorizado(auth: string, ptoVta: number, cbteTipo: number): Promise<number> {
  const r = await llamarWsfe(
    'FECompUltimoAutorizado',
    `${auth}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`,
  );
  if (r.errores.length) {
    throw new Error(`ARCA no informa el último número: ${r.errores.join('; ')}`);
  }
  return Number(r.resultado?.CbteNro ?? 0);
}

/** El certificado, el ticket y el bloque de autenticación, que todo pedido usa. */
async function credencialYAuth() {
  const cred = await credencialArca('FACTURACION');
  if (!cred) throw new Error('Todavía no está cargado el certificado de facturación.');
  const delCert = datosDelCertificado(cred.certPem);
  const cuit = delCert.cuit ?? cred.cuit;
  const ticket = await ticketDeArca(SERVICIO_WSFE, cred);
  return { cuit, auth: bloqueAuth(ticket, cuit) };
}

async function emitir(invoiceId: string) {
  if (!invoiceId) throw new Error('Falta decir qué factura emitir.');

  const { data: f, error } = await db
    .from('invoices')
    .select('id, invoice_type, sales_point, number, full_number, status, customer_tax_id, customer_tax_condition, issue_date, due_date, net_amount, vat_amount, total_amount')
    .eq('id', invoiceId)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer la factura: ${error.message}`);
  if (!f) throw new Error('La factura no existe.');

  if (f.status !== 'PENDIENTE_CAE') {
    throw new Error(
      `La factura ${f.full_number} no está esperando un CAE: está ${f.status}.`,
    );
  }

  const cbteTipo = TIPOS_FACTURA.find((t) => t.letra === f.invoice_type)?.codigo;
  if (!cbteTipo) {
    throw new Error(
      f.invoice_type === 'X'
        ? 'La serie interna X no es fiscal y no va a ARCA.'
        : `La factura ${f.invoice_type} todavía no está implementada.`,
    );
  }

  const condicionIva = CONDICION_IVA_RECEPTOR[String(f.customer_tax_condition)];
  if (!condicionIva) {
    throw new Error(
      `No sé qué condición frente al IVA declararle a ARCA para "${f.customer_tax_condition}".`,
    );
  }

  // DocTipo 80 es CUIT; 99 es "consumidor final sin identificar", y solo se
  // puede usar en la B. Una A sin CUIT del cliente no existe.
  const cuitCliente = String(f.customer_tax_id ?? '').replace(/\D/g, '');
  if (f.invoice_type === 'A' && cuitCliente.length !== 11) {
    throw new Error(
      'Una factura A necesita el CUIT del cliente, y este no lo tiene cargado.',
    );
  }
  const docTipo = cuitCliente.length === 11 ? 80 : 99;
  const docNro = cuitCliente.length === 11 ? cuitCliente : '0';

  const { auth } = await credencialYAuth();

  // El número lo reservó la base. Antes de pedir el CAE se confirma contra
  // ARCA que sea el que sigue: si los contadores se separaron, pedirlo igual
  // deja un hueco en la numeración y todas las facturas siguientes son
  // rechazadas. Mejor parar acá, que es reversible.
  const esperado = (await ultimoAutorizado(auth, Number(f.sales_point), cbteTipo)) + 1;
  if (esperado !== Number(f.number)) {
    throw new Error(
      `La numeración se desalineó: ARCA espera la ${esperado} en el punto de ` +
        `venta ${f.sales_point} y esta factura tomó la ${f.number}. No se pidió ` +
        'ningún CAE. Hay que corregir la numeración antes de emitir.',
    );
  }

  const fch = aFechaArca(f.issue_date);
  const r = await solicitarCae({
    auth,
    cbteTipo,
    ptoVta: Number(f.sales_point),
    numero: Number(f.number),
    docTipo,
    docNro,
    fecha: fch,
    vencimientoPago: aFechaArca(f.due_date),
    neto: f.net_amount,
    iva: f.vat_amount,
    total: f.total_amount,
    condicionIva,
  });

  if (!r.aprobada || !r.cae) {
    // Rechazada: la factura sigue en PENDIENTE_CAE con su número intacto, así
    // que se puede corregir el dato que ARCA objetó y reintentar sin pedir
    // otro número.
    const motivos = [...r.errores, ...r.observaciones];
    const motivo = motivos.length
      ? motivos.join(' · ')
      : `ARCA respondió "${r.resultado}" sin detallar por qué.`;

    // El motivo se guarda, no solo se devuelve: es lo que hay que corregir, y
    // quien cierra la pantalla y vuelve más tarde necesita seguir viéndolo.
    await db.rpc('registrar_rechazo_cae', { p_invoice_id: f.id, p_motivo: motivo });

    return {
      autorizada: false,
      factura: f.full_number,
      resultado: r.resultado,
      errores: r.errores,
      observaciones: r.observaciones,
    };
  }

  const cae = r.cae;
  const caeVence = r.caeVence!;
  const observaciones = r.observaciones;

  const { error: errConfirmar } = await db.rpc('confirmar_cae', {
    p_invoice_id: f.id,
    p_cae: cae,
    p_cae_due_date: caeVence,
    p_simulado: false,
  });

  if (errConfirmar) {
    // El peor caso: ARCA autorizó y nosotros no pudimos anotarlo. El CAE va en
    // el error para que no se pierda, y la factura queda pendiente hasta que
    // la reconciliación la resuelva contra FECompConsultar.
    throw new Error(
      `ARCA autorizó la factura ${f.full_number} con el CAE ${cae} (vence ` +
        `${caeVence}) pero no se pudo guardar: ${errConfirmar.message}. ` +
        'La factura sigue pendiente y NO hay que volver a pedir el CAE.',
    );
  }

  return {
    autorizada: true,
    factura: f.full_number,
    cae,
    caeVence,
    observaciones,
  };
}

async function emitirNotaCredito(creditNoteId: string) {
  if (!creditNoteId) throw new Error('Falta decir qué nota de crédito emitir.');

  const { data: nc, error } = await db
    .from('credit_notes')
    .select('id, invoice_id, invoice_type, sales_point, number, full_number, status, customer_tax_id, customer_tax_condition, issue_date, net_amount, vat_amount, total_amount, invoice:invoices(sales_point, number, invoice_type, issue_date, cae)')
    .eq('id', creditNoteId)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer la nota de crédito: ${error.message}`);
  if (!nc) throw new Error('La nota de crédito no existe.');
  if (nc.status !== 'PENDIENTE_CAE') {
    throw new Error(`La nota de crédito ${nc.full_number} no está esperando un CAE: está ${nc.status}.`);
  }

  const factura = nc.invoice as any;
  if (!factura?.cae) {
    throw new Error('La factura de referencia todavía no tiene CAE: ARCA no la conoce.');
  }

  const cbteTipo = TIPOS_NOTA_CREDITO[String(nc.invoice_type)];
  if (!cbteTipo) throw new Error(`No hay nota de crédito para la serie ${nc.invoice_type}.`);

  const condicionIva = CONDICION_IVA_RECEPTOR[String(nc.customer_tax_condition)];
  if (!condicionIva) {
    throw new Error(`No sé qué condición frente al IVA declararle a ARCA para "${nc.customer_tax_condition}".`);
  }

  const cuitCliente = String(nc.customer_tax_id ?? '').replace(/\D/g, '');
  if (nc.invoice_type === 'A' && cuitCliente.length !== 11) {
    throw new Error('Una nota de crédito A necesita el CUIT del cliente.');
  }

  const { cuit: cuitEmisor, auth } = await credencialYAuth();

  const esperado = (await ultimoAutorizado(auth, Number(nc.sales_point), cbteTipo)) + 1;
  if (esperado !== Number(nc.number)) {
    throw new Error(
      `La numeración se desalineó: ARCA espera la ${esperado} en el punto de venta ` +
        `${nc.sales_point} y esta nota de crédito tomó la ${nc.number}. No se pidió ningún CAE.`,
    );
  }

  const fch = aFechaArca(nc.issue_date);
  const r = await solicitarCae({
    auth,
    cbteTipo,
    ptoVta: Number(nc.sales_point),
    numero: Number(nc.number),
    docTipo: cuitCliente.length === 11 ? 80 : 99,
    docNro: cuitCliente.length === 11 ? cuitCliente : '0',
    fecha: fch,
    // Una nota de crédito no se cobra: el vencimiento de pago es su misma
    // fecha. ARCA lo pide igual porque el concepto 3 lo exige siempre.
    vencimientoPago: fch,
    neto: nc.net_amount,
    iva: nc.vat_amount,
    total: nc.total_amount,
    condicionIva,
    // Lo que la vincula fiscalmente con la factura que revierte. Sin esto ARCA
    // la toma como un comprobante suelto y no revierte nada.
    asociado: {
      tipo: TIPOS_FACTURA.find((t) => t.letra === factura.invoice_type)?.codigo ?? 0,
      ptoVta: Number(factura.sales_point),
      numero: Number(factura.number),
      cuit: cuitEmisor,
      fecha: aFechaArca(factura.issue_date),
    },
  });

  if (!r.aprobada || !r.cae) {
    const motivos = [...r.errores, ...r.observaciones];
    const motivo = motivos.length
      ? motivos.join(' · ')
      : `ARCA respondió "${r.resultado}" sin detallar por qué.`;

    await db.rpc('registrar_rechazo_cae_nc', { p_credit_note_id: nc.id, p_motivo: motivo });

    return {
      autorizada: false,
      factura: nc.full_number,
      resultado: r.resultado,
      errores: r.errores,
      observaciones: r.observaciones,
    };
  }

  const { error: errConfirmar } = await db.rpc('confirmar_cae_nc', {
    p_credit_note_id: nc.id,
    p_cae: r.cae,
    p_cae_due_date: r.caeVence,
  });

  if (errConfirmar) {
    throw new Error(
      `ARCA autorizó la nota de crédito ${nc.full_number} con el CAE ${r.cae} (vence ` +
        `${r.caeVence}) pero no se pudo guardar: ${errConfirmar.message}. ` +
        'Sigue pendiente y NO hay que volver a pedir el CAE.',
    );
  }

  return {
    autorizada: true,
    factura: nc.full_number,
    cae: r.cae,
    caeVence: r.caeVence,
    observaciones: r.observaciones,
  };
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

  let pedido: Record<string, unknown> = {};
  try {
    pedido = (await req.json()) ?? {};
  } catch {
    return json({ error: 'Pedido mal formado.' }, 400);
  }
  const accion = String(pedido.accion ?? '');

  try {
    switch (accion) {
      case 'diagnostico':
        return json(await diagnostico());
      case 'parametros':
        return json(await parametros());
      case 'emitir':
        return json(await emitir(String(pedido.invoice_id ?? '')));
      case 'emitir-nota-credito':
        return json(await emitirNotaCredito(String(pedido.credit_note_id ?? '')));
      default:
        return json({ error: `Acción desconocida: ${accion || '(vacía)'}.` }, 400);
    }
  } catch (err) {
    // El detalle de ARCA sirve —dice si el certificado venció o si el servicio
    // no está delegado—, así que se pasa tal cual en vez de esconderlo.
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
