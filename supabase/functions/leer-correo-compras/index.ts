import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { decodeBase64 } from 'jsr:@std/encoding@1/base64';

/*
  Revisa la casilla de Gmail de compras y manda a leer con IA los comprobantes
  que llegaron adjuntos.

  Lo llama el cron cada 10 minutos (con x-cron-secret) o un admin desde
  Configuración con "Revisar ahora" (con su sesión). Por cada mail sin leer que
  tenga adjuntos:
    1. sube cada PDF (y cada foto de buen tamaño) al bucket de borradores,
    2. le pide a extraer-factura-compra que lo lea, sin esperar la respuesta
       (cada lectura tarda de 5 a 70 segundos),
    3. marca el mail como leído, para no volver a tomarlo.

  Gmail se lee por IMAP con una clave de aplicación: no hace falta OAuth ni
  una app registrada en Google. El cliente IMAP de abajo es mínimo a
  propósito: hace solo lo que esto necesita.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const BUCKET = 'purchase-invoice-drafts';
/** Por pasada: lo que no entra queda sin leer y lo toma la próxima. */
const MAXIMO_MAILS = 10;
const MAXIMO_BYTES = 10 * 1024 * 1024;
/** Una imagen más chica es un logo o una firma, no un comprobante. */
const MINIMO_BYTES_FOTO = 80 * 1024;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

async function esAdmin(req: Request): Promise<boolean> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!token) return false;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return false;
  const { data: perfil } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
  return perfil?.role === 'admin';
}

// ── IMAP ────────────────────────────────────────────────────────────────────

const latin1 = new TextDecoder('latin1');
const enBytes = (s: string) => new TextEncoder().encode(s);

class Imap {
  private buf = new Uint8Array(0);
  private tag = 0;
  private constructor(private conn: Deno.TlsConn) {}

  static async abrir(host: string): Promise<Imap> {
    const conn = await Deno.connectTls({ hostname: host, port: 993 });
    const imap = new Imap(conn);
    await imap.linea(); // saludo del servidor
    return imap;
  }

  private async leerMas(): Promise<void> {
    const trozo = new Uint8Array(64 * 1024);
    const n = await this.conn.read(trozo);
    if (n === null) throw new Error('El servidor de correo cerró la conexión.');
    const junto = new Uint8Array(this.buf.length + n);
    junto.set(this.buf);
    junto.set(trozo.subarray(0, n), this.buf.length);
    this.buf = junto;
  }

  private async linea(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const texto = latin1.decode(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return texto;
        }
      }
      await this.leerMas();
    }
  }

  private async bytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.leerMas();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  /** Manda un comando y junta la respuesta: las líneas y los literales {n}. */
  async comando(cmd: string): Promise<{ lineas: string[]; literales: Uint8Array[] }> {
    const tag = `A${++this.tag}`;
    await this.conn.write(enBytes(`${tag} ${cmd}\r\n`));
    const lineas: string[] = [];
    const literales: Uint8Array[] = [];
    for (;;) {
      let l = await this.linea();
      // Un literal: la línea termina en {n} y siguen n bytes, después el resto.
      let m = l.match(/\{(\d+)\}$/);
      while (m) {
        literales.push(await this.bytes(Number(m[1])));
        const resto = await this.linea();
        l += resto;
        m = resto.match(/\{(\d+)\}$/);
      }
      if (l.startsWith(`${tag} `)) {
        if (!/^\S+ OK/i.test(l)) throw new Error(`IMAP: ${l.replace(/^\S+ /, '')}`);
        return { lineas, literales };
      }
      lineas.push(l);
    }
  }

  cerrar() {
    try { this.conn.close(); } catch { /* ya estaba cerrada */ }
  }
}

const comillas = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// ── MIME ────────────────────────────────────────────────────────────────────

interface Adjunto {
  nombre: string;
  tipo: string;
  datos: Uint8Array;
}

