import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { GoogleGenAI } from 'npm:@google/genai@2.4.0';

/*
  Lee una factura de compra (PDF o foto) y arma un borrador en
  purchase_invoice_extractions. No escribe nada en purchase_invoices — eso
  pasa recién cuando el usuario confirma desde la pantalla de revisión, por
  la misma RPC save_purchase_invoice de siempre.

  La lectura la hace Gemini o Anthropic, según lo configurado en la app. Las
  claves viven en ai_credentials, una tabla que solo la llave de servicio
  puede leer: nunca llegan al navegador.

  Mismo patrón de autorización que gestionar-empleado: solo un admin con
  sesión puede pedir una extracción.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'purchase-invoice-drafts';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

type Proveedor = 'GEMINI' | 'ANTHROPIC';

const NOMBRE_PROVEEDOR: Record<Proveedor, string> = {
  GEMINI: 'Gemini',
  ANTHROPIC: 'Anthropic',
};

/**
 * Fallas del lado del proveedor que se arreglan solas esperando: el modelo
 * saturado (503 UNAVAILABLE), la cuota momentánea (429) y el error interno
 * (500). No entran acá la clave inválida ni el archivo ilegible, que por más
 * que se reintenten van a fallar igual.
 */
function esFallaPasajera(err: unknown): boolean {
  const texto = err instanceof Error ? err.message : String(err);
  return /\b(429|500|503|529)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|overloaded|high demand/i.test(texto);
}

/**
 * El mensaje que ve quien está cargando la factura. El error del proveedor
 * llega como un JSON crudo en inglés —"This model is currently experiencing
 * high demand"— que no le dice a nadie qué hacer con eso.
 */
function mensajeParaElUsuario(err: unknown): string {
  const texto = err instanceof Error ? err.message : String(err);
  if (texto.startsWith('TIEMPO_AGOTADO')) {
    return 'El lector de comprobantes tardó demasiado en contestar y se cortó la espera. ' +
      'Suele pasar cuando está saturado. Probá de nuevo en unos minutos, ' +
      'o cargá la factura a mano: el archivo subido queda guardado.';
  }
  if (esFallaPasajera(texto)) {
    return 'El lector de comprobantes está saturado en este momento. ' +
      'Ya se reintentó automáticamente sin suerte. Probá de nuevo en unos minutos, ' +
      'o cargá la factura a mano: el archivo subido queda guardado.';
  }
  if (/API key|API_KEY|PERMISSION_DENIED|authentication|invalid x-api-key|\b401\b|\b403\b/i.test(texto)) {
    return 'El lector de comprobantes rechazó la credencial. Revisá la clave del proveedor en Configuración.';
  }
  return `No se pudo leer el comprobante: ${texto}`;
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tope duro por intento.
 *
 * El SDK de Gemini reintenta solo, por dentro y sin avisar, cuando el modelo
 * está saturado. Sin este tope una lectura se quedó tres minutos colgada hasta
 * que la plataforma mató la función: el usuario vio "non-2xx" y el borrador
 * quedó huérfano, sin lectura y sin error que explicara nada. Vale más cortar
 * y decirlo que esperar a que nos corten.
 */
const LIMITE_POR_INTENTO_MS = 45_000;

function conLimite<T>(promesa: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promesa,
    new Promise<never>((_, rechazar) =>
      setTimeout(() => rechazar(new Error(`TIEMPO_AGOTADO: el lector no respondió en ${ms / 1000} segundos.`)), ms)
    ),
  ]);
}

/**
 * Reintenta mientras la falla sea pasajera, esperando cada vez más. Los saltos
 * son cortos a propósito: del otro lado hay alguien esperando que la pantalla
 * termine de leer su factura, y una espera larga se siente como que se colgó.
 *
 * Un intento agotado NO se reintenta: si tardó 45 segundos en no contestar, es
 * el proveedor dando vueltas por su cuenta, y otra ronda solo acerca el límite
 * de la función sin mejorar nada.
 */
