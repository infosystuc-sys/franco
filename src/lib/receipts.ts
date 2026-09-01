import { supabase } from '@/src/lib/supabase';

/**
 * Cobranzas: el recibo con el que se cobran las facturas de venta.
 *
 * Tiene IMPUTACIONES (qué factura y cuánto) y VALORES (con qué se cobró). El
 * pago parcial y el pago de varias facturas son la misma tabla vista de dos
 * maneras: un importe menor al saldo es parcial, varias filas son varias
 * facturas.
 *
 * No todos los valores son plata. Una retención cancela la factura pero no
 * entra a ninguna caja —es un crédito fiscal— y el saldo a favor es plata que
 * ya había entrado en un recibo anterior. Por eso el ingreso que se postea en
 * el libro de caja suma solo los valores que sí son cobro.
 */

export type ReceiptStatus = 'REGISTRADO' | 'ANULADO';
export type ReceiptValueKind = 'MEDIO_PAGO' | 'CHEQUE' | 'RETENCION' | 'SALDO_A_FAVOR';
export type ReceiptChangeKind = 'MEDIO_PAGO' | 'CHEQUE_PROPIO' | 'CHEQUE_ENDOSADO';

export const CHANGE_KIND_LABELS: Record<ReceiptChangeKind, string> = {
  MEDIO_PAGO: 'Efectivo o transferencia',
  CHEQUE_PROPIO: 'Cheque propio',
  CHEQUE_ENDOSADO: 'Cheque de cartera',
};

export const VALUE_KIND_LABELS: Record<ReceiptValueKind, string> = {
  MEDIO_PAGO: 'Efectivo o banco',
  CHEQUE: 'Cheque',
  RETENCION: 'Retención',
  SALDO_A_FAVOR: 'Saldo a favor',
};

/** Qué valores son plata que entra a una caja y cuáles no. */
export function isCashValue(kind: ReceiptValueKind): boolean {
  return kind === 'MEDIO_PAGO' || kind === 'CHEQUE';
}

export const VALUE_KIND_HELP: Record<ReceiptValueKind, string> = {
  MEDIO_PAGO: 'Entra a la caja o al banco elegido.',
  CHEQUE: 'Entra a la cartera con su ficha, listo para depositar o endosar.',
  RETENCION:
    'El cliente la retuvo: cancela la factura pero no entra a ninguna caja, porque es un crédito fiscal.',
  SALDO_A_FAVOR: 'Crédito que el cliente ya tenía. No entra plata nueva.',
};

// ===========================================================================
// Lectura
// ===========================================================================

export interface ReceiptAllocation {
  invoiceId: string;
  invoiceFullNumber: string;
  invoiceType: string;
  amount: number;
}

export interface ReceiptValue {
  kind: ReceiptValueKind;
  amount: number;
  paymentMethodName: string | null;
  checkId: string | null;
  checkNumber: string | null;
  checkBank: string | null;
  taxRateName: string | null;
  certificateNumber: string | null;
}

export interface ReceiptChange {
  kind: ReceiptChangeKind;
  amount: number;
  paymentMethodName: string | null;
  note: string | null;
  checkNumber: string | null;
  checkBank: string | null;
}

export interface Receipt {
  id: string;
  fullNumber: string;
  status: ReceiptStatus;
  customerId: string;
  customerName: string;
  receiptDate: string;
  totalAmount: number;
  appliedAmount: number;
  onAccountAmount: number;
  notes: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  allocations: ReceiptAllocation[];
  values: ReceiptValue[];
  /** El vuelto, si lo hubo. Puede tener varios tramos (efectivo, cheque propio, cheque de cartera). */
  changes: ReceiptChange[];
}

