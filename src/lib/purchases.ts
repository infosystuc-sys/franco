import { supabase } from '@/src/lib/supabase';
import { formatDate, todayLocal, toDateString } from '@/src/lib/utils';
import type { TaxCondition } from '@/src/lib/fiscal';
import type { TaxRate, VatTreatment } from '@/src/lib/taxRates';

/**
 * Compras: los comprobantes que llegan de proveedores.
 *
 * A diferencia de la venta, acá NO se genera nada. Tipo, letra, punto de
 * venta y número se transcriben del papel; el sistema no numera, valida.
 *
 * Qué calcula el navegador y qué la base tampoco es lo mismo que en ventas:
 * el comprobante YA EXISTE en papel. Los netos y el IVA salen de cantidad ×
 * precio × alícuota, y los recalcula la base. Los importes del pie los
 * transcribe el usuario, y se guardan como vienen: es lo que permite que el
 * comprobante cierre exacto aunque el proveedor haya redondeado distinto.
 */

export type PurchaseKind = 'ARTICULOS' | 'CONCEPTOS';
export type PurchaseDocType = 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO';
export type PurchaseLetter = 'A' | 'B' | 'C' | 'M';
export type PurchaseStatus = 'REGISTRADA' | 'ANULADA';

export const PURCHASE_DOC_TYPE_LABELS: Record<PurchaseDocType, string> = {
  FACTURA: 'Factura',
  NOTA_CREDITO: 'Nota de crédito',
  NOTA_DEBITO: 'Nota de débito',
};

/** Abreviatura para listados, donde el nombre completo no entra. */
export const PURCHASE_DOC_TYPE_SHORT: Record<PurchaseDocType, string> = {
  FACTURA: 'FC',
  NOTA_CREDITO: 'NC',
  NOTA_DEBITO: 'ND',
};

export const PURCHASE_DOC_TYPES = Object.keys(PURCHASE_DOC_TYPE_LABELS) as PurchaseDocType[];
export const PURCHASE_LETTERS: PurchaseLetter[] = ['A', 'B', 'C', 'M'];

export const PURCHASE_KIND_LABELS: Record<PurchaseKind, string> = {
  ARTICULOS: 'Artículos',
  CONCEPTOS: 'Conceptos',
};

/** La nota de crédito resta en la cuenta corriente; factura y débito suman. */
export function signOf(docType: PurchaseDocType): 1 | -1 {
  return docType === 'NOTA_CREDITO' ? -1 : 1;
}

export { formatDate };

// ===========================================================================
// Cálculo del comprobante (previsualización; la base lo recalcula al guardar)
// ===========================================================================

export interface PurchaseLine {
  articleId: string | null;
  conceptId: string | null;
  code: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  vatRateId: string;
}

export interface PurchaseFootTax {
  taxRateId: string;
  /** Importe transcripto del papel. Arranca calculado y se puede corregir. */
  amount: number;
}

