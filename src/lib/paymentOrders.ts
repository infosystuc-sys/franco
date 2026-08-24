import { supabase } from '@/src/lib/supabase';
import { PURCHASE_DOC_TYPE_SHORT, type PurchaseDocType } from '@/src/lib/purchases';

/**
 * Pagos a proveedores. Es el espejo de cobranzas, con cuatro diferencias:
 *
 *   1. Las imputaciones llevan SIGNO. Compras sí tiene notas de crédito:
 *      facturas y notas de débito en positivo, notas de crédito en negativo.
 *   2. El cheque se CONSUME de la cartera, no se crea: se elige uno que ya
 *      está en mano y pasa a ENDOSADO.
 *   3. La retención es al revés: acá la practica el taller. El sistema guarda
 *      el certificado; el pasivo con ARCA no se lleva.
 *   4. Anular DEVUELVE el cheque a la cartera, porque si la orden fue un
 *      error el cheque sigue en poder del taller.
 */

export type PaymentOrderStatus = 'REGISTRADA' | 'ANULADA';
export type PaymentValueKind = 'MEDIO_PAGO' | 'CHEQUE_ENDOSADO' | 'RETENCION' | 'SALDO_A_FAVOR';

export const PAYMENT_VALUE_LABELS: Record<PaymentValueKind, string> = {
  MEDIO_PAGO: 'Efectivo o banco',
  CHEQUE_ENDOSADO: 'Cheque endosado',
  RETENCION: 'Retención',
  SALDO_A_FAVOR: 'Saldo a favor',
};

export const PAYMENT_VALUE_HELP: Record<PaymentValueKind, string> = {
  MEDIO_PAGO: 'Sale de la caja o del banco elegido.',
  CHEQUE_ENDOSADO:
    'Un cheque que ya tenés en cartera. Se entrega completo: no se puede endosar por una parte.',
  RETENCION:
    'Se la retenés al proveedor: cancela el comprobante pero no sale de ninguna caja. Lo que después le depositás a ARCA se carga como gasto en Tesorería.',
  SALDO_A_FAVOR: 'Crédito que ya tenías con este proveedor. No sale plata nueva.',
};

/** Qué valores son plata que sale de una caja y cuáles no. */
export function isCashValue(kind: PaymentValueKind): boolean {
  return kind === 'MEDIO_PAGO' || kind === 'CHEQUE_ENDOSADO';
}

/** Una nota de crédito resta de lo que hay que pagar; el resto suma. */
export function signOfDoc(docType: PurchaseDocType): 1 | -1 {
  return docType === 'NOTA_CREDITO' ? -1 : 1;
}

export { PURCHASE_DOC_TYPE_SHORT };

// ===========================================================================
// Lectura
// ===========================================================================

export interface PaymentAllocation {
  purchaseInvoiceId: string;
  fullNumber: string;
  docType: PurchaseDocType;
  letter: string;
  amount: number;
}

export interface PaymentValue {
  kind: PaymentValueKind;
  amount: number;
  paymentMethodName: string | null;
  checkNumber: string | null;
  checkBank: string | null;
  taxRateName: string | null;
  certificateNumber: string | null;
}

export interface PaymentOrder {
  id: string;
  fullNumber: string;
  status: PaymentOrderStatus;
  supplierId: string;
  supplierName: string;
  paymentDate: string;
  totalAmount: number;
  appliedAmount: number;
  onAccountAmount: number;
  notes: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  allocations: PaymentAllocation[];
  values: PaymentValue[];
}

const SELECT =
  `id, full_number, status, supplier_id, supplier_name, payment_date,
   total_amount, applied_amount, on_account_amount, notes, voided_at, voided_reason,
   allocations:payment_order_allocations(purchase_invoice_id, amount,
       doc:purchase_invoices(full_number, doc_type, letter)),
   values:payment_order_values(kind, amount, certificate_number,
       method:payment_methods(name), rate:tax_rates(name),
       check:third_party_checks(number, bank_name))`;

function mapOrder(row: any): PaymentOrder {
  return {
    id: row.id,
    fullNumber: row.full_number,
    status: row.status,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    paymentDate: row.payment_date,
    totalAmount: Number(row.total_amount),
    appliedAmount: Number(row.applied_amount),
    onAccountAmount: Number(row.on_account_amount),
    notes: row.notes,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,
    allocations: ((row.allocations ?? []) as any[]).map((a) => ({
      purchaseInvoiceId: a.purchase_invoice_id,
      fullNumber: a.doc?.full_number ?? '—',
      docType: a.doc?.doc_type ?? 'FACTURA',
      letter: a.doc?.letter ?? '',
      amount: Number(a.amount),
    })),
    values: ((row.values ?? []) as any[]).map((v) => ({
      kind: v.kind,
      amount: Number(v.amount),
      paymentMethodName: v.method?.name ?? null,
      checkNumber: v.check?.number ?? null,
      checkBank: v.check?.bank_name ?? null,
      taxRateName: v.rate?.name ?? null,
      certificateNumber: v.certificate_number,
    })),
  };
}

export async function fetchPaymentOrders(): Promise<PaymentOrder[]> {
  const { data, error } = await supabase
    .from('payment_orders')
    .select(SELECT)
    .order('payment_date', { ascending: false })
    .order('number', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapOrder);
}

export async function fetchPaymentOrderById(id: string): Promise<PaymentOrder | null> {
  const { data, error } = await supabase.from('payment_orders').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapOrder(data) : null;
}