const SELECT =
  `id, full_number, status, customer_id, customer_name, receipt_date,
   total_amount, applied_amount, on_account_amount, notes, voided_at, voided_reason,
   allocations:receipt_allocations(invoice_id, amount, invoice:invoices(full_number, invoice_type)),
   values:receipt_values(kind, amount, check_id, certificate_number,
          method:payment_methods(name), rate:tax_rates(name),
          check:third_party_checks(number, bank_name)),
   changes:receipt_changes(kind, amount, note, method:payment_methods(name),
          check:third_party_checks(number, bank_name))`;

function mapReceipt(row: any): Receipt {
  return {
    id: row.id,
    fullNumber: row.full_number,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    receiptDate: row.receipt_date,
    totalAmount: Number(row.total_amount),
    appliedAmount: Number(row.applied_amount),
    onAccountAmount: Number(row.on_account_amount),
    notes: row.notes,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,
    allocations: ((row.allocations ?? []) as any[]).map((a) => ({
      invoiceId: a.invoice_id,
      invoiceFullNumber: a.invoice?.full_number ?? '—',
      invoiceType: a.invoice?.invoice_type ?? '',
      amount: Number(a.amount),
    })),
    values: ((row.values ?? []) as any[]).map((v) => ({
      kind: v.kind,
      amount: Number(v.amount),
      paymentMethodName: v.method?.name ?? null,
      checkId: v.check_id,
      checkNumber: v.check?.number ?? null,
      checkBank: v.check?.bank_name ?? null,
      taxRateName: v.rate?.name ?? null,
      certificateNumber: v.certificate_number,
    })),
    changes: ((row.changes ?? []) as any[]).map((c) => ({
      kind: c.kind,
      amount: Number(c.amount),
      paymentMethodName: c.method?.name ?? null,
      note: c.note ?? null,
      checkNumber: c.check?.number ?? null,
      checkBank: c.check?.bank_name ?? null,
    })),
  };
}

export async function fetchReceipts(): Promise<Receipt[]> {
  const { data, error } = await supabase
    .from('receipts')
    .select(SELECT)
    .order('receipt_date', { ascending: false })
    .order('number', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapReceipt);
}

export async function fetchReceiptById(id: string): Promise<Receipt | null> {
  const { data, error } = await supabase.from('receipts').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapReceipt(data) : null;
}

/** Facturas de un cliente con saldo pendiente, de más vieja a más nueva. */
export interface OpenInvoice {
  id: string;
  fullNumber: string;
  invoiceType: string;
  issueDate: string;
  dueDate: string;
  totalAmount: number;
  paidAmount: number;
  balance: number;
}

export async function fetchOpenInvoices(customerId: string): Promise<OpenInvoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, full_number, invoice_type, issue_date, due_date, total_amount, paid_amount')
    .eq('customer_id', customerId)
    .eq('status', 'EMITIDA')
    .order('issue_date', { ascending: true })
    .order('number', { ascending: true });

  if (error) throw error;

  return (data ?? [])
    .map((row: any) => {
      const total = Number(row.total_amount);
      const paid = Number(row.paid_amount);
      return {
        id: row.id,
        fullNumber: row.full_number,
        invoiceType: row.invoice_type,
        issueDate: row.issue_date,
        dueDate: row.due_date,
        totalAmount: total,
        paidAmount: paid,
        balance: Math.round((total - paid) * 100) / 100,
      };
    })
    .filter((invoice) => invoice.balance > 0);
}

/**
 * Deuda por cliente: la suma de los saldos de sus facturas vigentes.
 *
 * Se agrega del lado del cliente porque PostgREST no agrupa, y en un taller
 * la cantidad de facturas abiertas es chica. Si algún día deja de serlo, esto
 * se reemplaza por una vista.
 */
export interface CustomerDebt {
  customerId: string;
  customerName: string;
  debt: number;
}

export async function fetchCustomerDebts(): Promise<CustomerDebt[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('customer_id, customer_name, total_amount, paid_amount')
    .eq('status', 'EMITIDA');

  if (error) throw error;

  const map = new Map<string, CustomerDebt>();
  for (const row of (data ?? []) as any[]) {
    const balance = Number(row.total_amount) - Number(row.paid_amount);
    if (balance <= 0) continue;
    const current = map.get(row.customer_id) ?? {
      customerId: row.customer_id,
      customerName: row.customer_name,
      debt: 0,
    };
    current.debt = Math.round((current.debt + balance) * 100) / 100;
    map.set(row.customer_id, current);
  }
  return [...map.values()];
}

