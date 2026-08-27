import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

/*
  Alta de usuarios de empleados, cambio de contraseña y cambio de cargo,
  hecho desde el servidor.

  Crear un usuario en Supabase Auth, cambiarle la contraseña o tocar
  profiles.role necesita la clave de servicio, que no puede viajar al
  navegador. Por eso esto vive acá: el navegador manda la acción con la
  sesión del admin, y esta función hace el trabajo con la clave de servicio
  de su lado.

  A diferencia del despachador de WhatsApp (que no tiene sesión porque lo
  llama el cron), acá SÍ hay un usuario detrás de cada llamado — y puede ser
  cualquier empleado con sesión iniciada, no solo el admin. La comprobación
  de rol de abajo es la única barrera entre "cambiar mi propia clave" y
  "fabricarme una cuenta de admin", así que se hace antes que cualquier otra
  cosa y falla cerrada: ante cualquier duda sobre el rol, se rechaza. No
  alcanza con que el token sea válido — la propia anon key es un JWT
  correctamente firmado y pasaría la verificación de la plataforma
  (verify_jwt) sin representar a ningún usuario real.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

/*
  Al despachador lo llama el cron: nunca hace falta CORS. A este lo llama el
  navegador desde otro origen, y como el pedido lleva Authorization y
  Content-Type: application/json, el browser manda un preflight OPTIONS antes
  del POST real. Sin estos encabezados, el preflight falla y el POST ni sale.
*/
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

type Autorizacion = { estado: 'admin'; userId: string } | { estado: 'sin-sesion' | 'sin-permiso' };

/*
  Confirma el rol consultando `profiles` con la clave de servicio, sin pasar
  por RLS (que podría estar mal configurada y no es donde debe vivir esta
  garantía). Cualquier caso ambiguo —sin token, token que no resuelve a un
  usuario, perfil inexistente— cae en "sin-sesion" y se rechaza igual que un
  token inválido. Solo un perfil confirmado con role = 'admin' pasa.
*/
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

/** Arma el identificador de Auth: sin arroba, el empleado no necesita casilla real. */
function emailDesdeUsuario(usuario: string): string {
  const limpio = usuario.trim();
  return limpio.includes('@') ? limpio : `${limpio}@taller.local`;
}

/** Traduce los errores más comunes de Auth a un mensaje que sirva en pantalla. */
function describirFalla(mensaje: string): string {
  if (/already been registered|already registered|duplicate/i.test(mensaje)) {
    return 'Ese usuario ya existe.';
  }
  if (/password/i.test(mensaje)) {
    return `Contraseña inválida: ${mensaje}`;
  }
  return mensaje;
}

type Cargo = 'operario' | 'administrativo' | 'dueño';
const CARGOS: Cargo[] = ['operario', 'administrativo', 'dueño'];

/** operario -> role 'operario'; administrativo y dueño -> 'admin', mismo nivel de acceso, solo cambia el cargo mostrado. */
function rolDesdeCargo(cargo: Cargo): 'admin' | 'operario' {
  return cargo === 'operario' ? 'operario' : 'admin';
}

async function crear(body: Record<string, unknown>): Promise<Response> {
  const employeeId = String(body.employeeId ?? '');
  const usuario = String(body.usuario ?? '');
  const password = String(body.password ?? '');
  const cargo = (body.cargo as Cargo) ?? 'operario';
  if (!employeeId || !usuario || !password) {
    return json({ error: 'Faltan employeeId, usuario o password.' }, 400);
  }
  if (!CARGOS.includes(cargo)) {
    return json({ error: `Cargo inválido: ${cargo}` }, 400);
  }

  const { data: empleado, error: errorEmpleado } = await db
    .from('employees')
    .select('id, profile_id')
    .eq('id', employeeId)
    .single();

  if (errorEmpleado || !empleado) {
    return json({ error: 'No se encontró el empleado.' }, 404);
  }
  if (empleado.profile_id) {
    return json({ error: 'Ese empleado ya tiene acceso.' }, 409);
  }

  const email = emailDesdeUsuario(usuario);

  const { data: creado, error: errorCrear } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // el disparador on_auth_user_created arma el profile con role 'operario'; lo ajustamos abajo si el cargo es otro
  });

  if (errorCrear || !creado.user) {
    return json({ error: describirFalla(errorCrear?.message ?? 'No se pudo crear el usuario.') }, 400);
  }

  // El trigger ya insertó el profile con role='operario' y position='operario'
  // por default. Si el cargo elegido es otro, lo actualizamos en el mismo paso.
  const { error: errorCargo } = await db
    .from('profiles')
    .update({ role: rolDesdeCargo(cargo), position: cargo })
    .eq('id', creado.user.id);

  if (errorCargo) {
    await db.auth.admin.deleteUser(creado.user.id);
    return json({ error: `No se pudo asignar el cargo: ${errorCargo.message}` }, 500);
  }

  const { error: errorVinculo } = await db
    .from('employees')
    .update({ profile_id: creado.user.id })
    .eq('id', employeeId);

  if (errorVinculo) {
    // El usuario de Auth quedó creado pero sin vincular al empleado: mejor
    // borrarlo que dejar un usuario huérfano que nadie puede usar ni
    // reintentar crear (el email ya estaría tomado).
    await db.auth.admin.deleteUser(creado.user.id);
    return json({ error: `No se pudo vincular el usuario: ${errorVinculo.message}` }, 500);
  }

  return json({ estado: 'ok', email });
}

