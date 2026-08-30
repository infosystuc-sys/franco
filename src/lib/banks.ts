import { supabase } from '@/src/lib/supabase';

/**
 * Catálogo de bancos: código (BCRA) + nombre, para buscar al cargar un
 * cheque. El cheque en sí sigue guardando el banco como texto libre —
 * este catálogo solo alimenta las sugerencias del campo.
 */
export interface Bank {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export interface BankInput {
  code: string;
  name: string;
  active: boolean;
}

function mapBank(row: any): Bank {
  return { id: row.id, code: row.code, name: row.name, active: row.active };
}

export async function fetchBanks(onlyActive = false): Promise<Bank[]> {
  let query = supabase.from('banks').select('id, code, name, active').order('name');
  if (onlyActive) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapBank);
}

export async function createBank(input: BankInput): Promise<Bank> {
  const { data, error } = await supabase
    .from('banks')
    .insert({ code: input.code.trim(), name: input.name.trim(), active: input.active })
    .select('id, code, name, active')
    .single();
  if (error) throw error;
  return mapBank(data);
}

export async function updateBank(id: string, input: BankInput): Promise<Bank> {
  const { data, error } = await supabase
    .from('banks')
    .update({ code: input.code.trim(), name: input.name.trim(), active: input.active })
    .eq('id', id)
    .select('id, code, name, active')
    .single();
  if (error) throw error;
  return mapBank(data);
}

export async function deleteBank(id: string): Promise<void> {
  const { error } = await supabase.from('banks').delete().eq('id', id);
  if (error) throw error;
}

export function describeBankError(message: string): string {
  if (message.includes('banks_code_key')) return 'Ya hay un banco cargado con ese código.';
  return message;
}
