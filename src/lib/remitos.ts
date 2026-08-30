import { supabase } from '@/src/lib/supabase';

export type RemitoStatus = 'EMITIDO' | 'ANULADO';

export interface RemitoItem {
  articleId: string | null;
  code: string | null;
  description: string;
  quantity: number;
}

export interface Remito {
  id: string;
  fullNumber: string;
  status: RemitoStatus;
  invoiceId: string | null;
  customerId: string;
  customerName: string;
  customerLegalName: string | null;
  customerTaxId: string | null;
  customerAddress: string | null;
  issueDate: string;
  notes: string | null;
  voidedReason: string | null;
  items: RemitoItem[];
}

/** Un remito sin factura vinculada: entregado, todavía sin valorizar ni facturar. */
export function isPending(remito: Pick<Remito, 'invoiceId' | 'status'>): boolean {
  return remito.invoiceId === null && remito.status === 'EMITIDO';
}

function mapRemito(row: any): Remito {
  return {
    id: row.id,
    fullNumber: row.full_number,
    status: row.status,
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerLegalName: row.customer_legal_name,
    customerTaxId: row.customer_tax_id,
    customerAddress: row.customer_address,
    issueDate: row.issue_date,
    notes: row.notes,
    voidedReason: row.voided_reason,
    items: (row.items ?? [])
      .slice()
      .sort((a: any, b: any) => a.line_number - b.line_number)
      .map((item: any) => ({
        articleId: item.article_id,
        code: item.code,
        description: item.description,
        quantity: Number(item.quantity),
      })),
  };
}

const SELECT =
  `id, full_number, status, invoice_id, customer_id, customer_name, customer_legal_name, customer_tax_id,
   customer_address, issue_date, notes, voided_reason,
   items:remito_items(article_id, code, description, quantity, line_number)`;

export async function fetchRemitoByInvoice(invoiceId: string): Promise<Remito | null> {
  const { data, error } = await supabase
    .from('remitos')
    .select(SELECT)
    .eq('invoice_id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRemito(data) : null;
}

export async function fetchRemitoById(id: string): Promise<Remito | null> {
  const { data, error } = await supabase.from('remitos').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapRemito(data) : null;
}

export interface RemitoListRow {
  id: string;
  fullNumber: string;
  status: RemitoStatus;
  invoiceId: string | null;
  invoiceFullNumber: string | null;
  customerName: string;
  issueDate: string;
  itemCount: number;
}

export async function fetchRemitos(): Promise<RemitoListRow[]> {
  const { data, error } = await supabase
    .from('remitos')
    .select(
      `id, full_number, status, invoice_id, customer_name, issue_date,
       invoice:invoices(full_number),
       items:remito_items(id)`
    )
    .order('issue_date', { ascending: false })
    .order('number', { ascending: false });
  if (error) throw error;

  return ((data ?? []) as any[]).map((row) => ({
    id: row.id,
    fullNumber: row.full_number,
    status: row.status,
    invoiceId: row.invoice_id,
    invoiceFullNumber: row.invoice?.full_number ?? null,
    customerName: row.customer_name,
    issueDate: row.issue_date,
    itemCount: (row.items ?? []).length,
  }));
}

export interface RemitoItemInput {
  articleId: string | null;
  code: string;
  description: string;
  quantity: number;
}

/**
 * Remito sin factura: registra qué se entregó, sin precio — se valoriza
 * recién al facturarlo. Reusa el mismo ItemsEditor que las facturas, pero
 * los importes que se carguen ahí son solo de referencia: create_remito no
 * los guarda.
 */
export async function createRemito(
  customerId: string,
  items: RemitoItemInput[],
  notes: string
): Promise<{ id: string; fullNumber: string }> {
  const { data, error } = await supabase.rpc('create_remito', {
    p_customer_id: customerId,
    p_items: items.map((item) => ({
      article_id: item.articleId,
      code: item.code,
      description: item.description,
      quantity: item.quantity,
    })),
    p_notes: notes.trim() || null,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió el remito creado.');
  return { id: row.remito_id, fullNumber: row.remito_full_number };
}

export async function voidRemito(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_remito', { p_remito_id: id, p_reason: reason });
  if (error) throw error;
}

export function describeRemitoError(message: string): string {
  if (message.includes('ya está facturado')) return message;
  if (message.includes('ya está anulado')) return message;
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de remitos sueltos en la base (supabase/remitos-standalone.sql).';
  }
  return message;
}
