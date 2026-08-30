import { supabase } from '@/src/lib/supabase';

/**
 * Retenciones sufridas (cobranzas) que quedaron cargadas sin comprobante.
 * El comprobante es opcional al cargar el recibo — receipt_values.certificate_number
 * siempre fue nullable — esto solo lista las que quedaron pendientes y ofrece
 * reclamarlas por WhatsApp.
 */
export interface PendingRetention {
  valueId: string;
  amount: number;
  taxRateName: string;
  receiptId: string;
  receiptFullNumber: string;
  receiptDate: string;
  customerId: string;
  customerName: string;
}

export async function fetchPendingRetentions(): Promise<PendingRetention[]> {
  const { data, error } = await supabase
    .from('receipt_values')
    .select(
      `id, amount,
       rate:tax_rates(name),
       receipt:receipts!inner(id, full_number, receipt_date, customer_id, customer_name, status)`
    )
    .eq('kind', 'RETENCION')
    .is('certificate_number', null)
    .eq('receipt.status', 'REGISTRADO')
    .order('receipt(customer_name)')
    .order('receipt(receipt_date)');

  if (error) throw error;

  return ((data ?? []) as any[]).map((row) => ({
    valueId: row.id,
    amount: Number(row.amount),
    taxRateName: row.rate?.name ?? 'Retención',
    receiptId: row.receipt.id,
    receiptFullNumber: row.receipt.full_number,
    receiptDate: row.receipt.receipt_date,
    customerId: row.receipt.customer_id,
    customerName: row.receipt.customer_name,
  }));
}

export async function claimPendingRetention(receiptValueId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('claim_pending_retention', {
    p_receipt_value_id: receiptValueId,
  });
  if (error) throw error;
  return data ?? null;
}

/** El comprobante llegó: se carga el número y desaparece de la lista de pendientes. */
export async function setRetentionCertificate(receiptValueId: string, certificateNumber: string): Promise<void> {
  const { error } = await supabase.rpc('set_retention_certificate', {
    p_receipt_value_id: receiptValueId,
    p_certificate_number: certificateNumber,
  });
  if (error) throw error;
}
