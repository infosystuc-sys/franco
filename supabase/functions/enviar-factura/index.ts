import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

/*
  Manda la factura (PDF ya armado en el navegador, en base64) por mail o por
  WhatsApp. El PDF se genera del lado del cliente porque el motor de
  render que ya existe ahí (el mismo comprobante que se ve en pantalla) es
  suficiente y evita levantar un Chromium sin cabeza en el servidor solo
  para esto.

  La clave de Gmail y las credenciales de Evolution nunca llegan al
  navegador: esta función corre con la clave de servicio y lee la de Gmail
  de la bóveda (read_gmail_credential, ver invoice-sending.sql). Igual que
  gestionar-empleado, la llama el navegador con la sesión del admin, así
  que la comprobación de rol es la única barrera y se hace antes que
  cualquier otra cosa.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const EVOLUTION_URL = Deno.env.get('EVOLUTION_API_URL') ?? '';
const EVOLUTION_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? '';
const EVOLUTION_INSTANCE = Deno.env.get('EVOLUTION_INSTANCE') ?? '';

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

type Autorizacion = { estado: 'admin' } | { estado: 'sin-sesion' | 'sin-permiso' };

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
  return perfil.role === 'admin' ? { estado: 'admin' } : { estado: 'sin-permiso' };
}

interface CuerpoPedido {
  accion: 'email' | 'whatsapp';
  destinatario: string;
  archivoBase64: string;
  nombreArchivo: string;
  asunto?: string;
  texto?: string;
}

function base64ABytes(base64: string): Uint8Array {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

async function enviarPorMail(pedido: CuerpoPedido): Promise<string | null> {
  const { data: config } = await db
    .from('company_settings')
    .select('email, trade_name, legal_name')
    .eq('id', true)
    .maybeSingle();

  const remitente = config?.email ?? '';
  if (!remitente) return 'No hay un mail del taller cargado en Configuración.';

  const { data: clave, error: errorClave } = await db.rpc('read_gmail_credential');
  if (errorClave || !clave) {
    return 'No hay una credencial de Gmail cargada en Configuración.';
  }

  const nombreTaller = config?.trade_name ?? config?.legal_name ?? 'Taller';

  const cliente = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: { username: remitente, password: clave },
    },
  });

  try {
    await cliente.send({
      from: `${nombreTaller} <${remitente}>`,
      to: pedido.destinatario,
      subject: pedido.asunto ?? 'Factura',
      content: pedido.texto ?? 'Adjuntamos la factura.',
      attachments: [
        {
          filename: pedido.nombreArchivo,
          content: base64ABytes(pedido.archivoBase64),
          encoding: 'binary',
        },
      ],
    });
    return null;
  } catch (e) {
    const err = e as Error;
    return `No se pudo enviar el mail: ${err.message}`;
  } finally {
    await cliente.close();
  }
}

/*
  Los números argentinos de celular tienen una ambigüedad que no se resuelve
  mirando el número: WhatsApp guarda algunas cuentas con el "9" después del 54
  en el JID y otras sin él, según cuándo se dio de alta esa cuenta — no hay
  forma de saberlo de antemano. Mandar a ciegas con el número tal cual se
  escribió hace que Evolution rechace de a ratos números que sí tienen
  WhatsApp, con un 400 que no explica nada ("exists": false y listo).

  Por eso antes de mandar se prueban las dos variantes contra el padrón de
  WhatsApp (el mismo chequeo que Evolution hace puertas adentro al mandar, acá
  se hace antes y con las dos formas del número) y se usa la que exista de
  verdad.
*/
function candidatosWhatsapp(numeroCrudo: string): string[] {
  const digitos = numeroCrudo.replace(/\D/g, '');
  if (!digitos.startsWith('54')) return [digitos];
  const resto = digitos.slice(2);
  return resto.startsWith('9') ? [digitos, '54' + resto.slice(1)] : [digitos, '549' + resto];
}

