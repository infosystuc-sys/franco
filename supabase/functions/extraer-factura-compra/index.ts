import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';
import { GoogleGenAI, Type } from 'npm:@google/genai@2.4.0';

/*
  Lee una factura de compra (PDF o foto) con Gemini y arma un borrador en
  purchase_invoice_extractions. No escribe nada en purchase_invoices — eso
  pasa recién cuando el usuario confirma desde la pantalla de revisión, por
  la misma RPC save_purchase_invoice de siempre.

  Mismo patrón de autorización que gestionar-empleado: la API key de Gemini
  vive acá, nunca en el navegador, y solo un admin con sesión puede pedir
  una extracción.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const BUCKET = 'purchase-invoice-drafts';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

/**
 * Fallas del lado de Google que se arreglan solas esperando: el modelo
 * saturado (503 UNAVAILABLE), la cuota momentánea (429) y el error interno
 * (500). No entran acá la clave inválida ni el archivo ilegible, que por más
 * que se reintenten van a fallar igual.
 */
function esFallaPasajera(err: unknown): boolean {
  const texto = err instanceof Error ? err.message : String(err);
  return /\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|overloaded|high demand/i.test(texto);
}

/**
 * El mensaje que ve quien está cargando la factura. El error de Google llega
 * como un JSON crudo en inglés —"This model is currently experiencing high
 * demand"— que no le dice a nadie qué hacer con eso.
 */
function mensajeParaElUsuario(err: unknown): string {
  const texto = err instanceof Error ? err.message : String(err);
  if (texto.startsWith('TIEMPO_AGOTADO')) {
    return 'El lector de comprobantes de Google tardó demasiado en contestar y se cortó la espera. ' +
      'Suele pasar cuando está saturado. Probá de nuevo en unos minutos, ' +
      'o cargá la factura a mano: el archivo subido queda guardado.';
  }
  if (esFallaPasajera(texto)) {
    return 'El lector de comprobantes de Google está saturado en este momento. ' +
      'Ya se reintentó automáticamente sin suerte. Probá de nuevo en unos minutos, ' +
      'o cargá la factura a mano: el archivo subido queda guardado.';
  }
  if (/API key|API_KEY|PERMISSION_DENIED|401|403/i.test(texto)) {
    return 'El lector de comprobantes rechazó la credencial. Hay que revisar la clave de Gemini en la configuración del servidor.';
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
      setTimeout(() => rechazar(new Error(`TIEMPO_AGOTADO: Gemini no respondió en ${ms / 1000} segundos.`)), ms)
    ),
  ]);
}

/**
 * Reintenta mientras la falla sea pasajera, esperando cada vez más. Los saltos
 * son cortos a propósito: del otro lado hay alguien esperando que la pantalla
 * termine de leer su factura, y una espera larga se siente como que se colgó.
 *
 * Un intento agotado NO se reintenta: si tardó 45 segundos en no contestar, es
 * el SDK dando vueltas por su cuenta, y otra ronda solo acerca el límite de la
 * función sin mejorar nada.
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
      console.log(`Gemini falló (intento ${intento + 1}), reintentando: ${err instanceof Error ? err.message : err}`);
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

// ── Schemas de structured output. La Task 2 del plan confirmó que el schema
// de ARTICULOS (el más grande) compila en un solo llamado, sin partir en dos
// pasadas. Cadena vacía en vez de null para "no figura"; confianza como
// objeto paralelo a valores, no anidada campo por campo — mismo criterio que
// PH_FAC (ver spec).

const HEADER_FIELDS = [
  'proveedor_cuit', 'proveedor_razon_social', 'tipo_comprobante', 'letra',
  'punto_venta', 'numero', 'fecha_comprobante', 'condicion_pago', 'total',
];

function headerSchema() {
  const stringProps = Object.fromEntries(HEADER_FIELDS.map((f) => [f, { type: Type.STRING }]));
  const numberProps = Object.fromEntries(HEADER_FIELDS.map((f) => [f, { type: Type.NUMBER }]));
  return {
    valores: { type: Type.OBJECT, properties: stringProps, required: HEADER_FIELDS },
    confianzas: { type: Type.OBJECT, properties: numberProps, required: HEADER_FIELDS },
    percepciones: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { nombre: { type: Type.STRING }, importe: { type: Type.STRING } },
        required: ['nombre', 'importe'],
      },
    },
  };
}

const ARTICULOS_ITEM_FIELDS = ['codigo', 'descripcion', 'cantidad', 'precio_unitario', 'bonificacion_porcentaje', 'alicuota_iva'];
const CONCEPTOS_ITEM_FIELDS = ['descripcion', 'importe', 'alicuota_iva'];

function schemaFor(kind: 'ARTICULOS' | 'CONCEPTOS') {
  const itemFields = kind === 'ARTICULOS' ? ARTICULOS_ITEM_FIELDS : CONCEPTOS_ITEM_FIELDS;
  const itemProps = Object.fromEntries(itemFields.map((f) => [f, { type: Type.STRING }]));
  return {
    type: Type.OBJECT,
    properties: {
      ...headerSchema(),
      renglones: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: { ...itemProps, confianza: { type: Type.NUMBER } },
          required: [...itemFields, 'confianza'],
        },
      },
    },
    required: ['valores', 'confianzas', 'percepciones', 'renglones'],
  };
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
- Las percepciones e impuestos del pie (IIBB, percepción de IVA, impuestos
  internos) van SIEMPRE en "percepciones", con el nombre tal como está
  impreso. Son parte del total: omitir una hace que el comprobante cierre
  por debajo de lo que dice el papel.
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

    let respuesta;
    try {
      respuesta = await conReintentos(() => ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: [
          { text: 'Extraé los datos de este comprobante según el schema.' },
          { inlineData: { mimeType, data: base64 } },
        ],
        config: {
          systemInstruction: promptFor(kind, ownTaxId),
          responseMimeType: 'application/json',
          responseSchema: schemaFor(kind),
        },
      }));
    } catch (err) {
      return await marcarError(mensajeParaElUsuario(err));
    }

    let extraccion: ExtractedHeader;
    try {
      extraccion = parseExtraction(respuesta.text ?? '');
    } catch {
      return await marcarError('La respuesta de Gemini no vino en un JSON legible.');
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
      })
      .eq('id', draft.id);

    if (errorUpdate) {
      // Igual que cualquier otra falla post-creación del borrador: se marca
      // ERROR en vez de dejarlo con status EXTRAIDO sin raw_extraction — si no,
      // la pantalla de revisión lo mostraría como "leído" sin tener nada para
      // mostrar.
      return await marcarError(`No se pudo guardar la lectura: ${errorUpdate.message}`);
    }

    return json({ id: draft.id });
  } catch (err) {
    return await marcarError(`No se pudo procesar el archivo: ${err instanceof Error ? err.message : String(err)}`);
  }
});
