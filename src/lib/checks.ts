import { supabase } from '@/src/lib/supabase';
import { leerNumero } from '@/src/lib/numeros';

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
  | 'ENDOSADO'
  | 'ANULADO';

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  EN_CARTERA: 'En cartera',
  DEPOSITADO: 'Depositado',
  ACREDITADO: 'Acreditado',
  RECHAZADO: 'Rechazado',
  ENDOSADO: 'Endosado',
  ANULADO: 'Anulado',
};

export const CHECK_STATUS_BADGE: Record<CheckStatus, string> = {
  EN_CARTERA: 'bg-blue-100 text-blue-700',
  DEPOSITADO: 'bg-orange-100 text-orange-700',
  ACREDITADO: 'bg-green-100 text-green-700',
  RECHAZADO: 'bg-red-100 text-danger',
  ENDOSADO: 'bg-gray-100 text-gray-700',
  ANULADO: 'bg-gray-100 text-gray-500 line-through',
};

export const CHECK_STATUS_STRIP: Record<CheckStatus, string> = {
  EN_CARTERA: '#2b6cb0',
  DEPOSITADO: '#e07b1a',
  ACREDITADO: '#2e7d32',
  RECHAZADO: '#c62828',
  ENDOSADO: '#9a9a9a',
  ANULADO: '#cfcfcf',
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

/** Cómo se lo nombra, según sea de papel o electrónico. */
export function tipoDeCheque(electronico: boolean): string {
  return electronico ? 'Electrónico' : 'Físico';
}

export interface ThirdPartyCheck {
  id: string;
  /** eCheq: se maneja desde el home banking, no en la mano. */
  electronico: boolean;
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
  /** Un cheque también se puede entregar de vuelto en una cobranza — ahí el destinatario es un cliente, no un proveedor. */
  endorsedToCustomerId: string | null;
  endorsedToCustomerName: string | null;
  rejectedReason: string | null;
  notes: string | null;
  /** Correlativo propio del taller, para encontrarlo rápido. Null si falta la migración. */
  numeroInterno: number | null;
  /** Quién lo trajo, cargado a mano (cheques sueltos). */
  entregadoPor: string | null;
  /** El cliente de la cobranza con la que entró, si entró con una. */
  cobranza: { fullNumber: string; customerName: string } | null;
}

/** Quién entregó el cheque: lo cargado a mano o, si no, el cliente de la cobranza. */
export function quienEntrego(check: ThirdPartyCheck): string | null {
  return check.entregadoPor || check.cobranza?.customerName || null;
}

const SELECT_BASE =
  `id, electronico, number, bank_name, drawer, issue_date, due_date, amount, status,
   deposited_to_id, deposited_at, endorsed_to_supplier_id, endorsed_to_customer_id, rejected_reason, notes,
   bank:payment_methods(name), supplier:suppliers(name), endorsed_customer:customers(name),
   cobranzas:receipt_values(receipt:receipts(full_number, customer_name, status))`;
// Con la migración 20261118 (número interno y quién lo entregó).
const SELECT = `${SELECT_BASE}, numero_interno, entregado_por`;

/** Si falta la migración, las columnas nuevas no existen: se lee sin ellas. */
function faltanColumnasNuevas(error: { message?: string } | null): boolean {
  return !!error && /numero_interno|entregado_por/.test(error.message ?? '');
}

function mapCheck(row: any): ThirdPartyCheck {
  return {
    id: row.id,
    electronico: row.electronico ?? false,
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
    endorsedToCustomerId: row.endorsed_to_customer_id,
    endorsedToCustomerName: row.endorsed_customer?.name ?? null,
    rejectedReason: row.rejected_reason,
    notes: row.notes,
    numeroInterno: row.numero_interno ?? null,
    entregadoPor: row.entregado_por ?? null,
    cobranza: (() => {
      const vigente = (row.cobranzas ?? []).find((c: any) => c.receipt && c.receipt.status !== 'ANULADO');
      return vigente ? { fullNumber: vigente.receipt.full_number, customerName: vigente.receipt.customer_name } : null;
    })(),
  };
}

export async function fetchChecks(): Promise<ThirdPartyCheck[]> {
  let { data, error }: { data: any[] | null; error: { message?: string } | null } = await supabase
    .from('third_party_checks')
    .select(SELECT)
    .order('due_date', { ascending: true });
  if (faltanColumnasNuevas(error)) {
    ({ data, error } = await supabase
      .from('third_party_checks')
      .select(SELECT_BASE)
      .order('due_date', { ascending: true }));
  }

  if (error) throw error;
  return (data ?? []).map(mapCheck);
}

export interface CheckInput {
  electronico: boolean;
  number: string;
  bankName: string;
  drawer: string;
  issueDate: string;
  dueDate: string;
  amount: string;
  receivedDate: string;
  conceptId: string;
  notes: string;
  entregadoPor: string;
}

export const EMPTY_CHECK_FORM: CheckInput = {
  electronico: false,
  number: '',
  bankName: '',
  drawer: '',
  issueDate: '',
  dueDate: '',
  amount: '',
  receivedDate: '',
  conceptId: '',
  notes: '',
  entregadoPor: '',
};

export async function receiveCheck(
  input: CheckInput
): Promise<{ id: string; movementNumber: string; numeroInterno: number | null }> {
  const { data, error } = await supabase.rpc('receive_check', {
    p_check: {
      electronico: input.electronico,
      number: input.number.trim(),
      bank_name: input.bankName.trim(),
      drawer: input.drawer.trim() || null,
      issue_date: input.issueDate || null,
      due_date: input.dueDate,
      amount: leerNumero(input.amount) ?? 0,
      received_date: input.receivedDate,
      concept_id: input.conceptId || null,
      notes: input.notes.trim() || null,
    },
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió el cheque registrado.');
  const id = row.check_id as string;

  // Quién lo entregó y el número interno que le tocó. Si falta la migración
  // el cheque ya quedó cargado: no se falla por esto.
  let numeroInterno: number | null = null;
  if (input.entregadoPor.trim()) {
    await supabase.rpc('asignar_entregado_por', { p_check_id: id, p_nombre: input.entregadoPor.trim() });
  }
  const { data: nro } = await supabase.from('third_party_checks').select('numero_interno').eq('id', id).maybeSingle();
  numeroInterno = (nro as any)?.numero_interno ?? null;
  return { id, movementNumber: row.check_movement_number, numeroInterno };
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

// ===========================================================================
// Carga inicial: los cheques que había en cartera al empezar a usar la app
// ===========================================================================

export interface ChequeInicialInput {
  electronico: boolean;
  number: string;
  bankName: string;
  drawer: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  notes: string;
}

/** Los cheques de la carga inicial, para revisarlos y borrar los cargados por error. */
export async function fetchChequesIniciales(): Promise<ThirdPartyCheck[]> {
  let { data, error }: { data: any[] | null; error: { message?: string } | null } = await supabase
    .from('third_party_checks')
    .select(SELECT)
    .eq('saldo_inicial', true)
    .order('due_date', { ascending: true });
  if (faltanColumnasNuevas(error)) {
    ({ data, error } = await supabase
      .from('third_party_checks')
      .select(SELECT_BASE)
      .eq('saldo_inicial', true)
      .order('due_date', { ascending: true }));
  }
  if (error) throw error;
  return (data ?? []).map(mapCheck);
}

/** Carga todos juntos, todo o nada. Devuelve cuántos entraron. */
export async function cargarChequesIniciales(fecha: string, cheques: ChequeInicialInput[]): Promise<number> {
  const { data, error } = await supabase.rpc('cargar_cheques_iniciales', {
    p_fecha: fecha,
    p_cheques: cheques.map((c) => ({
      electronico: c.electronico,
      number: c.number.trim(),
      bank_name: c.bankName.trim(),
      drawer: c.drawer.trim() || null,
      issue_date: c.issueDate || null,
      due_date: c.dueDate,
      amount: c.amount,
      notes: c.notes.trim() || null,
    })),
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function borrarChequeInicial(id: string): Promise<void> {
  const { error } = await supabase.rpc('borrar_cheque_inicial', { p_check_id: id });
  if (error) throw error;
}

// ===========================================================================
// Corregir o eliminar un cheque cargado
// ===========================================================================

export interface CheckEdit {
  electronico: boolean;
  number: string;
  bankName: string;
  drawer: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  notes: string;
  entregadoPor: string;
}

/**
 * Corrige los datos de un cheque. El importe solo cambia si sigue en cartera y
 * no entró con una cobranza: la base rehace su ingreso de caja.
 */
export async function modificarCheque(id: string, datos: CheckEdit): Promise<void> {
  const { error } = await supabase.rpc('modificar_cheque', {
    p_check_id: id,
    p_datos: {
      electronico: datos.electronico,
      number: datos.number.trim(),
      bank_name: datos.bankName.trim(),
      drawer: datos.drawer.trim() || null,
      issue_date: datos.issueDate || null,
      due_date: datos.dueDate,
      amount: datos.amount,
      notes: datos.notes.trim() || null,
      entregado_por: datos.entregadoPor.trim() || null,
    },
  });
  if (error) throw error;
}

/**
 * Elimina un cheque en cartera cargado por error: se anula su ingreso de caja.
 * Si entró con una cobranza y hay otro igual cargado suelto, se queda uno
 * solo (la cobranza pasa al otro). Devuelve 'ELIMINADO', 'ANULADO' o 'UNIFICADO'.
 */
export async function eliminarCheque(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('eliminar_cheque', { p_check_id: id });
  if (error) throw error;
  return String(data ?? 'ELIMINADO');
}

/** Otro cheque con el mismo número e importe: el candidato a duplicado. */
export function chequeGemelo(check: ThirdPartyCheck, todos: ThirdPartyCheck[]): ThirdPartyCheck | null {
  return (
    todos.find(
      (c) =>
        c.id !== check.id &&
        c.status !== 'ANULADO' &&
        c.number.trim() === check.number.trim() &&
        Math.abs(c.amount - check.amount) < 0.005
    ) ?? null
  );
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeCheckError(message: string): string {
  if (message.includes('third_party_checks_sin_duplicados')) {
    return 'Ese cheque ya está cargado: mismo número y mismo banco. Buscalo en el listado antes de volver a cargarlo.';
  }
  if (message.includes('cartera de cheques cargada')) {
    return message;
  }
  if (/asignar_entregado_por|numero_interno|entregado_por|p_conservar/.test(message)) {
    return 'Falta correr la migración 20261118_cheques_numero_interno_y_entregado_por.sql en Supabase.';
  }
  if (/modificar_cheque|eliminar_cheque/.test(message)) {
    return 'Falta correr las migraciones 20261113_modificar_y_eliminar_cheques.sql y 20261118_cheques_numero_interno_y_entregado_por.sql en Supabase.';
  }
  if (message.includes('saldo_inicial') || message.includes('cargar_cheques_iniciales') || message.includes('borrar_cheque_inicial')) {
    return 'Falta correr la migración de la carga inicial de cheques (supabase/migrations/20261102_cheques_iniciales.sql).';
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de cheques en la base (supabase/treasury-checks.sql).';
  }
  return message;
}