/**
 * Comprobantes pendientes de un proveedor, de más viejo a más nuevo y con las
 * notas de crédito mezcladas: se pagan y se compensan juntos, y separarlos
 * obligaría a mirar dos lugares para entender un solo saldo.
 */
export interface OpenPurchaseDoc {
  id: string;
  fullNumber: string;
  letter: string;
  docType: PurchaseDocType;
  issueDate: string;
  dueDate: string;
  totalAmount: number;
  settledAmount: number;
  /** Lo que queda, siempre positivo. El signo lo da el tipo. */
  pending: number;
}

export async function fetchOpenPurchaseDocs(supplierId: string): Promise<OpenPurchaseDoc[]> {
  const { data, error } = await supabase
    .from('purchase_invoices')
    .select('id, full_number, letter, doc_type, issue_date, due_date, total_amount, settled_amount')
    .eq('supplier_id', supplierId)
    .eq('status', 'REGISTRADA')
    .order('issue_date', { ascending: true });

  if (error) throw error;

  return (data ?? [])
    .map((row: any) => {
      const total = Number(row.total_amount);
      const settled = Number(row.settled_amount);
      return {
        id: row.id,
        fullNumber: row.full_number,
        letter: row.letter,
        docType: row.doc_type as PurchaseDocType,
        issueDate: row.issue_date,
        dueDate: row.due_date,
        totalAmount: total,
        settledAmount: settled,
        pending: Math.round((total - settled) * 100) / 100,
      };
    })
    .filter((doc) => doc.pending > 0);
}

/** Deuda por proveedor: facturas y notas de débito menos notas de crédito. */
export interface SupplierDebt {
  supplierId: string;
  supplierName: string;
  debt: number;
}

export async function fetchSupplierDebts(): Promise<SupplierDebt[]> {
  const { data, error } = await supabase
    .from('purchase_invoices')
    .select('supplier_id, supplier_name, doc_type, total_amount, settled_amount')
    .eq('status', 'REGISTRADA');

  if (error) throw error;

  const map = new Map<string, SupplierDebt>();
  for (const row of (data ?? []) as any[]) {
    const pending = Number(row.total_amount) - Number(row.settled_amount);
    if (pending <= 0) continue;
    const current = map.get(row.supplier_id) ?? {
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      debt: 0,
    };
    current.debt =
      Math.round((current.debt + pending * signOfDoc(row.doc_type)) * 100) / 100;
    map.set(row.supplier_id, current);
  }
  return [...map.values()];
}

export async function fetchSupplierCredit(supplierId: string): Promise<number> {
  const { data, error } = await supabase.rpc('supplier_credit', { p_supplier_id: supplierId });
  if (error) throw error;
  return Number(data ?? 0);
}

// ===========================================================================
// Escritura
// ===========================================================================

export interface PaymentAllocationInput {
  purchaseInvoiceId: string;
  /** Con signo: negativo en notas de crédito. */
  amount: number;
}

export interface PaymentValueInput {
  kind: PaymentValueKind;
  amount: number;
  paymentMethodId?: string;
  checkId?: string;
  taxRateId?: string;
  certificateNumber?: string;
}

export async function savePaymentOrder(
  header: { supplierId: string; paymentDate: string; notes: string },
  allocations: PaymentAllocationInput[],
  values: PaymentValueInput[]
): Promise<{ id: string; fullNumber: string }> {
  const { data, error } = await supabase.rpc('save_payment_order', {
    p_header: {
      supplier_id: header.supplierId,
      payment_date: header.paymentDate,
      notes: header.notes.trim() || null,
    },
    p_allocations: allocations.map((a) => ({
      purchase_invoice_id: a.purchaseInvoiceId,
      amount: a.amount,
    })),
    p_values: values.map((v) => ({
      kind: v.kind,
      amount: v.amount,
      payment_method_id: v.paymentMethodId ?? null,
      check_id: v.checkId ?? null,
      tax_rate_id: v.taxRateId ?? null,
      certificate_number: v.certificateNumber ?? null,
    })),
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió la orden guardada.');
  return { id: row.order_id, fullNumber: row.order_full_number };
}

export async function voidPaymentOrder(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_payment_order', {
    p_order_id: id,
    p_reason: reason,
  });
  if (error) throw error;
}

/**
 * Reparte un importe entre los comprobantes, de más viejo a más nuevo. Las
 * notas de crédito se aplican enteras y primero: reducen lo que hay que pagar,
 * así que dejarlas para el final desperdiciaría el crédito.
 */
export function autoAllocate(
  docs: OpenPurchaseDoc[],
  amount: number
): Record<string, number> {
  const result: Record<string, number> = {};
  const credits = docs.filter((d) => d.docType === 'NOTA_CREDITO');
  const debits = docs.filter((d) => d.docType !== 'NOTA_CREDITO');

  let available = Math.round(amount * 100) / 100;
  for (const credit of credits) {
    result[credit.id] = -credit.pending;
    available = Math.round((available + credit.pending) * 100) / 100;
  }

  for (const debit of debits) {
    if (available <= 0) break;
    const take = Math.min(available, debit.pending);
    result[debit.id] = Math.round(take * 100) / 100;
    available = Math.round((available - take) * 100) / 100;
  }

  return result;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describePaymentOrderError(message: string): string {
  if (message.includes('payment_order_allocations_payment_order_id_purchase_invoice_id_key')) {
    return 'El mismo comprobante aparece dos veces en la orden.';
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de pagos en la base (supabase/payment-orders.sql).';
  }
  return message;
}
