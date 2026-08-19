import { supabase } from '@/src/lib/supabase';

export interface Employee {
  id: string;
  name: string;
  role: string | null;
  phone: string | null;
  active: boolean;
  profileId: string | null;
  email: string | null;
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
  };
}

const SELECT = 'id, name, role, phone, active, profile_id, profile:profiles(email)';

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

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeEmployeeError(message: string): string {
  if (message.includes('work_orders_employee_id_fkey') || message.includes('foreign key')) {
    return 'No se puede eliminar: el empleado tiene órdenes asignadas. Es el registro ' +
      'de quién hizo cada trabajo. Marcalo como inactivo en lugar de borrarlo.';
  }
  return message;
}