async function cambiarClave(body: Record<string, unknown>): Promise<Response> {
  const employeeId = String(body.employeeId ?? '');
  const password = String(body.password ?? '');
  if (!employeeId || !password) {
    return json({ error: 'Faltan employeeId o password.' }, 400);
  }

  const { data: empleado, error: errorEmpleado } = await db
    .from('employees')
    .select('profile_id')
    .eq('id', employeeId)
    .single();

  if (errorEmpleado || !empleado?.profile_id) {
    return json({ error: 'Ese empleado todavía no tiene acceso creado.' }, 404);
  }

  const { error: errorClave } = await db.auth.admin.updateUserById(empleado.profile_id, { password });
  if (errorClave) {
    return json({ error: describirFalla(errorClave.message) }, 400);
  }

  return json({ estado: 'ok' });
}

/*
  Cambia el cargo (y con eso, el rol) de un usuario que ya tiene acceso.
  Falla cerrada contra el auto-bloqueo: si el cambio dejaría el sistema sin
  ningún admin —te bajás vos mismo siendo el último, o bajás al último que
  queda— se rechaza. Recuperarlo a mano después requeriría entrar
  directo a la base, así que es más barato prevenirlo acá.
*/
async function cambiarCargo(body: Record<string, unknown>, llamadoPor: string): Promise<Response> {
  const employeeId = String(body.employeeId ?? '');
  const cargo = body.cargo as Cargo;
  if (!employeeId || !cargo) {
    return json({ error: 'Faltan employeeId o cargo.' }, 400);
  }
  if (!CARGOS.includes(cargo)) {
    return json({ error: `Cargo inválido: ${cargo}` }, 400);
  }

  const { data: empleado, error: errorEmpleado } = await db
    .from('employees')
    .select('profile_id')
    .eq('id', employeeId)
    .single();

  if (errorEmpleado || !empleado?.profile_id) {
    return json({ error: 'Ese empleado todavía no tiene acceso creado.' }, 404);
  }

  const rolNuevo = rolDesdeCargo(cargo);

  const { data: perfilActual, error: errorPerfilActual } = await db
    .from('profiles')
    .select('role')
    .eq('id', empleado.profile_id)
    .single();

  if (errorPerfilActual || !perfilActual) {
    return json({ error: 'No se encontró el perfil de ese usuario.' }, 404);
  }

  // La guarda solo aplica si esto es una democión real (admin -> operario).
  // Sin este chequeo, volver a guardar el mismo cargo de un operario con el
  // único admin del sistema todavía activo rechazaba un cambio que ni
  // siquiera tocaba una cuenta de admin.
  const esDemocion = perfilActual.role === 'admin' && rolNuevo === 'operario';

  if (esDemocion) {
    const { count } = await db
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin');

    const esUnicoAdmin = (count ?? 0) <= 1;
    const seBajaAsiMismo = empleado.profile_id === llamadoPor;

    if (esUnicoAdmin) {
      return json({ error: 'No se puede: es el único admin que queda. Ascendé a otro usuario antes de bajarlo.' }, 409);
    }
    if (seBajaAsiMismo) {
      return json({ error: 'No podés bajarte tu propio cargo. Pedile a otro admin que lo haga.' }, 409);
    }
  }

  const { error: errorUpdate } = await db
    .from('profiles')
    .update({ role: rolNuevo, position: cargo })
    .eq('id', empleado.profile_id);

  if (errorUpdate) {
    return json({ error: errorUpdate.message }, 500);
  }

  return json({ estado: 'ok' });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Método no permitido.' }, 405);
  }

  // Primero que nada, antes de tocar el cuerpo del pedido: sin esto,
  // cualquier empleado con sesión podría fabricarse usuarios propios o ajenos.
  const autorizacion = await verificarAdmin(req);
  if (autorizacion.estado === 'sin-sesion') {
    return json({ error: 'No autorizado.' }, 401);
  }
  if (autorizacion.estado === 'sin-permiso') {
    return json({ error: 'No autorizado.' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Cuerpo inválido: se esperaba JSON.' }, 400);
  }

  if (body.accion === 'crear') return crear(body);
  if (body.accion === 'clave') return cambiarClave(body);
  if (body.accion === 'cargo') return cambiarCargo(body, autorizacion.userId);
  return json({ error: `Acción desconocida: ${String(body.accion)}` }, 400);
});
