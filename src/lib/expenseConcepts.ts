import { supabase } from '@/src/lib/supabase';

/**
 * Conceptos de gasto: el padrón que clasifica las compras sin stock
 * (fletes, energía, honorarios). Existe para poder agrupar el gasto por
 * tipo, que con renglones de texto libre no se puede hacer nunca.
 *
 * El comprobante admite igual renglones de texto libre, para el gasto que no
 * encaja en ninguno.
 */

export interface ExpenseConcept {
  id: string;
  name: string;
  active: boolean;
}

export interface ExpenseConceptInput {
  name: string;
  active: boolean;
}

const SELECT = 'id, name, active';

function mapConcept(row: any): ExpenseConcept {
  return { id: row.id, name: row.name, active: row.active };
}

export async function fetchExpenseConcepts(onlyActive = false): Promise<ExpenseConcept[]> {
  let query = supabase.from('expense_concepts').select(SELECT).order('name');
  if (onlyActive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapConcept);
}

export async function createExpenseConcept(input: ExpenseConceptInput): Promise<ExpenseConcept> {
  const { data, error } = await supabase
    .from('expense_concepts')
    .insert({ name: input.name.trim(), active: input.active })
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapConcept(data);
}

export async function updateExpenseConcept(
  id: string,
  input: ExpenseConceptInput
): Promise<ExpenseConcept> {
  const { data, error } = await supabase
    .from('expense_concepts')
    .update({ name: input.name.trim(), active: input.active })
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapConcept(data);
}

export async function deleteExpenseConcept(id: string): Promise<void> {
  const { error } = await supabase.from('expense_concepts').delete().eq('id', id);
  if (error) throw error;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeExpenseConceptError(message: string, name: string): string {
  if (message.includes('expense_concepts_name_key') || message.includes('duplicate key')) {
    return `Ya existe un concepto llamado "${name}".`;
  }
  if (message.includes('foreign key') || message.includes('violates')) {
    return `No se puede eliminar "${name}" porque ya se usó en algún comprobante. Desactivalo en su lugar.`;
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de compras en la base (supabase/purchase-catalogs.sql).';
  }
  return message;
}
