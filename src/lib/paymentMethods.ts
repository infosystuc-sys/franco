import { supabase } from '@/src/lib/supabase';
import { nullIfBlank } from '@/src/lib/fiscal';

/**
 * Medios de pago: las cajas, las cuentas bancarias y la cartera de cheques.
 *
 * El tipo no es decorativo, decide el comportamiento: solo un medio de tipo
 * banco puede recibir el depósito de un cheque, y la cartera no se mueve con
 * movimientos sueltos sino desde las operaciones de cheques.
 *
 * El saldo no se guarda en ninguna columna: se calcula como el saldo inicial
 * más la suma de las partidas del medio. Un saldo guardado miente en cuanto
 * algo falla a mitad de camino, y después nadie sabe cuál de los dos números
 * es el bueno.
 */

export type PaymentMethodKind = 'EFECTIVO' | 'BANCO' | 'CARTERA_CHEQUES';

export const PAYMENT_METHOD_KIND_LABELS: Record<PaymentMethodKind, string> = {
  EFECTIVO: 'Efectivo',
  BANCO: 'Banco',
  CARTERA_CHEQUES: 'Cartera de cheques',
};

/** Qué implica cada tipo. Se muestra en el ABM para no tener que saberlo de memoria. */
export const PAYMENT_METHOD_KIND_HELP: Record<PaymentMethodKind, string> = {
  EFECTIVO: 'Una caja física. El saldo sale de los movimientos.',
  BANCO: 'Una cuenta bancaria. Es el único tipo que puede recibir el depósito de un cheque.',
  CARTERA_CHEQUES:
    'Los cheques de terceros en mano. Su saldo se mueve desde la pantalla de Cheques —recibir, acreditar, endosar— y no con movimientos sueltos, así que no lleva saldo inicial.',
};

export const PAYMENT_METHOD_KINDS = Object.keys(PAYMENT_METHOD_KIND_LABELS) as PaymentMethodKind[];

/** Color de la tira lateral por tipo, para distinguirlos de un vistazo. */
export const PAYMENT_METHOD_STRIP: Record<PaymentMethodKind, string> = {
  EFECTIVO: '#2e7d32',
  BANCO: '#2b6cb0',
  CARTERA_CHEQUES: '#7b3fa0',
};

export interface PaymentMethod {
  id: string;
  kind: PaymentMethodKind;
  name: string;
  bankName: string | null;
  accountNumber: string | null;
  cbu: string | null;
  openingBalance: number;
  openingDate: string;
  active: boolean;
}

export interface PaymentMethodInput {
  kind: PaymentMethodKind;
  name: string;
  bankName: string;
  accountNumber: string;
  cbu: string;
  openingBalance: string;
  openingDate: string;
  active: boolean;
}

export const EMPTY_PAYMENT_METHOD_FORM: PaymentMethodInput = {
  kind: 'EFECTIVO',
  name: '',
  bankName: '',
  accountNumber: '',
  cbu: '',
  openingBalance: '0',
  openingDate: '',
  active: true,
};

const SELECT =
  'id, kind, name, bank_name, account_number, cbu, opening_balance, opening_date, active';

function mapPaymentMethod(row: any): PaymentMethod {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    cbu: row.cbu,
    openingBalance: Number(row.opening_balance),
    openingDate: row.opening_date,
    active: row.active,
  };
}

/**
 * Los datos bancarios solo van en una cuenta bancaria y la cartera no lleva
 * saldo inicial. La base lo rechaza con un check, así que conviene mandar lo
 * correcto y no un error de constraint.
 */
function toRow(input: PaymentMethodInput) {
  const isBank = input.kind === 'BANCO';
  const isWallet = input.kind === 'CARTERA_CHEQUES';
  return {
    kind: input.kind,
    name: input.name.trim(),
    bank_name: isBank ? nullIfBlank(input.bankName) : null,
    account_number: isBank ? nullIfBlank(input.accountNumber) : null,
    cbu: isBank ? nullIfBlank(input.cbu) : null,
    opening_balance: isWallet ? 0 : Number(input.openingBalance) || 0,
    opening_date: input.openingDate,
    active: input.active,
  };
}

export function paymentMethodToForm(method: PaymentMethod): PaymentMethodInput {
  return {
    kind: method.kind,
    name: method.name,
    bankName: method.bankName ?? '',
    accountNumber: method.accountNumber ?? '',
    cbu: method.cbu ?? '',
    openingBalance: String(method.openingBalance),
    openingDate: method.openingDate,
    active: method.active,
  };
}

export async function fetchPaymentMethods(onlyActive = false): Promise<PaymentMethod[]> {
  let query = supabase.from('payment_methods').select(SELECT).order('kind').order('name');
  if (onlyActive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapPaymentMethod);
}

export async function createPaymentMethod(input: PaymentMethodInput): Promise<PaymentMethod> {
  const { data, error } = await supabase
    .from('payment_methods')
    .insert(toRow(input))
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapPaymentMethod(data);
}

export async function updatePaymentMethod(
  id: string,
  input: PaymentMethodInput
): Promise<PaymentMethod> {
  const { data, error } = await supabase
    .from('payment_methods')
    .update(toRow(input))
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapPaymentMethod(data);
}

export async function deletePaymentMethod(id: string): Promise<void> {
  const { error } = await supabase.from('payment_methods').delete().eq('id', id);
  if (error) throw error;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describePaymentMethodError(message: string, name: string): string {
  if (message.includes('payment_methods_name_key')) {
    return `Ya existe un medio de pago llamado "${name}".`;
  }
  if (message.includes('payment_methods_una_cartera')) {
    return 'Ya existe una cartera de cheques. El sistema maneja una sola: si tenés que separar valores, usá el estado de cada cheque.';
  }
  if (message.includes('payment_methods_cartera_sin_saldo_inicial')) {
    return 'La cartera de cheques no lleva saldo inicial. Los cheques que ya tengas en mano se cargan como cheques, no como un importe.';
  }
  if (message.includes('payment_methods_banco_coherente')) {
    return 'Los datos bancarios solo se cargan en un medio de tipo banco.';
  }
  if (message.includes('foreign key') || message.includes('violates')) {
    return `No se puede eliminar "${name}" porque ya tiene movimientos. Desactivalo en su lugar.`;
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de tesorería en la base (supabase/treasury-methods.sql).';
  }
  return message;
}
