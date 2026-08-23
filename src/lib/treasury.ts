import { supabase } from '@/src/lib/supabase';
import type { PaymentMethodKind } from '@/src/lib/paymentMethods';

/**
 * Tesorería: el libro de caja del taller.
 *
 * Un movimiento tiene una cabecera y una o más PARTIDAS, cada una con su
 * medio de pago y su importe con signo. Un gasto tiene una partida negativa;
 * una transferencia tiene dos que suman cero.
 *
 * El saldo de un medio no se guarda en ninguna columna: sale del saldo
 * inicial más la suma de sus partidas. Por eso la base valida que las
 * partidas cuadren con el importe de la cabecera — si no cuadraran, el libro
 * dejaría de decir la verdad y no habría forma de darse cuenta después.
 */

export type TreasuryMovementType = 'EGRESO' | 'INGRESO' | 'TRANSFERENCIA';
export type TreasuryStatus = 'REGISTRADO' | 'ANULADO';

export const MOVEMENT_TYPE_LABELS: Record<TreasuryMovementType, string> = {
  EGRESO: 'Egreso',
  INGRESO: 'Ingreso',
  TRANSFERENCIA: 'Transferencia',
};

export const MOVEMENT_TYPE_HELP: Record<TreasuryMovementType, string> = {
  EGRESO: 'Un gasto sin factura: sale plata de un medio de pago.',
  INGRESO: 'Entra plata a un medio de pago.',
  TRANSFERENCIA: 'Plata que se mueve de un medio a otro. No es gasto ni ingreso.',
};

export const MOVEMENT_TYPES = Object.keys(MOVEMENT_TYPE_LABELS) as TreasuryMovementType[];

/** Color de la tira lateral: verde entra, rojo sale, azul se mueve de lugar. */
export const MOVEMENT_TYPE_STRIP: Record<TreasuryMovementType, string> = {
  EGRESO: '#c62828',
  INGRESO: '#2e7d32',
  TRANSFERENCIA: '#2b6cb0',
};

/** Prefijo del correlativo, para anticiparlo antes de guardar. */
export const MOVEMENT_TYPE_PREFIX: Record<TreasuryMovementType, string> = {
  EGRESO: 'EG',
  INGRESO: 'IN',
  TRANSFERENCIA: 'TR',
};

// ===========================================================================
// Saldos
// ===========================================================================

export interface MethodBalance {
  paymentMethodId: string;
  name: string;
  kind: PaymentMethodKind;
  active: boolean;
  openingBalance: number;
  balance: number;
}

export async function fetchBalances(): Promise<MethodBalance[]> {
  const { data, error } = await supabase
    .from('payment_method_balances')
    .select('payment_method_id, name, kind, active, opening_balance, balance')
    .order('kind')
    .order('name');

  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    paymentMethodId: row.payment_method_id,
    name: row.name,
    kind: row.kind,
    active: row.active,
    openingBalance: Number(row.opening_balance),
    balance: Number(row.balance),
  }));
}

// ===========================================================================
// Lectura de movimientos
// ===========================================================================

export interface MovementLeg {
  paymentMethodId: string;
  paymentMethodName: string;
  amount: number;
}

export interface TreasuryMovement {
  id: string;
  movementType: TreasuryMovementType;
  fullNumber: string;
  status: TreasuryStatus;
  movementDate: string;
  conceptId: string | null;
  conceptName: string | null;
  description: string;
  payee: string | null;
  amount: number;
  notes: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  legs: MovementLeg[];
}

const SELECT =
  `id, movement_type, full_number, status, movement_date, concept_id,
   description, payee, amount, notes, voided_at, voided_reason,
   concept:expense_concepts(name),
   legs:treasury_movement_legs(payment_method_id, amount, method:payment_methods(name))`;

function mapMovement(row: any): TreasuryMovement {
  return {
    id: row.id,
    movementType: row.movement_type,
    fullNumber: row.full_number,
    status: row.status,
    movementDate: row.movement_date,
    conceptId: row.concept_id,
    conceptName: row.concept?.name ?? null,
    description: row.description,
    payee: row.payee,
    amount: Number(row.amount),
    notes: row.notes,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,
    legs: ((row.legs ?? []) as any[]).map((leg) => ({
      paymentMethodId: leg.payment_method_id,
      paymentMethodName: leg.method?.name ?? '—',
      amount: Number(leg.amount),
    })),
  };
}

export async function fetchMovements(): Promise<TreasuryMovement[]> {
  const { data, error } = await supabase
    .from('treasury_movements')
    .select(SELECT)
    .order('movement_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapMovement);
}

export async function fetchMovementById(id: string): Promise<TreasuryMovement | null> {
  const { data, error } = await supabase.from('treasury_movements').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapMovement(data) : null;
}

// ===========================================================================
// Escritura (solo por RPC: la base valida que las partidas cuadren)
// ===========================================================================

export interface MovementLegInput {
  paymentMethodId: string;
  /** Con signo: negativo saca del medio, positivo entra. */
  amount: number;
}

export interface MovementHeaderInput {
  movementType: TreasuryMovementType;
  movementDate: string;
  conceptId: string | null;
  description: string;
  payee: string;
  amount: number;
  notes: string;
}

export async function saveMovement(
  header: MovementHeaderInput,
  legs: MovementLegInput[]
): Promise<{ id: string; fullNumber: string }> {
  const { data, error } = await supabase.rpc('save_treasury_movement', {
    p_header: {
      movement_type: header.movementType,
      movement_date: header.movementDate,
      concept_id: header.conceptId,
      description: header.description.trim(),
      payee: header.payee.trim() || null,
      amount: header.amount,
      notes: header.notes.trim() || null,
    },
    p_legs: legs.map((leg) => ({
      payment_method_id: leg.paymentMethodId,
      amount: leg.amount,
    })),
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió el movimiento guardado.');
  return { id: row.movement_id, fullNumber: row.movement_full_number };
}

export async function voidMovement(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_treasury_movement', {
    p_movement_id: id,
    p_reason: reason,
  });
  if (error) throw error;
}

/**
 * Arma las partidas a partir de lo que se carga en pantalla.
 *
 * El signo lo pone acá una sola función y no cada llamador: es el detalle en
 * el que más fácil se equivoca uno, y un signo invertido hace que el saldo
 * mienta sin que nada falle.
 */
export function buildLegs(
  type: TreasuryMovementType,
  amount: number,
  fromMethodId: string,
  toMethodId: string
): MovementLegInput[] {
  if (type === 'EGRESO') return [{ paymentMethodId: fromMethodId, amount: -amount }];
  if (type === 'INGRESO') return [{ paymentMethodId: toMethodId, amount: amount }];
  return [
    { paymentMethodId: fromMethodId, amount: -amount },
    { paymentMethodId: toMethodId, amount: amount },
  ];
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeTreasuryError(message: string): string {
  if (message.includes('cartera de cheques')) {
    return message;
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de tesorería en la base (supabase/treasury-methods.sql y treasury-movements.sql).';
  }
  return message;
}