async function conReintentos<T>(accion: () => Promise<T>): Promise<T> {
  // Dos reintentos y nada más: son para el 503 que vuelve rápido. Los saltos
  // cortos hacen que el peor caso sano quede en unos diez segundos.
  const esperas = [1500, 4000];
  for (let intento = 0; ; intento++) {
    try {
      return await conLimite(accion(), LIMITE_POR_INTENTO_MS);
    } catch (err) {
      const agotado = err instanceof Error && err.message.startsWith('TIEMPO_AGOTADO');
      if (agotado || intento >= esperas.length || !esFallaPasajera(err)) throw err;
      console.log(`Lectura fallida (intento ${intento + 1}), reintentando: ${err instanceof Error ? err.message : err}`);
      await esperar(esperas[intento]);
    }
  }
}

type Autorizacion = { estado: 'admin'; userId: string } | { estado: 'sin-sesion' | 'sin-permiso' };

async function verificarAdmin(req: Request): Promise<Autorizacion> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!token) return { estado: 'sin-sesion' };

  const { data: { user }, error: errorUsuario } = await db.auth.getUser(token);
  if (errorUsuario || !user) return { estado: 'sin-sesion' };

  const { data: perfil, error: errorPerfil } = await db
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (errorPerfil || !perfil) return { estado: 'sin-sesion' };
  return perfil.role === 'admin' ? { estado: 'admin', userId: user.id } : { estado: 'sin-permiso' };
}

// ── Schema de la extracción ────────────────────────────────────────────────
// Se define UNA vez como JSON Schema, que es lo que come Anthropic, y se
// traduce a Gemini uppercaseando los tipos. Dos definiciones paralelas se
// habrían despegado en el primer campo nuevo que alguien agregue de un lado.
// Cadena vacía en vez de null para "no figura"; confianza como objeto paralelo
// a valores, no anidada campo por campo — mismo criterio que PH_FAC (ver spec).

const HEADER_FIELDS = [
  'proveedor_cuit', 'proveedor_razon_social', 'tipo_comprobante', 'letra',
  'punto_venta', 'numero', 'fecha_comprobante', 'condicion_pago', 'total',
];

const ARTICULOS_ITEM_FIELDS = ['codigo', 'descripcion', 'cantidad', 'precio_unitario', 'bonificacion_porcentaje', 'alicuota_iva'];
const CONCEPTOS_ITEM_FIELDS = ['descripcion', 'importe', 'alicuota_iva'];

// deno-lint-ignore no-explicit-any
type Esquema = Record<string, any>;

function esquemaFor(kind: 'ARTICULOS' | 'CONCEPTOS'): Esquema {
  const itemFields = kind === 'ARTICULOS' ? ARTICULOS_ITEM_FIELDS : CONCEPTOS_ITEM_FIELDS;
  const strings = (campos: string[]) => Object.fromEntries(campos.map((f) => [f, { type: 'string' }]));
  const numbers = (campos: string[]) => Object.fromEntries(campos.map((f) => [f, { type: 'number' }]));

  return {
    type: 'object',
    properties: {
      valores: { type: 'object', properties: strings(HEADER_FIELDS), required: HEADER_FIELDS },
      confianzas: { type: 'object', properties: numbers(HEADER_FIELDS), required: HEADER_FIELDS },
      percepciones: {
        type: 'array',
        items: {
          type: 'object',
          properties: { nombre: { type: 'string' }, importe: { type: 'string' } },
          required: ['nombre', 'importe'],
        },
      },
      renglones: {
        type: 'array',
        items: {
          type: 'object',
          properties: { ...strings(itemFields), confianza: { type: 'number' } },
          required: [...itemFields, 'confianza'],
        },
      },
    },
    required: ['valores', 'confianzas', 'percepciones', 'renglones'],
  };
}

