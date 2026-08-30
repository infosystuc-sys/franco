import { supabase } from '@/src/lib/supabase';

/**
 * Cargo dentro del sistema. No es exactamente el nivel de acceso (eso es
 * `role`): administrativo y dueño acceden igual (ambos son role='admin'),
 * solo cambia la etiqueta. Contador es la excepción — tiene su propio role
 * ('contador'), de solo lectura sobre informes impositivos.
 */
export type Cargo = 'operario' | 'administrativo' | 'dueño' | 'contador';

export const CARGO_LABELS: Record<Cargo, string> = {
  operario: 'Operario',
  administrativo: 'Administrativo',
  dueño: 'Dueño',
  contador: 'Contador',
};

export const CARGOS: Cargo[] = ['operario', 'administrativo', 'dueño', 'contador'];

/** Lugar de trabajo del operario. Solo tiene sentido para cargo='operario'. */
export type Workplace = 'Laboratorio 1' | 'Laboratorio 2' | 'Playa';

export const WORKPLACES: Workplace[] = ['Laboratorio 1', 'Laboratorio 2', 'Playa'];

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
  workplace: Workplace | null;
}

export interface EmployeeInput {
  name: string;
  role: string;
  phone: string;
  active: boolean;
}

/** Lo que se pide al dar de alta un usuario: el registro y el acceso, en un solo paso. */
export interface NewUserInput extends EmployeeInput {
  cargo: Cargo;
  /** Solo aplica si cargo !== 'operario'. Sin especificar, la base lo deja en true. */
  verHistorial?: boolean;
  /** Solo aplica si cargo === 'operario'. */
  workplace?: Workplace | null;
}

// La política de fila de profiles deja ver todos los perfiles a un admin
// (además del propio): ver profiles-position.sql, "admin read all profiles".
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
    workplace: (row.workplace as Workplace) ?? null,
  };
}

const SELECT = 'id, name, role, phone, active, profile_id, workplace, profile:profiles(email, position)';

export async function fetchEmployees(onlyActive = false): Promise<Employee[]> {
  let query = supabase.from('employees').select(SELECT).order('name');
  if (onlyActive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapEmployee);
}

/** Solo los operarios activos: es lo que puede asignarse a una orden de trabajo. */
export async function fetchOperarios(): Promise<Employee[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, name, role, phone, active, profile_id, workplace, profile:profiles!inner(email, position)')
    .eq('active', true)
    .eq('profile.position', 'operario')
    .order('name');
  if (error) throw error;
  return (data ?? []).map(mapEmployee);
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
 * Alta en un solo paso: crea el usuario y le da acceso al sistema en el
 * mismo llamado. Usuario y contraseña inicial los arma el servidor (ver
 * gestionar-empleado) — acá solo se manda lo que el admin eligió.
 */
export async function crearUsuario(input: NewUserInput): Promise<{ usuario: string }> {
  const { data, error } = await supabase.functions.invoke('gestionar-empleado', {
    body: { accion: 'crearUsuario', ...input },
  });
  if (error) throw new Error(await describeFunctionError(error));
  return data as { usuario: string };
}

/**
 * Da de alta el acceso al sistema de un usuario que ya existe pero todavía
 * no lo tiene (caso raro: la creación normal ya incluye el acceso). Queda
 * como camino de recuperación desde la pantalla de edición.
 */
export async function darAcceso(
  employeeId: string,
  cargo: Cargo,
  options?: { verHistorial?: boolean; workplace?: Workplace | null }
): Promise<{ usuario: string }> {
  const { data, error } = await supabase.functions.invoke('gestionar-empleado', {
    body: { accion: 'crear', employeeId, cargo, ...options },
  });
  if (error) throw new Error(await describeFunctionError(error));
  return data as { usuario: string };
}

/** Cambia la contraseña de un usuario que ya tiene acceso creado. */
export async function cambiarClave(employeeId: string, password: string): Promise<void> {
  const { error } = await supabase.functions.invoke('gestionar-empleado', {
    body: { accion: 'clave', employeeId, password },
  });
  if (error) throw new Error(await describeFunctionError(error));
}

/**
 * Cambia el cargo (y con eso el rol) de un usuario que ya tiene acceso, y
 * de paso su lugar de trabajo si el cargo nuevo es operario. La propia
 * función rechaza dejar el sistema sin ningún admin.
 */
export async function cambiarCargo(employeeId: string, cargo: Cargo, workplace?: Workplace | null): Promise<void> {
  const { error } = await supabase.functions.invoke('gestionar-empleado', {
    body: { accion: 'cargo', employeeId, cargo, workplace },
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
