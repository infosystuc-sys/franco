import { supabase } from '@/src/lib/supabase';

/**
 * Cheques de terceros.
 *
 * Un cheque no es un importe: es un objeto con ciclo de vida.
 *
 *   EN CARTERA ─┬─ Depositar → DEPOSITADO ─┬→ ACREDITADO
 *               │                          └→ RECHAZADO
 *               └─ Endosar   → ENDOSADO
 *
 * La plata entra al banco al ACREDITAR, no al depositar: hasta que el banco
 * no confirma, los fondos no existen y el valor sigue en riesgo, así que
 * sigue contando en la cartera.
 *
 * El saldo de la cartera NO sale de esta tabla sino de las partidas, como
 * cualquier otro medio de pago. Lo que hacen estas operaciones es generar
 * esas partidas manteniendo el estado del cheque consistente con ellas.
 */

export type CheckStatus =
  | 'EN_CARTERA'
  | 'DEPOSITADO'
  | 'ACREDITADO'
  | 'RECHAZADO'
  | 'ENDOSADO';

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  EN_CARTERA: 'En cartera',
  DEPOSITADO: 'Depositado',
  ACREDITADO: 'Acreditado',
  RECHAZADO: 'Rechazado',
  ENDOSADO: 'Endosado',
};

export const CHECK_STATUS_BADGE: Record<CheckStatus, string> = {
  EN_CARTERA: 'bg-blue-100 text-blue-700',
  DEPOSITADO: 'bg-orange-100 text-orange-700',
  ACREDITADO: 'bg-green-100 text-green-700',
  RECHAZADO: 'bg-red-100 text-danger',
  ENDOSADO: 'bg-gray-100 text-gray-700',
};

export const CHECK_STATUS_STRIP: Record<CheckStatus, string> = {
  EN_CARTERA: '#2b6cb0',
  DEPOSITADO: '#e07b1a',
  ACREDITADO: '#2e7d32',
  RECHAZADO: '#c62828',
  ENDOSADO: '#9a9a9a',
};

export const CHECK_STATUSES = Object.keys(CHECK_STATUS_LABELS) as CheckStatus[];

/**
 * Qué se puede hacer con un cheque según su estado. Vive acá y no repartido
 * por la pantalla porque son las mismas reglas que valida la base: tenerlas
 * en un solo lugar evita ofrecer un botón que después va a fallar.
 */
export function canDeposit(status: CheckStatus): boolean {
  return status === 'EN_CARTERA';
}
export function canEndorse(status: CheckStatus): boolean {
  return status === 'EN_CARTERA';
}
export function canCredit(status: CheckStatus): boolean {
  return status === 'DEPOSITADO';
}
export function canReject(status: CheckStatus): boolean {
  return status === 'DEPOSITADO' || status === 'ACREDITADO';
}

/** Un cheque cuyo valor todavía está en la cartera del taller. */
export function isInWallet(status: CheckStatus): boolean {
  return status === 'EN_CARTERA' || status === 'DEPOSITADO' || status === 'RECHAZADO';
}

export interface ThirdPartyCheck {
  id: string;
  number: string;
  bankName: string;
  drawer: string | null;
  issueDate: string | null;
  dueDate: string;
  amount: number;
  status: CheckStatus;
  depositedToId: string | null;
  depositedToName: string | null;
  depositedAt: string | null;
  endorsedToSupplierId: string | null;
  endorsedToSupplierName: string | null;
  rejectedReason: string | null;
  notes: string | null;
}

const SELECT =
  `id, number, bank_name, drawer, issue_date, due_date, amount, status,
   deposited_to_id, deposited_at, endorsed_to_supplier_id, rejected_reason, notes,
   bank:payment_methods(name), supplier:suppliers(name)`;

function mapCheck(row: any): ThirdPartyCheck {
  return {
    id: row.id,
    number: row.number,
    bankName: row.bank_name,
    drawer: row.drawer,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    amount: Number(row.amount),
    status: row.status,
    depositedToId: row.deposited_to_id,
    depositedToName: row.bank?.name ?? null,
    depositedAt: row.deposited_at,
    endorsedToSupplierId: row.endorsed_to_supplier_id,
    endorsedToSupplierName: row.supplier?.name ?? null,
    rejectedReason: row.rejected_reason,
    notes: row.notes,
  };
}

export async function fetchChecks(): Promise<ThirdPartyCheck[]> {
  const { data, error } = await supabase
    .from('third_party_checks')
    .select(SELECT)
    .order('due_date', { ascending: true });

  if (error) throw error;
  return (data ?? []).map(mapCheck);
}

export interface CheckInput {
  number: string;
  bankName: string;
  drawer: string;
  issueDate: string;
  dueDate: string;
  amount: string;
  receivedDate: string;
  conceptId: string;
  notes: string;
}

export const EMPTY_CHECK_FORM: CheckInput = {
  number: '',
  bankName: '',
  drawer: '',
  issueDate: '',
  dueDate: '',
  amount: '',
  receivedDate: '',
  conceptId: '',
  notes: '',
};

export async function receiveCheck(input: CheckInput): Promise<{ id: string; movementNumber: string }> {
  const { data, error } = await supabase.rpc('receive_check', {
    p_check: {
      number: input.number.trim(),
      bank_name: input.bankName.trim(),
      drawer: input.drawer.trim() || null,
      issue_date: input.issueDate || null,
      due_date: input.dueDate,
      amount: Number(input.amount),
      received_date: input.receivedDate,
      concept_id: input.conceptId || null,
      notes: input.notes.trim() || null,
    },
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió el cheque registrado.');
  return { id: row.check_id, movementNumber: row.check_movement_number };
}

export async function depositCheck(id: string, bankMethodId: string, date: string): Promise<void> {
  const { error } = await supabase.rpc('deposit_check', {
    p_check_id: id,
    p_bank_method_id: bankMethodId,
    p_date: date,
  });
  if (error) throw error;
}

export async function creditCheck(id: string, date: string): Promise<void> {
  const { error } = await supabase.rpc('credit_check', { p_check_id: id, p_date: date });
  if (error) throw error;
}

export async function rejectCheck(id: string, reason: string, date: string): Promise<void> {
  const { error } = await supabase.rpc('reject_check', {
    p_check_id: id,
    p_reason: reason,
    p_date: date,
  });
  if (error) throw error;
}

/** Endosa el cheque a un proveedor. Devuelve el número del comprobante de egreso generado en Tesorería. */
export async function endorseCheck(id: string, supplierId: string, date: string): Promise<string> {
  const { data, error } = await supabase.rpc('endorse_check', {
    p_check_id: id,
    p_supplier_id: supplierId,
    p_date: date,
  });
  if (error) throw error;
  return data as string;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeCheckError(message: string): string {
  if (message.includes('third_party_checks_sin_duplicados')) {
    return 'Ese cheque ya está cargado: mismo número y mismo banco. Buscalo en el listado antes de volver a cargarlo.';
  }
  if (message.includes('cartera de cheques cargada')) {
    return message;
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de cheques en la base (supabase/treasury-checks.sql).';
  }
  return message;
}