/** Gemini espera los tipos en mayúsculas ("STRING"); JSON Schema los usa en minúscula. */
function aEsquemaGemini(nodo: Esquema): Esquema {
  const copia: Esquema = {};
  for (const [clave, valor] of Object.entries(nodo)) {
    if (clave === 'type' && typeof valor === 'string') {
      copia[clave] = valor.toUpperCase();
    } else if (Array.isArray(valor)) {
      copia[clave] = valor.map((v) => (v && typeof v === 'object' ? aEsquemaGemini(v) : v));
    } else if (valor && typeof valor === 'object') {
      copia[clave] = aEsquemaGemini(valor);
    } else {
      copia[clave] = valor;
    }
  }
  return copia;
}

function promptFor(kind: 'ARTICULOS' | 'CONCEPTOS', ownTaxId: string | null): string {
  const base = `
Sos un asistente que lee facturas de compra de un taller de inyección diesel
en Argentina y extrae sus datos en JSON, siguiendo exactamente el schema
provisto.

Reglas:
- Los importes se transcriben TAL COMO FIGURAN impresos, sin normalizar
  separadores decimales (no conviertas "1.234,56" a "1234.56": copialo tal
  cual como texto — el sistema que recibe esto hace su propia conversión).
- Si un campo no figura en el comprobante, devolvé cadena vacía "" — nunca
  inventes un valor.
- El CUIT del EMISOR de la factura es el del PROVEEDOR, no el nuestro.
  ${ownTaxId ? `Nuestro CUIT (el del taller que RECIBE la factura, nunca el proveedor) es ${ownTaxId}.` : ''}
- tipo_comprobante tiene que ser exactamente uno de: FACTURA, NOTA_CREDITO, NOTA_DEBITO.
- letra tiene que ser exactamente una de: A, B, C, M.
- alicuota_iva por renglón: el número de la alícuota (ej. "21", "10.5", "0"), sin el símbolo %.
- IGNORÁ por completo el cuadro de DESCUENTO POR PRONTO PAGO (o "pago
  contado", "neto a pagar si abona antes del..."). Es una oferta condicional
  a que el cliente pague antes de una fecha: NO está aplicada al comprobante
  y no forma parte de sus totales. El "total" que tenés que devolver es
  siempre el TOTAL del comprobante, nunca el neto a pagar con ese descuento.
- La bonificación por renglón sí va: es la columna "%BON", "BONIF" o "DTO"
  de la grilla de artículos, que ya está aplicada en el importe del renglón.
- Las percepciones e impuestos (IIBB, percepción de IVA, impuestos internos)
  van SIEMPRE en "percepciones", con el nombre tal como está impreso. Son
  parte del total: omitir una hace que el comprobante cierre por debajo de lo
  que dice el papel.
- BUSCÁ LAS PERCEPCIONES EN TODO EL COMPROBANTE, no solo en el cuadro de
  totales. Muchos proveedores las escriben como una línea suelta de texto, al
  pie, mezcladas entre las leyendas legales o al margen. Por ejemplo:
      LA MERCADERIA VIAJA POR CUENTA Y RIESGO DEL COMPRADOR.
      PASADAS LAS 72HS, NO SE ACEPTAN DEVOLUCIONES
      Perc. Tucumán: 4456.66,
  Ahí "Perc. Tucumán: 4456.66," ES una percepción y va en la lista, con
  nombre "Perc. Tucumán" e importe "4456.66". Las otras dos líneas son
  leyendas legales y NO se cargan: no tienen importe.
- Formas habituales de nombrarlas, todas válidas: "Perc.", "Percep.",
  "Percepción", "Ret.", "IIBB", "I.I.B.B.", "Ing. Brutos", seguidas de una
  provincia ("Tucumán", "Bs. As.", "Salta") o de "IVA". Si una línea tiene
  algo así y un importe al lado, es una percepción.
- En "importe" va SOLO el número, sin el nombre y sin el signo pesos, y sin
  la puntuación que cierra la frase: de "Perc. Tucumán: $ 4.456,66," el
  importe es "4.456,66".
- confianza (0 a 1): qué tan seguro estás de haber leído bien ese campo/renglón. 1 = perfectamente legible, 0.5 = dudoso, 0 = adivinado.
`.trim();

  if (kind === 'ARTICULOS') {
    return `${base}\n\nEsta factura es de artículos/repuestos: cada renglón tiene un código de producto del proveedor (columna "código", "art.", "cód. prov." o similar) — extraelo tal como está impreso en "codigo". Si un renglón no tiene código visible, dejalo en "".`;
  }
  return `${base}\n\nEsta factura es de conceptos/gastos (fletes, servicios, honorarios): no tiene códigos de artículo, solo descripción e importe por renglón.`;
}

