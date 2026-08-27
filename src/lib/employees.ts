import { supabase } from '@/src/lib/supabase';

/** Cargo dentro del sistema. No es el nivel de acceso (eso es `role`, admin/operario): administrativo y dueño acceden igual, solo cambia la etiqueta. */
export type Cargo = 'operario' | 'administrativo' | 'dueño';

export const CARGO_LABELS: Record<Cargo, string> = {
  operario: 'Operario',
  administrativo: 'Administrativo',
  dueño: 'Dueño',
};

export const CARGOS: Cargo[] = ['operario', 'administrativo', 'dueño'];

export interface Employee {
  id: string;
  name: string;
  role: string | null;
  phone: string | null;
  active: boolean;
  profileId: string | null;
  email: string | null;
  /** Cargo del acceso al sistema. null si todavía no tiene acceso creado. */
  cargo: Cargo | null;
}

export interface EmployeeInput {
  name: string;
  role: string;
  phone: string;
  active: boolean;
}

// La política de fila de profiles solo deja ver el propio perfil (auth.uid() = id):
// un admin mirando a otro empleado recibe profile.email en null aunque el vínculo
// exista. Por eso el acceso se decide con profileId, nunca con email.
function mapEmployee(row: any): Employee {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    phone: row.phone,
    active: row.active,
    profileId: row.profile_id,
    email: row.profile?.email ?? null,
    cargo: (row.profile?.position as Cargo) ?? null,
  };
}

const SELECT = 'id, name, role, phone, active, profile_id, profile:profiles(email, position)';

export async function fetchEmployees(onlyActive = false): Promise<Employee[]> {
  let query = supabase.from('employees').select(SELECT).order('name');
  if (onlyActive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapEmployee);
}

export async function createEmployee(input: EmployeeInput): Promise<Employee> {
  const { data, error } = await supabase
    .from('employees')
    .insert(input)
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapEmployee(data);
}

export async function updateEmployee(id: string, input: EmployeeInput): Promise<Employee> {
  const { data, error } = await supabase
    .from('employees')
    .update(input)
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapEmployee(data);
}

export async function deleteEmployee(id: string): Promise<void> {
  const { error } = await supabase.from('employees').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Da de alta el acceso al sistema de un empleado que todavía no lo tiene.
 * Crear el usuario necesita la clave de servicio, que no puede viajar al
 * navegador: por eso lo hace la Edge Function `gestionar-empleado` del lado
 * del servidor, usando la sesión del admin que invoca.
 */
export async function darAcceso(
  employeeId: string,
  usuario: string,
  password: string,
  cargo: Cargo
): Promise<void> {
  const { error } = await supabase.functions.invoke('gestionar-empleado', {
    body: { accion: 'crear', employeeId, usuario, password, cargo },
  });
  if (error) throw new Error(await describeFunctionError(error));
}

/** Cambia la contraseña de un empleado que ya tiene acceso creado. */
export async function cambiarClave(employeeId: string, password: string): Promise<void> {
  const { error } = await supabase.functions.invoke('gestionar-empleado', {
    body: { accion: 'clave', employeeId, password },
  });
  if (error) throw new Error(await describeFunctionError(error));
}

/**
 * Cambia el cargo (y con eso el rol) de un empleado que ya tiene acceso.
 * La propia función rechaza dejar el sistema sin ningún admin.
 */
export async function cambiarCargo(employeeId: string, cargo: Cargo): Promise<void> {
  const { error } = await supabase.functions.invoke('gestionar-empleado', {
    body: { accion: 'cargo', employeeId, cargo },
  });
  if (error) throw new Error(await describeFunctionError(error));
}

/**
 * La función siempre responde JSON con `{ error: '<mensaje accionable>' }`
 * cuando falla, pero el cliente de Supabase no lo expone en `error.message`
 * (que queda en un genérico "Edge Function returned a non-2xx status code").
 * El cuerpo real viaja en `error.context`, la respuesta HTTP cruda.
 */
async function describeFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error) return String(body.error);
    } catch {
      // El cuerpo no era JSON: se sigue con el mensaje genérico de abajo.
    }
  }
  return error instanceof Error ? error.message : 'No se pudo completar la operación.';
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeEmployeeError(message: string): string {
  if (
    message.includes('work_orders_employee_id_fkey') ||
    message.includes('foreign key') ||
    message.includes('viola la llave')
  ) {
    return 'No se puede eliminar: el empleado tiene órdenes asignadas. Es el registro ' +
      'de quién hizo cada trabajo. Marcalo como inactivo en lugar de borrarlo.';
  }
  return message;
}
