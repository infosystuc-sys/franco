import { supabase } from '@/src/lib/supabase';
import type { TaxCondition } from '@/src/lib/fiscal';
import type { InvoiceStatus, InvoiceType, InvoiceItem } from '@/src/lib/invoices';

/**
 * Notas de crédito electrónicas.
 *
 * Revierten una factura que ARCA ya autorizó. Para la serie interna X no
 * existen: esa no es fiscal y se sigue anulando.
 *
 * Nacen en PENDIENTE_CAE y pasan a EMITIDA cuando ARCA otorga el CAE, igual
 * que la factura y por lo mismo: pedirlo es una llamada a un tercero que no
 * puede vivir adentro de la transacción que reserva el número.
 */

export interface CreditNoteListRow {
  id: string;
  fullNumber: string;
  invoiceType: InvoiceType;
  status: InvoiceStatus;
  customerName: string;
  issueDate: string;
  totalAmount: number;
  cancelaTotal: boolean;
  caeRechazo: string | null;
  /** La factura que revierte. */
  invoiceFullNumber: string;
  invoiceId: string;
}

export interface CreditNoteDetail extends CreditNoteListRow {
  salesPoint: number;
  number: number;
  netAmount: number;
  vatAmount: number;
  motivo: string | null;

  customerLegalName: string | null;
  customerTaxId: string | null;
  customerTaxCondition: TaxCondition;
  customerAddress: string | null;

  issuerLegalName: string;
  issuerTaxId: string | null;
  issuerTaxCondition: TaxCondition;
  issuerAddress: string | null;
  issuerGrossIncome: string | null;
  issuerActivityStartDate: string | null;

  cae: string | null;
  caeDueDate: string | null;
  caeRechazadoAt: string | null;

  invoiceIssueDate: string;
  items: InvoiceItem[];
}

const LIST_SELECT =
  'id, full_number, invoice_type, status, customer_name, issue_date, total_amount, ' +
  'cancela_total, cae_rechazo, invoice_id, invoice:invoices(full_number)';

function mapListRow(row: any): CreditNoteListRow {
  return {
    id: row.id,
    fullNumber: row.full_number,
    invoiceType: row.invoice_type,
    status: row.status,
    customerName: row.customer_name,
    issueDate: row.issue_date,
    totalAmount: Number(row.total_amount),
    cancelaTotal: row.cancela_total ?? false,
    caeRechazo: row.cae_rechazo ?? null,
    invoiceId: row.invoice_id,
    invoiceFullNumber: row.invoice?.full_number ?? '',
  };
}

export async function fetchCreditNotes(): Promise<CreditNoteListRow[]> {
  const { data, error } = await supabase
    .from('credit_notes')
    .select(LIST_SELECT)
    .order('issue_date', { ascending: false })
    .order('number', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapListRow);
}

export async function fetchCreditNoteById(id: string): Promise<CreditNoteDetail | null> {
  const { data, error } = await supabase
    .from('credit_notes')
    .select(
      'id, full_number, invoice_type, status, customer_name, issue_date, total_amount, cancela_total, cae_rechazo, invoice_id, sales_point, number, net_amount, vat_amount, motivo, customer_legal_name, customer_tax_id, customer_tax_condition, customer_address, issuer_legal_name, issuer_tax_id, issuer_tax_condition, issuer_address, issuer_gross_income, issuer_activity_start_date, cae, cae_due_date, cae_rechazado_at, invoice:invoices(full_number, issue_date), items:credit_note_items(code, description, quantity, unit_price, subtotal, line_number)'
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
    netAmount: Number(row.net_amount),
    vatAmount: Number(row.vat_amount),
    motivo: row.motivo,
    customerLegalName: row.customer_legal_name,
    customerTaxId: row.customer_tax_id,
    customerTaxCondition: row.customer_tax_condition,
    customerAddress: row.customer_address,
    issuerLegalName: row.issuer_legal_name,
    issuerTaxId: row.issuer_tax_id,
    issuerTaxCondition: row.issuer_tax_condition,
    issuerAddress: row.issuer_address,
    issuerGrossIncome: row.issuer_gross_income,
    issuerActivityStartDate: row.issuer_activity_start_date,
    cae: row.cae,
    caeDueDate: row.cae_due_date,
    caeRechazadoAt: row.cae_rechazado_at,
    invoiceIssueDate: row.invoice?.issue_date ?? '',
    items: [...(row.items ?? [])]
      .sort((a: any, b: any) => a.line_number - b.line_number)
      .map((i: any) => ({
        code: i.code,
        description: i.description,
        quantity: Number(i.quantity),
        unitPrice: Number(i.unit_price),
        subtotal: Number(i.subtotal),
      })),
  };
}

export interface CreditNoteItemInput {
  articleId?: string | null;
  code: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export async function emitirNotaCredito(
  invoiceId: string,
  items: CreditNoteItemInput[],
  cancelaTotal: boolean,
  motivo: string
): Promise<{ id: string; fullNumber: string; letter: InvoiceType }> {
  const { data, error } = await supabase.rpc('emitir_nota_credito', {
    p_invoice_id: invoiceId,
    p_items: items.map((i) => ({
      article_id: i.articleId ?? null,
      code: i.code,
      description: i.description,
      quantity: i.quantity,
      unit_price: i.unitPrice,
    })),
    p_cancela_total: cancelaTotal,
    p_motivo: motivo.trim() || null,
  });

  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as any;
  return {
    id: row.credit_note_id,
    fullNumber: row.credit_note_full_number,
    letter: row.credit_note_letter,
  };
}

export interface CobroReversible {
  receiptId: string;
  fullNumber: string;
  totalAmount: number;
}

/**
 * Los recibos que una nota de crédito total va a dar de baja, devolviendo la
 * plata a donde entró.
 *
 * Se consulta antes de emitir y no después: quien emite tiene que saber que
 * además de revertir el comprobante va a salir plata de la caja. Solo devuelve
 * los recibos que cobran esta factura y ninguna otra; los compartidos los
 * resuelve una persona.
 */
export async function fetchCobrosReversibles(invoiceId: string): Promise<CobroReversible[]> {
  const { data, error } = await supabase.rpc('cobros_reversibles_de_factura', {
    p_invoice_id: invoiceId,
  });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    receiptId: row.receipt_id,
    fullNumber: row.full_number,
    totalAmount: Number(row.total_amount),
  }));
}

/** Los mensajes de la base, dichos como los diría alguien del taller. */
export function describeCreditNoteError(message: string): string {
  if (message.includes('admite hasta')) return message;
  if (message.includes('serie interna X')) {
    return 'La serie interna X no lleva nota de crédito: se anula directamente.';
  }
  return message;
}
