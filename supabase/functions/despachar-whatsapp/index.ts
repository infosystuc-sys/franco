import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

/*
  Despachador de la cola de WhatsApp.

  Lo invoca pg_cron cada minuto. Toma los mensajes pendientes, los manda por
  Evolution API y marca el resultado. No lo llama el navegador nunca: la clave
  de Evolution vive acá, del lado del servidor, fuera del alcance de cualquiera
  que descargue la app.

  Se protege con un secreto propio (CRON_SECRET) en vez de JWT, porque quien lo
  llama es el cron de la base, que no tiene sesión de usuario.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

const EVOLUTION_URL = Deno.env.get('EVOLUTION_API_URL') ?? '';
const EVOLUTION_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? '';
const EVOLUTION_INSTANCE = Deno.env.get('EVOLUTION_INSTANCE') ?? '';

/*
  Sin límite de tiempo, un Evolution que acepta la conexión y no contesta deja
  la función colgada: el mensaje queda tomado, nadie lo marca y el error no
  aparece por ningún lado. Con el límite, el cuelgue se registra como falla.
*/
const LIMITE_MS = 12000;

const base = () => EVOLUTION_URL.replace(/\/+$/, '');

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

async function leerConfig(): Promise<Record<string, string>> {
  const { data } = await db.from('app_settings').select('key, value');
  const config: Record<string, string> = {};
  (data ?? []).forEach((row: { key: string; value: string }) => {
    config[row.key] = row.value;
  });
  return config;
}

function faltaConfig(): string | null {
  if (!EVOLUTION_URL || !EVOLUTION_KEY || !EVOLUTION_INSTANCE) {
    return 'Falta configurar EVOLUTION_API_URL, EVOLUTION_API_KEY o EVOLUTION_INSTANCE.';
  }
  return null;
}

/** Traduce cualquier tropiezo de red a una frase que sirva en la pantalla. */
function describirFalla(e: unknown): string {
  const err = e as Error;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return `Evolution no respondió en ${LIMITE_MS / 1000} segundos.`;
  }
  return `No se pudo conectar con Evolution: ${err.message}`;
}

/** Envía un mensaje por Evolution API. Devuelve el error si falla. */
async function enviar(telefono: string, texto: string): Promise<string | null> {
  const falta = faltaConfig();
  if (falta) return falta;

  try {
    const respuesta = await fetch(`${base()}/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
      body: JSON.stringify({ number: telefono, text: texto }),
      signal: AbortSignal.timeout(LIMITE_MS),
    });

    if (!respuesta.ok) {
      const cuerpo = await respuesta.text();
      return `Evolution respondió ${respuesta.status}: ${cuerpo.slice(0, 300)}`;
    }
    return null;
  } catch (e) {
    return describirFalla(e);
  }
}

/*
  Modo diagnóstico: dice a qué servidor está intentando llegar y si la
  instancia está vinculada, sin revelar la clave. Es lo primero que hay que
  mirar cuando los mensajes no salen.
*/
async function diagnosticar(): Promise<Record<string, unknown>> {
  const falta = faltaConfig();
  if (falta) return { configurado: false, detalle: falta };

  let servidor: string;
  try {
    servidor = new URL(base()).host;
  } catch {
    return { configurado: false, detalle: `EVOLUTION_API_URL no es una URL válida: "${base()}"` };
  }

  try {
    const respuesta = await fetch(`${base()}/instance/connectionState/${EVOLUTION_INSTANCE}`, {
      headers: { apikey: EVOLUTION_KEY },
      signal: AbortSignal.timeout(LIMITE_MS),
    });
    const cuerpo = await respuesta.text();
    return {
      configurado: true,
      servidor,
      instancia: EVOLUTION_INSTANCE,
      alcanzable: respuesta.ok,
      codigo: respuesta.status,
      detalle: cuerpo.slice(0, 300),
    };
  } catch (e) {
    return { configurado: true, servidor, instancia: EVOLUTION_INSTANCE, alcanzable: false, detalle: describirFalla(e) };
  }
}

Deno.serve(async (req: Request) => {
  // Sin JWT: se autentica con un secreto compartido con el cron.
  if (CRON_SECRET && req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('No autorizado', { status: 401 });
  }

  if (new URL(req.url).searchParams.get('diagnostico') === '1') {
    return Response.json(await diagnosticar());
  }

  const config = await leerConfig();

  if (config.whatsapp_enabled !== 'true') {
    return Response.json({ estado: 'apagado', mensaje: 'whatsapp_enabled está en false.' });
  }

  const modoPrueba = config.whatsapp_test_mode === 'true';
  const telefonoPrueba = (config.whatsapp_test_phone ?? '').trim();

  if (modoPrueba && !telefonoPrueba) {
    return Response.json({
      estado: 'error',
      mensaje: 'Modo prueba activo pero whatsapp_test_phone está vacío. No se envía nada.',
    });
  }

  const { data: pendientes, error } = await db.rpc('claim_pending_notifications', { p_limit: 20 });
  if (error) {
    return Response.json({ estado: 'error', mensaje: error.message }, { status: 500 });
  }

  let enviados = 0;
  let fallidos = 0;

  for (const n of pendientes ?? []) {
    // En modo prueba todo va al número del taller, nunca al cliente.
    const destino = modoPrueba ? telefonoPrueba : n.to_phone;
    const texto = modoPrueba
      ? `[PRUEBA — iba a ${n.to_phone}]\n\n${n.body}`
      : n.body;

    const fallo = !destino
      ? 'El cliente no tiene teléfono cargado.'
      : await enviar(destino, texto);

    if (fallo) {
      await db.rpc('mark_notification_failed', { p_id: n.id, p_error: fallo });
      fallidos++;
    } else {
      await db.rpc('mark_notification_sent', { p_id: n.id });
      enviados++;
    }
  }

  return Response.json({
    estado: 'ok',
    modoPrueba,
    tomados: pendientes?.length ?? 0,
    enviados,
    fallidos,
  });
});