/**
 * Confirma contra WhatsApp cuál de los candidatos existe de verdad. Si el
 * chequeo mismo falla —el endpoint no está en esta versión de Evolution, un
 * problema de red— no se bloquea el envío por eso: se sigue con el número tal
 * cual se escribió, que es como funcionaba antes de esta confirmación previa.
 */
async function resolverNumeroWhatsapp(
  base: string,
  numeroCrudo: string
): Promise<{ ok: true; numero: string } | { ok: false; error: string }> {
  const candidatos = candidatosWhatsapp(numeroCrudo);
  if (!candidatos[0]) return { ok: false, error: 'El teléfono no tiene ningún dígito.' };

  try {
    const respuesta = await fetch(`${base}/chat/whatsappNumbers/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
      body: JSON.stringify({ numbers: candidatos }),
      signal: AbortSignal.timeout(10000),
    });
    // Si el chequeo no está disponible en esta instancia, se sigue igual: es
    // una confirmación de más, no un requisito para poder mandar.
    if (!respuesta.ok) return { ok: true, numero: candidatos[0] };

    const cuerpo = await respuesta.json().catch(() => null);
    const lista: Array<{ exists?: boolean; jid?: string; number?: string }> = Array.isArray(cuerpo)
      ? cuerpo
      : Array.isArray(cuerpo?.message)
        ? cuerpo.message
        : [];

    const encontrado = lista.find((item) => item?.exists);
    if (encontrado) return { ok: true, numero: encontrado.jid || encontrado.number || candidatos[0] };

    if (candidatos.length > 1) {
      return {
        ok: false,
        error: `Ese número no tiene WhatsApp. Se probó con y sin el 9 (${candidatos.join(' y ')}) y ninguno existe.`,
      };
    }
    return { ok: false, error: `Ese número no tiene WhatsApp (${candidatos[0]}).` };
  } catch {
    return { ok: true, numero: candidatos[0] };
  }
}

async function enviarPorWhatsapp(pedido: CuerpoPedido): Promise<string | null> {
  if (!EVOLUTION_URL || !EVOLUTION_KEY || !EVOLUTION_INSTANCE) {
    return 'Falta configurar EVOLUTION_API_URL, EVOLUTION_API_KEY o EVOLUTION_INSTANCE.';
  }

  const base = EVOLUTION_URL.replace(/\/+$/, '');

  const resuelto = await resolverNumeroWhatsapp(base, pedido.destinatario);
  if (!resuelto.ok) return resuelto.error;

  try {
    const respuesta = await fetch(`${base}/message/sendMedia/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
      body: JSON.stringify({
        number: resuelto.numero,
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: pedido.archivoBase64,
        fileName: pedido.nombreArchivo,
        caption: pedido.texto ?? '',
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!respuesta.ok) {
      const cuerpo = await respuesta.text();
      return `Evolution respondió ${respuesta.status}: ${cuerpo.slice(0, 300)}`;
    }
    return null;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return 'Evolution no respondió a tiempo.';
    }
    return `No se pudo conectar con Evolution: ${err.message}`;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const autorizacion = await verificarAdmin(req);
  if (autorizacion.estado === 'sin-sesion') return json({ error: 'Sin sesión.' }, 401);
  if (autorizacion.estado === 'sin-permiso') return json({ error: 'Solo un administrador puede enviar facturas.' }, 403);

  let pedido: CuerpoPedido;
  try {
    pedido = await req.json();
  } catch {
    return json({ error: 'Cuerpo inválido.' }, 400);
  }

  if (!pedido.destinatario?.trim()) return json({ error: 'Falta el destinatario.' }, 400);
  if (!pedido.archivoBase64) return json({ error: 'Falta el archivo.' }, 400);

  const fallo = pedido.accion === 'email' ? await enviarPorMail(pedido) : await enviarPorWhatsapp(pedido);
  if (fallo) return json({ error: fallo }, 502);

  return json({ ok: true });
});