/** Crédito disponible del cliente: lo cobrado de más que todavía no se usó. */
export async function fetchCustomerCredit(customerId: string): Promise<number> {
  const { data, error } = await supabase.rpc('customer_credit', { p_customer_id: customerId });
  if (error) throw error;
  return Number(data ?? 0);
}

// ===========================================================================
// Escritura
// ===========================================================================

export interface AllocationInput {
  invoiceId: string;
  amount: number;
}

export interface ValueInput {
  kind: ReceiptValueKind;
  amount: number;
  paymentMethodId?: string;
  taxRateId?: string;
  certificateNumber?: string;
  checkNumber?: string;
  checkBank?: string;
  checkDrawer?: string;
  checkIssueDate?: string;
  checkDueDate?: string;
}

export interface ChangeInput {
  kind: ReceiptChangeKind;
  amount: number;
  paymentMethodId?: string;
  note?: string;
  /** Solo para CHEQUE_ENDOSADO: el cheque de la cartera que se entrega. */
  checkId?: string;
}

export async function saveReceipt(
  header: { customerId: string; receiptDate: string; notes: string },
  allocations: AllocationInput[],
  values: ValueInput[],
  changes?: ChangeInput[]
): Promise<{ id: string; fullNumber: string }> {
  const { data, error } = await supabase.rpc('save_receipt', {
    p_header: {
      customer_id: header.customerId,
      receipt_date: header.receiptDate,
      notes: header.notes.trim() || null,
    },
    p_allocations: allocations.map((a) => ({ invoice_id: a.invoiceId, amount: a.amount })),
    p_values: values.map((v) => ({
      kind: v.kind,
      amount: v.amount,
      payment_method_id: v.paymentMethodId ?? null,
      tax_rate_id: v.taxRateId ?? null,
      certificate_number: v.certificateNumber ?? null,
      check_number: v.checkNumber ?? null,
      check_bank: v.checkBank ?? null,
      check_drawer: v.checkDrawer ?? null,
      check_issue_date: v.checkIssueDate || null,
      check_due_date: v.checkDueDate || null,
    })),
    p_changes: changes && changes.length > 0
      ? changes.map((change) => ({
          kind: change.kind,
          amount: change.amount,
          payment_method_id: change.paymentMethodId ?? null,
          note: change.note?.trim() || null,
          check_id: change.checkId ?? null,
        }))
      : null,
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió el recibo guardado.');
  return { id: row.receipt_id, fullNumber: row.receipt_full_number };
}

export async function voidReceipt(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_receipt', { p_receipt_id: id, p_reason: reason });
  if (error) throw error;
}

/**
 * Reparte un importe entre las facturas, de más vieja a más nueva, que es el
 * orden en que normalmente se cancelan. Cada una se lleva hasta su saldo y lo
 * que sobra pasa a la siguiente.
 */
export function autoAllocate(invoices: OpenInvoice[], amount: number): Record<string, number> {
  const result: Record<string, number> = {};
  let remaining = Math.round(amount * 100) / 100;

  for (const invoice of invoices) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, invoice.balance);
    result[invoice.id] = Math.round(take * 100) / 100;
    remaining = Math.round((remaining - take) * 100) / 100;
  }

  return result;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeReceiptError(message: string): string {
  if (message.includes('receipt_allocations_receipt_id_invoice_id_key')) {
    return 'La misma factura aparece dos veces en el recibo.';
  }
  if (message.includes('third_party_checks_sin_duplicados')) {
    return 'Ese cheque ya está cargado: mismo número y mismo banco.';
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de cobranzas en la base (supabase/receipts.sql).';
  }
  return message;
}