export interface PurchaseTotals {
  gross: number;
  lineDiscount: number;
  generalDiscount: number;
  netTaxed: number;
  netExempt: number;
  netUntaxed: number;
  netTotal: number;
  vatByRate: { rate: number; net: number; vat: number }[];
  vat: number;
  otherTaxes: number;
  total: number;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * El descuento general se reparte proporcionalmente sobre cada renglón y no
 * se resta al final: si se restara del total, la suma de los netos por
 * alícuota dejaría de dar el neto del comprobante y el IVA saldría mal.
 */
export function computePurchaseTotals(
  lines: PurchaseLine[],
  footTaxes: PurchaseFootTax[],
  generalDiscountPercent: number,
  vatRates: TaxRate[]
): PurchaseTotals {
  const byId = new Map(vatRates.map((rate) => [rate.id, rate]));
  const discountFactor = 1 - (generalDiscountPercent || 0) / 100;

  let gross = 0;
  let lineDiscount = 0;
  const netByTreatment: Record<VatTreatment, number> = { GRAVADO: 0, EXENTO: 0, NO_GRAVADO: 0 };
  const perRate = new Map<number, { net: number; vat: number }>();

  // Se redondea POR RENGLÓN y después se suma, igual que save_purchase_invoice.
  // Si acá se sumara sin redondear, la previsualización mostraría un total
  // distinto del que termina guardando la base.
  for (const line of lines) {
    const lineGross = round2(line.quantity * line.unitPrice);
    gross += lineGross;
    lineDiscount += round2((lineGross * (line.discountPercent || 0)) / 100);

    const net = round2(
      line.quantity * line.unitPrice * (1 - (line.discountPercent || 0) / 100) * discountFactor
    );
    const rate = byId.get(line.vatRateId);
    const treatment: VatTreatment = rate?.vatTreatment ?? 'GRAVADO';
    netByTreatment[treatment] += net;

    if (treatment === 'GRAVADO' && rate) {
      const current = perRate.get(rate.rate) ?? { net: 0, vat: 0 };
      current.net += net;
      current.vat += round2((net * rate.rate) / 100);
      perRate.set(rate.rate, current);
    }
  }

  const netTaxed = round2(netByTreatment.GRAVADO);
  const netExempt = round2(netByTreatment.EXENTO);
  const netUntaxed = round2(netByTreatment.NO_GRAVADO);
  const netTotal = round2(netTaxed + netExempt + netUntaxed);
  const vat = round2(
    [...perRate.values()].reduce((sum, entry) => sum + entry.vat, 0)
  );
  const otherTaxes = round2(footTaxes.reduce((sum, tax) => sum + (tax.amount || 0), 0));

  return {
    gross: round2(gross),
    lineDiscount: round2(lineDiscount),
    generalDiscount: round2((gross - lineDiscount) * ((generalDiscountPercent || 0) / 100)),
    netTaxed,
    netExempt,
    netUntaxed,
    netTotal,
    vatByRate: [...perRate.entries()]
      .map(([rate, entry]) => ({ rate, net: round2(entry.net), vat: round2(entry.vat) }))
      .sort((a, b) => b.rate - a.rate),
    vat,
    otherTaxes,
    total: round2(netTotal + vat + otherTaxes),
  };
}

/**
 * Importe sugerido de un impuesto del pie. Es una propuesta: el que vale es
 * el del papel, y por eso el campo queda editable.
 */
export function suggestedTaxAmount(rate: TaxRate, totals: PurchaseTotals): number {
  const base: number = rate.base === 'TOTAL' ? totals.netTotal + totals.vat : totals.netTotal;
  return round2((base * rate.rate) / 100);
}

/** Vencimiento propuesto: fecha del comprobante más el plazo del proveedor. */
export function proposeDueDate(issueDate: string, paymentTermsDays: number): string {
  const date = new Date(`${issueDate}T00:00:00`);
  date.setDate(date.getDate() + (paymentTermsDays || 0));
  return toDateString(date);
}

// ===========================================================================
// Estado de la deuda
// ===========================================================================

interface Payable {
  totalAmount: number;
  settledAmount: number;
  dueDate: string;
  status: PurchaseStatus;
  docType: PurchaseDocType;
}

export function balanceOf(doc: Payable): number {
  if (doc.status === 'ANULADA') return 0;
  return round2(Math.max(0, doc.totalAmount - doc.settledAmount));
}

/** Lo que este comprobante mueve en la cuenta corriente, con su signo. */
export function signedBalanceOf(doc: Payable): number {
  if (doc.status === 'ANULADA') return 0;
  return round2(balanceOf(doc) * signOf(doc.docType));
}

export function isOverdue(doc: Payable): boolean {
  if (doc.status === 'ANULADA') return false;
  if (doc.docType === 'NOTA_CREDITO') return false;
  if (balanceOf(doc) <= 0) return false;
  return doc.dueDate < todayLocal();
}

// ===========================================================================
// Lectura
// ===========================================================================

export interface PurchaseListRow {
  id: string;
  kind: PurchaseKind;
  docType: PurchaseDocType;
  letter: PurchaseLetter;
  fullNumber: string;
  status: PurchaseStatus;
  supplierId: string;
  supplierName: string;
  issueDate: string;
  dueDate: string;
  totalAmount: number;
  settledAmount: number;
}

export interface PurchaseItem {
  lineNumber: number;
  code: string | null;
  description: string;
  conceptName: string | null;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  netAmount: number;
  vatRate: number;
  vatTreatment: VatTreatment;
  vatAmount: number;
}

export interface PurchaseTax {
  name: string;
  rate: number;
  baseAmount: number;
  amount: number;
}

export interface PurchaseDetail extends PurchaseListRow {
  salesPoint: number;
  number: number;
  receivedDate: string;
  paymentTermsDays: number;
  movesStock: boolean;