interface ExtractedHeader {
  valores: Record<string, string>;
  confianzas: Record<string, number>;
  percepciones: { nombre: string; importe: string }[];
  renglones: Record<string, string | number>[];
}

/** Tolerante a propósito: nunca lanza por un campo raro, solo si el JSON no parsea. */
function parseExtraction(text: string): ExtractedHeader {
  const parsed = JSON.parse(text);
  return {
    valores: parsed.valores ?? {},
    confianzas: parsed.confianzas ?? {},
    percepciones: Array.isArray(parsed.percepciones) ? parsed.percepciones : [],
    renglones: Array.isArray(parsed.renglones) ? parsed.renglones : [],
  };
}

// ── Los dos lectores ───────────────────────────────────────────────────────
// Los dos reciben lo mismo y devuelven el JSON crudo de la extracción, para
// que el resto de la función no sepa con cuál se leyó.

interface PedidoDeLectura {
  apiKey: string;
  mimeType: string;
  base64: string;
  kind: 'ARTICULOS' | 'CONCEPTOS';
  ownTaxId: string | null;
}

async function leerConGemini({ apiKey, mimeType, base64, kind, ownTaxId }: PedidoDeLectura): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  const respuesta = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: [
      { text: 'Extraé los datos de este comprobante según el schema.' },
      { inlineData: { mimeType, data: base64 } },
    ],
    config: {
      systemInstruction: promptFor(kind, ownTaxId),
      responseMimeType: 'application/json',
      responseSchema: aEsquemaGemini(esquemaFor(kind)),
    },
  });
  return respuesta.text ?? '';
}

/**
 * Anthropic no tiene "responseSchema": la forma de pedirle una salida
 * estructurada es darle una herramienta con ese schema y obligarlo a usarla.
 * Lo que devuelve es el input de esa llamada, que ya viene como objeto.
 */
async function leerConAnthropic({ apiKey, mimeType, base64, kind, ownTaxId }: PedidoDeLectura): Promise<string> {
  const esPdf = mimeType === 'application/pdf';
  const bloqueArchivo = esPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };

  const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      system: promptFor(kind, ownTaxId),
      tools: [{
        name: 'cargar_comprobante',
        description: 'Carga los datos leídos del comprobante en el sistema.',
        input_schema: esquemaFor(kind),
      }],
      tool_choice: { type: 'tool', name: 'cargar_comprobante' },
      messages: [{
        role: 'user',
        content: [bloqueArchivo, { type: 'text', text: 'Extraé los datos de este comprobante según el schema.' }],
      }],
    }),
  });

  if (!respuesta.ok) {
    // El código va en el mensaje para que esFallaPasajera lo reconozca: es lo
    // que decide si se reintenta y si se pasa al otro proveedor.
    throw new Error(`${respuesta.status} ${await respuesta.text()}`);
  }

  const datos = await respuesta.json();
  const uso = (datos.content ?? []).find((bloque: { type: string }) => bloque.type === 'tool_use');
  if (!uso) throw new Error('Anthropic no devolvió la extracción estructurada.');
  return JSON.stringify(uso.input);
}

const LECTORES: Record<Proveedor, (p: PedidoDeLectura) => Promise<string>> = {
  GEMINI: leerConGemini,
  ANTHROPIC: leerConAnthropic,
};