function partirEncabezados(texto: string): { headers: Map<string, string>; cuerpo: string } {
  const corte = texto.search(/\r?\n\r?\n/);
  const cabeza = corte === -1 ? texto : texto.slice(0, corte);
  const cuerpo = corte === -1 ? '' : texto.slice(corte).replace(/^\r?\n\r?\n/, '');
  const headers = new Map<string, string>();
  for (const linea of cabeza.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = linea.indexOf(':');
    if (i > 0) headers.set(linea.slice(0, i).trim().toLowerCase(), linea.slice(i + 1).trim());
  }
  return { headers, cuerpo };
}

function parametro(valor: string, nombre: string): string | null {
  const m = valor.match(new RegExp(`${nombre}\\*?=(?:"([^"]*)"|([^;\\s]+))`, 'i'));
  if (!m) return null;
  const v = m[1] ?? m[2];
  // filename*=UTF-8''factura%20123.pdf
  const rfc2231 = v.match(/^[^']*'[^']*'(.*)$/);
  try {
    return rfc2231 ? decodeURIComponent(rfc2231[1]) : v;
  } catch {
    return v;
  }
}

/** Asunto y remitente con =?UTF-8?B?...?= o =?ISO-8859-1?Q?...?= decodificados. */
function decodificarEncabezado(valor: string): string {
  return valor.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, modo, texto) => {
    try {
      const bytes =
        modo.toUpperCase() === 'B'
          ? decodeBase64(texto)
          : Uint8Array.from(
              texto.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16))),
              (c: string) => c.charCodeAt(0)
            );
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return texto;
    }
  });
}

function adjuntosDe(texto: string, salida: Adjunto[]) {
  const { headers, cuerpo } = partirEncabezados(texto);
  const contentType = headers.get('content-type') ?? 'text/plain';
  const tipo = contentType.split(';')[0].trim().toLowerCase();

  if (tipo.startsWith('multipart/')) {
    const limite = parametro(contentType, 'boundary');
    if (!limite) return;
    const partes = cuerpo.split(`--${limite}`);
    for (const parte of partes.slice(1)) {
      if (parte.startsWith('--')) break; // cierre del multipart
      adjuntosDe(parte.replace(/^\r?\n/, ''), salida);
    }
    return;
  }
  if (tipo === 'message/rfc822') {
    adjuntosDe(cuerpo, salida); // un mail reenviado como adjunto
    return;
  }

  const disposicion = headers.get('content-disposition') ?? '';
  const nombre =
    decodificarEncabezado(parametro(disposicion, 'filename') ?? parametro(contentType, 'name') ?? '') || 'adjunto';
  const extension = nombre.split('.').pop()?.toLowerCase() ?? '';
  const esPdf = tipo === 'application/pdf' || extension === 'pdf';
  const esFoto = tipo.startsWith('image/') && ['jpeg', 'jpg', 'png', 'webp'].some((t) => tipo.endsWith(t));
  if (!esPdf && !esFoto) return;

  const codificacion = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
  let datos: Uint8Array;
  if (codificacion === 'base64') {
    datos = decodeBase64(cuerpo.replace(/[^A-Za-z0-9+/=]/g, ''));
  } else {
    datos = Uint8Array.from(cuerpo, (c) => c.charCodeAt(0) & 0xff);
  }
  if (datos.length === 0 || datos.length > MAXIMO_BYTES) return;
  if (esFoto && datos.length < MINIMO_BYTES_FOTO) return;

  salida.push({ nombre, tipo: esPdf ? 'application/pdf' : tipo === 'image/jpg' ? 'image/jpeg' : tipo, datos });
}

// ── La pasada ───────────────────────────────────────────────────────────────

interface Resultado {
  mails: number;
  comprobantes: number;
  avisos: string[];
}

