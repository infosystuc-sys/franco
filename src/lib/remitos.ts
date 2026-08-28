import { supabase } from '@/src/lib/supabase';

export type RemitoStatus = 'EMITIDO' | 'ANULADO';

export interface RemitoItem {
  code: string | null;
  description: string;
  quantity: number;
}

export interface Remito {
  id: string;
  fullNumber: string;
  status: RemitoStatus;
  invoiceId: string;
  customerName: string;
  customerLegalName: string | null;
  customerTaxId: string | null;
  customerAddress: string | null;
  issueDate: string;
  voidedReason: string | null;
  items: RemitoItem[];
}

function mapRemito(row: any): Remito {
  return {
    id: row.id,
    fullNumber: row.full_number,
    status: row.status,
    invoiceId: row.invoice_id,
    customerName: row.customer_name,
    customerLegalName: row.customer_legal_name,
    customerTaxId: row.customer_tax_id,
    customerAddress: row.customer_address,
    issueDate: row.issue_date,
    voidedReason: row.voided_reason,
    items: (row.items ?? [])
      .slice()
      .sort((a: any, b: any) => a.line_number - b.line_number)
      .map((item: any) => ({
        code: item.code,
        description: item.description,
        quantity: Number(item.quantity),
      })),
  };
}

const SELECT =
  'id, full_number, status, invoice_id, customer_name, customer_legal_name, customer_tax_id, customer_address, issue_date, voided_reason, items:remito_items(code, description, quantity, line_number)';

export async function fetchRemitoByInvoice(invoiceId: string): Promise<Remito | null> {
  const { data, error } = await supabase
    .from('remitos')
    .select(SELECT)
    .eq('invoice_id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRemito(data) : null;
}