  supplierLegalName: string | null;
  supplierTaxId: string | null;
  supplierTaxCondition: TaxCondition;

  grossAmount: number;
  lineDiscountAmount: number;
  generalDiscountPercent: number;
  generalDiscountAmount: number;
  netTaxed: number;
  netExempt: number;
  netUntaxed: number;
  vatAmount: number;
  otherTaxesAmount: number;

  notes: string | null;
  voidedAt: string | null;
  voidedReason: string | null;

  items: PurchaseItem[];
  taxes: PurchaseTax[];
}

const LIST_SELECT =
  'id, kind, doc_type, letter, full_number, status, supplier_id, supplier_name, ' +
  'issue_date, due_date, total_amount, settled_amount';

function mapListRow(row: any): PurchaseListRow {
  return {
    id: row.id,
    kind: row.kind,
    docType: row.doc_type,
    letter: row.letter,
    fullNumber: row.full_number,
    status: row.status,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    totalAmount: Number(row.total_amount),
    settledAmount: Number(row.settled_amount),
  };
}

export async function fetchPurchases(): Promise<PurchaseListRow[]> {
  const { data, error } = await supabase
    .from('purchase_invoices')
    .select(LIST_SELECT)
    .order('issue_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapListRow);
}

export async function fetchPurchaseById(id: string): Promise<PurchaseDetail | null> {
  const { data, error } = await supabase
    .from('purchase_invoices')
    .select(
      `id, kind, doc_type, letter, full_number, sales_point, number, status,
       supplier_id, supplier_name, supplier_legal_name, supplier_tax_id, supplier_tax_condition,
       issue_date, received_date, due_date, payment_terms_days, moves_stock,
       gross_amount, line_discount_amount, general_discount_percent, general_discount_amount,
       net_taxed, net_exempt, net_untaxed, vat_amount, other_taxes_amount,
       total_amount, settled_amount, notes, voided_at, voided_reason,
       items:purchase_invoice_items(line_number, code, description, quantity, unit_price,
             discount_percent, net_amount, vat_rate, vat_treatment, vat_amount,
             concept:expense_concepts(name)),
       taxes:purchase_invoice_taxes(name, rate, base_amount, amount)`
    )
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as any;
  return {
    ...mapListRow(row),
    salesPoint: Number(row.sales_point),
    number: Number(row.number),
    receivedDate: row.received_date,
    paymentTermsDays: Number(row.payment_terms_days),
    movesStock: row.moves_stock,

    supplierLegalName: row.supplier_legal_name,
    supplierTaxId: row.supplier_tax_id,
    supplierTaxCondition: row.supplier_tax_condition,

    grossAmount: Number(row.gross_amount),
    lineDiscountAmount: Number(row.line_discount_amount),
    generalDiscountPercent: Number(row.general_discount_percent),
    generalDiscountAmount: Number(row.general_discount_amount),
    netTaxed: Number(row.net_taxed),
    netExempt: Number(row.net_exempt),
    netUntaxed: Number(row.net_untaxed),
    vatAmount: Number(row.vat_amount),
    otherTaxesAmount: Number(row.other_taxes_amount),

    notes: row.notes,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,

    items: ((row.items ?? []) as any[])
      .sort((a, b) => a.line_number - b.line_number)
      .map((item) => ({
        lineNumber: item.line_number,
        code: item.code,
        description: item.description,
        conceptName: item.concept?.name ?? null,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unit_price),
        discountPercent: Number(item.discount_percent),
        netAmount: Number(item.net_amount),
        vatRate: Number(item.vat_rate),
        vatTreatment: item.vat_treatment,
        vatAmount: Number(item.vat_amount),
      })),

    taxes: ((row.taxes ?? []) as any[]).map((tax) => ({
      name: tax.name,
      rate: Number(tax.rate),
      baseAmount: Number(tax.base_amount),
      amount: Number(tax.amount),
    })),
  };
}

/** Saldo por proveedor: lo que se le debe hoy, netas las notas de crédito. */
export interface SupplierBalance {
  supplierId: string;
  supplierName: string;
  balance: number;
  overdue: number;
  documents: number;
}

export function summarizeBySupplier(rows: PurchaseListRow[]): SupplierBalance[] {
  const map = new Map<string, SupplierBalance>();

  for (const row of rows) {
    if (row.status === 'ANULADA') continue;
    const current = map.get(row.supplierId) ?? {
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      balance: 0,
      overdue: 0,
      documents: 0,
    };
    current.balance += signedBalanceOf(row);
    if (isOverdue(row)) current.overdue += balanceOf(row);
    current.documents += 1;
    map.set(row.supplierId, current);
  }

  return [...map.values()]
    .map((entry) => ({ ...entry, balance: round2(entry.balance), overdue: round2(entry.overdue) }))
    .sort((a, b) => b.balance - a.balance);
}

// ===========================================================================
// Escritura (solo por RPC)
// ===========================================================================

export interface PurchaseHeaderInput {
  kind: PurchaseKind;
  docType: PurchaseDocType;
  letter: PurchaseLetter;
  salesPoint: number;
  number: number;
  supplierId: string;
  issueDate: string;
  receivedDate: string;
  dueDate: string;
  paymentTermsDays: number;
  generalDiscountPercent: number;
  /**
   * Si el comprobante mueve inventario. La factura de artículos siempre lo
   * mueve —lo fuerza la base—; en la NC y la ND lo decide el usuario, porque
   * la misma NC puede ser una devolución o un ajuste de precio.
   */
  movesStock: boolean;
  notes: string;
}

export async function savePurchaseInvoice(
  header: PurchaseHeaderInput,
  lines: PurchaseLine[],
  footTaxes: PurchaseFootTax[]
): Promise<{ id: string; fullNumber: string }> {
  const { data, error } = await supabase.rpc('save_purchase_invoice', {
    p_header: {
      kind: header.kind,
      doc_type: header.docType,
      letter: header.letter,
      sales_point: header.salesPoint,
      number: header.number,
      supplier_id: header.supplierId,
      issue_date: header.issueDate,
      received_date: header.receivedDate,
      due_date: header.dueDate,
      payment_terms_days: header.paymentTermsDays,
      general_discount_percent: header.generalDiscountPercent,
      moves_stock: header.movesStock,
      notes: header.notes.trim() || null,
    },
    p_items: lines.map((line) => ({
      article_id: line.articleId,
      concept_id: line.conceptId,
      code: line.code,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      discount_percent: line.discountPercent,
      vat_rate_id: line.vatRateId,
    })),
    p_taxes: footTaxes.map((tax) => ({
      tax_rate_id: tax.taxRateId,
      amount: tax.amount,
    })),
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió el comprobante guardado.');
  return { id: row.purchase_id, fullNumber: row.purchase_full_number };
}

export async function voidPurchaseInvoice(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_purchase_invoice', {
    p_purchase_invoice_id: id,
    p_reason: reason,
  });
  if (error) throw error;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describePurchaseError(message: string): string {
  if (message.includes('purchase_invoices_sin_duplicados')) {
    return 'Ese comprobante ya está cargado para este proveedor. Buscalo en el listado antes de volver a cargarlo.';
  }
  // El vínculo artículo↔proveedor lleva el código propio del proveedor, único
  // por proveedor. Si ya usó ese código para otro artículo, el alta del
  // vínculo rebota con un error que por sí solo no dice nada.
  if (message.includes('article_suppliers_supplier_code_key')) {
    return 'Ese proveedor ya tiene otro artículo cargado con el mismo código. Revisá el vínculo en Inventario antes de cargar la compra.';
  }
  if (message.includes('Stock insuficiente')) {
    return `${message}. No se puede devolver ni anular más mercadería de la que queda en stock.`;
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de compras en la base (supabase/purchases.sql y purchases-articles.sql).';
  }
  return message;
}