/**
 * Las claves salen de ai_credentials, que solo la llave de servicio puede
 * leer. El secreto de entorno sigue valiendo como respaldo: quien ya lo tenía
 * configurado no necesita volver a cargar nada para que siga andando.
 */
async function credenciales(): Promise<Record<Proveedor, string | null>> {
  const { data } = await db.from('ai_credentials').select('provider, api_key');
  const cargadas = new Map((data ?? []).map((fila) => [fila.provider as Proveedor, fila.api_key as string]));
  return {
    GEMINI: cargadas.get('GEMINI') ?? Deno.env.get('GEMINI_API_KEY') ?? null,
    ANTHROPIC: cargadas.get('ANTHROPIC') ?? Deno.env.get('ANTHROPIC_API_KEY') ?? null,
  };
}

async function proveedorElegido(): Promise<Proveedor> {
  const { data } = await db.from('app_settings').select('value').eq('key', 'ai_provider').maybeSingle();
  return data?.value === 'ANTHROPIC' ? 'ANTHROPIC' : 'GEMINI';
}

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

  const storagePath = String(body.attachment_storage_path ?? '');
  const mimeType = String(body.mime_type ?? '');
  const kind = body.kind === 'ARTICULOS' ? 'ARTICULOS' : body.kind === 'CONCEPTOS' ? 'CONCEPTOS' : null;
  if (!storagePath || !mimeType || !kind) {
    return json({ error: 'Faltan attachment_storage_path, mime_type o kind.' }, 400);
  }

  // Crea el borrador ya, en estado EXTRAIDO por default — si algo falla más
  // abajo, se actualiza a ERROR en vez de dejarlo sin fila.
  const { data: draft, error: errorDraft } = await db
    .from('purchase_invoice_extractions')
    .insert({
      kind,
      attachment_storage_path: storagePath,
      attachment_mime_type: mimeType,
      status: 'EXTRAIDO',
      created_by: autorizacion.userId,
    })
    .select('id')
    .single();

  if (errorDraft || !draft) {
    return json({ error: `No se pudo crear el borrador: ${errorDraft?.message}` }, 500);
  }

  async function marcarError(mensaje: string): Promise<Response> {
    await db.from('purchase_invoice_extractions').update({ status: 'ERROR', error_message: mensaje }).eq('id', draft.id);
    return json({ id: draft.id, error: mensaje }, 200); // 200: el borrador existe, el cliente lee su status ERROR
  }

  // Todo lo que sigue va adentro de un try: cualquier excepción inesperada
  // (armado del payload, red, matcheo) tiene que dejar el borrador en ERROR
  // con mensaje, nunca huérfano en EXTRAIDO sin raw_extraction — que la
  // pantalla de revisión mostraría como un formulario vacío normal.
  try {
    const { data: fileData, error: errorDescarga } = await db.storage.from(BUCKET).download(storagePath);
    if (errorDescarga || !fileData) {
      return await marcarError(`No se pudo leer el archivo subido: ${errorDescarga?.message}`);
    }

    const { data: company } = await db.from('company_settings').select('tax_id').eq('id', true).maybeSingle();
    const ownTaxId = company?.tax_id ?? null;

    // encodeBase64 recorre el buffer de a bloques. El
    // String.fromCharCode(...spread) que había acá pasaba un argumento por
    // byte y reventaba con RangeError arriba de ~100 KB: o sea, toda foto de
    // celular fallaba siempre.
    const base64 = encodeBase64(new Uint8Array(await fileData.arrayBuffer()));

    const elegido = await proveedorElegido();
    const claves = await credenciales();
    const respaldo: Proveedor = elegido === 'GEMINI' ? 'ANTHROPIC' : 'GEMINI';
    // El elegido primero; el otro solo si tiene clave cargada. Sin clave no se
    // intenta: daría un error de credencial que no explica nada.
    const aProbar = [elegido, respaldo].filter((p) => claves[p]);

    if (aProbar.length === 0) {
      return await marcarError(
        `No hay ninguna clave cargada para leer comprobantes. Cargá la de ${NOMBRE_PROVEEDOR[elegido]} en Configuración.`
      );
    }

    let crudo: string | null = null;
    let usado: Proveedor | null = null;
    let ultimoError: unknown = null;

    for (const proveedor of aProbar) {
      try {
        crudo = await conReintentos(() => LECTORES[proveedor]({
          apiKey: claves[proveedor]!,
          mimeType,
          base64,
          kind,
          ownTaxId,
        }));
        usado = proveedor;
        break;
      } catch (err) {
        ultimoError = err;
        console.log(`${NOMBRE_PROVEEDOR[proveedor]} no pudo leer: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (!usado || crudo === null) {
      return await marcarError(mensajeParaElUsuario(ultimoError));
    }

    let extraccion: ExtractedHeader;
    try {
      extraccion = parseExtraction(crudo);
    } catch {
      return await marcarError(`La respuesta de ${NOMBRE_PROVEEDOR[usado]} no vino en un JSON legible.`);
    }

    // ── Matcheo de proveedor por CUIT exacto.
    const cuitLimpio = (extraccion.valores.proveedor_cuit ?? '').replace(/\D/g, '');
    let supplierId: string | null = null;
    if (cuitLimpio) {
      const { data: supplier } = await db.from('suppliers').select('id').eq('tax_id', cuitLimpio).maybeSingle();
      supplierId = supplier?.id ?? null;
    }

    // ── Matcheo de renglones por código exacto de proveedor (solo ARTICULOS).
    let renglonesConMatch = extraccion.renglones;
    if (kind === 'ARTICULOS' && supplierId) {
      renglonesConMatch = await Promise.all(
        extraccion.renglones.map(async (renglon) => {
          const codigo = String(renglon.codigo ?? '').trim();
          if (!codigo) return { ...renglon, article_id: null };
          // El código va escapado: en ilike, "_" y "%" son comodines, y un
          // código impreso "AB_1023" matchearía "AB-1023" o "AB11023". Con el
          // escape la comparación queda exacta salvo por mayúsculas, que es
          // justo cómo está definido el unique (supplier_id, upper(supplier_code)).
          const patron = codigo.replace(/([\\%_])/g, '\\$1');
          const { data: matches } = await db
            .from('article_suppliers')
            .select('article_id')
            .eq('supplier_id', supplierId)
            .ilike('supplier_code', patron)
            .limit(2);
          // Más de un candidato = ambiguo: se deja sin matchear para que lo
          // elija el usuario, en vez de atar el renglón al artículo equivocado.
          const articleId = matches?.length === 1 ? matches[0].article_id : null;
          return { ...renglon, article_id: articleId ?? null };
        })
      );
    } else if (kind === 'ARTICULOS') {
      renglonesConMatch = extraccion.renglones.map((r) => ({ ...r, article_id: null }));
    }

    const { error: errorUpdate } = await db
      .from('purchase_invoice_extractions')
      .update({
        supplier_id: supplierId,
        raw_extraction: { ...extraccion, renglones: renglonesConMatch },
        status: 'EXTRAIDO',
        ai_provider: usado,
      })
      .eq('id', draft.id);

    if (errorUpdate) {
      // Igual que cualquier otra falla post-creación del borrador: se marca
      // ERROR en vez de dejarlo con status EXTRAIDO sin raw_extraction — si no,
      // la pantalla de revisión lo mostraría como "leído" sin tener nada para
      // mostrar.
      return await marcarError(`No se pudo guardar la lectura: ${errorUpdate.message}`);
    }

    return json({ id: draft.id, provider: usado });
  } catch (err) {
    return await marcarError(`No se pudo procesar el archivo: ${err instanceof Error ? err.message : String(err)}`);
  }
});