async function revisar(): Promise<Resultado> {
  const { data: config, error } = await db.rpc('read_correo_compras').maybeSingle();
  if (error) throw new Error(`No se pudo leer la configuración: ${error.message}`);
  const cfg = config as { email: string | null; password: string | null; tipo: string; usuario: string | null } | null;
  if (!cfg?.email || !cfg.password) return { mails: 0, comprobantes: 0, avisos: ['No hay casilla configurada.'] };

  const resultado: Resultado = { mails: 0, comprobantes: 0, avisos: [] };
  const imap = await Imap.abrir('imap.gmail.com');
  const lecturas: Promise<unknown>[] = [];
  try {
    try {
      await imap.comando(`LOGIN ${comillas(cfg.email)} ${comillas(cfg.password)}`);
    } catch {
      throw new Error(
        'Gmail rechazó el usuario o la clave. Tiene que ser una clave de aplicación (16 letras) de esa cuenta, con la verificación en dos pasos activada.'
      );
    }
    await imap.comando('SELECT INBOX');
    const { lineas } = await imap.comando('UID SEARCH UNSEEN X-GM-RAW "has:attachment"');
    const uids = lineas
      .filter((l) => l.startsWith('* SEARCH'))
      .flatMap((l) => l.replace('* SEARCH', '').trim().split(/\s+/))
      .filter(Boolean)
      .slice(0, MAXIMO_MAILS);

    for (const uid of uids) {
      const { literales } = await imap.comando(`UID FETCH ${uid} BODY.PEEK[]`);
      const crudo = literales.find((l) => l.length > 0);
      if (!crudo) continue;
      const texto = latin1.decode(crudo);
      const { headers } = partirEncabezados(texto);
      const de = decodificarEncabezado(headers.get('from') ?? '');
      const asunto = decodificarEncabezado(headers.get('subject') ?? '');

      const adjuntos: Adjunto[] = [];
      adjuntosDe(texto, adjuntos);
      resultado.mails++;

      for (const a of adjuntos) {
        const ext = a.tipo === 'application/pdf' ? 'pdf' : a.tipo.split('/')[1];
        const path = `correo/${crypto.randomUUID()}.${ext}`;
        const { error: errorSubida } = await db.storage.from(BUCKET).upload(path, a.datos, { contentType: a.tipo });
        if (errorSubida) {
          resultado.avisos.push(`No se pudo guardar ${a.nombre} (${asunto}): ${errorSubida.message}`);
          continue;
        }
        resultado.comprobantes++;
        // Se dispara la lectura y se sigue: esperarla haría que una pasada con
        // varios comprobantes pase el tiempo máximo de la función.
        lecturas.push(
          fetch(`${SUPABASE_URL}/functions/v1/extraer-factura-compra`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${SERVICE_KEY}`,
              'x-cron-secret': CRON_SECRET,
            },
            body: JSON.stringify({
              attachment_storage_path: path,
              mime_type: a.tipo,
              kind: cfg.tipo === 'CONCEPTOS' ? 'CONCEPTOS' : 'ARTICULOS',
              usuario: cfg.usuario,
              origen: `Correo: ${de} — ${asunto} (${a.nombre})`.slice(0, 500),
            }),
          }).catch((err) => console.log(`No se pudo pedir la lectura de ${a.nombre}: ${err}`))
        );
      }

      // Leído recién después de guardar sus adjuntos: si algo falló antes, la
      // próxima pasada lo vuelve a tomar.
      await imap.comando(`UID STORE ${uid} +FLAGS (\\Seen)`);
    }
    await imap.comando('LOGOUT').catch(() => {});
  } finally {
    imap.cerrar();
  }

  await db
    .from('app_settings')
    .upsert({
      key: 'compras_correo_ultima',
      value: `${new Date().toISOString()}|${resultado.mails}|${resultado.comprobantes}`,
      updated_at: new Date().toISOString(),
    });

  // Las lecturas siguen después de responder.
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil(Promise.allSettled(lecturas));
  return resultado;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  const delCron = !!CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET;
  if (!delCron && !(await esAdmin(req))) return json({ error: 'No autorizado.' }, 401);

  try {
    return json(await revisar());
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.log(`leer-correo-compras: ${mensaje}`);
    return json({ error: mensaje }, 500);
  }
});
