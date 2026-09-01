// src/lib/purchaseExtractions.ts
import { supabase } from '@/src/lib/supabase';
import type { PurchaseKind } from '@/src/lib/purchases';

/**
 * Borrador de una factura de compra leída por IA: desde que se sube el
 * archivo hasta que se confirma como comprobante real (o se descarta). El
 * archivo vive en el bucket privado purchase-invoice-drafts; el resultado
 * crudo de Gemini (valores + confianza por campo) en raw_extraction.
 */
const BUCKET = 'purchase-invoice-drafts';

export type PurchaseExtractionStatus = 'EXTRAIDO' | 'CONFIRMADO' | 'DESCARTADO' | 'ERROR';

/** Forma cruda que devuelve la Edge Function (ver Task 6) — sin tipar campo
 *  por campo acá: la pantalla de revisión (Task 9) es la que interpreta
 *  valores/confianzas/renglones según el kind. */
export type RawExtraction = Record<string, unknown>;

export interface PurchaseExtraction {
  id: string;
  kind: PurchaseKind;
  supplierId: string | null;
  attachmentStoragePath: string;
  attachmentMimeType: string;
  rawExtraction: RawExtraction | null;
  status: PurchaseExtractionStatus;
  errorMessage: string | null;
  purchaseInvoiceId: string | null;
  createdAt: string;
}

const SELECT =
  'id, kind, supplier_id, attachment_storage_path, attachment_mime_type, raw_extraction, status, error_message, purchase_invoice_id, created_at';

function mapExtraction(row: any): PurchaseExtraction {
  return {
    id: row.id,
    kind: row.kind,
    supplierId: row.supplier_id,
    attachmentStoragePath: row.attachment_storage_path,
    attachmentMimeType: row.attachment_mime_type,
    rawExtraction: row.raw_extraction,
    status: row.status,
    errorMessage: row.error_message,
    purchaseInvoiceId: row.purchase_invoice_id,
    createdAt: row.created_at,
  };
}

/** Sube el PDF/foto al bucket de borradores. La Edge Function lo lee después con la service key. */
export async function uploadPurchaseInvoiceDraft(
  file: File
): Promise<{ storagePath: string; mimeType: string }> {
  const ext = file.name.split('.').pop() || (file.type === 'application/pdf' ? 'pdf' : 'jpg');
  const path = `${crypto.randomUUID()}.${ext}`;
  const mimeType = file.type || (ext === 'pdf' ? 'application/pdf' : 'image/jpeg');

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: mimeType });
  if (error) throw error;

  return { storagePath: path, mimeType };
}

async function describeFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error) return String(body.error);
    } catch {
      // El cuerpo no era JSON: se sigue con el mensaje genérico de abajo.
    }
  }
  return error instanceof Error ? error.message : 'No se pudo leer la factura con IA.';
}

/** Llama a la Edge Function que lee el archivo con Gemini y arma el borrador. */
export async function requestExtraction(params: {
  storagePath: string;
  mimeType: string;
  kind: PurchaseKind;
}): Promise<{ id: string }> {
  const { data, error } = await supabase.functions.invoke('extraer-factura-compra', {
    body: {
      attachment_storage_path: params.storagePath,
      mime_type: params.mimeType,
      kind: params.kind,
    },
  });
  if (error) throw new Error(await describeFunctionError(error));
  if (!data?.id) throw new Error('La función no devolvió el borrador leído.');
  return { id: data.id };
}

export async function fetchExtractionById(id: string): Promise<PurchaseExtraction | null> {
  const { data, error } = await supabase.from('purchase_invoice_extractions').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapExtraction(data) : null;
}

/** Borradores leídos por IA que todavía no se confirmaron ni descartaron. */
export async function fetchPendingExtractions(): Promise<PurchaseExtraction[]> {
  const { data, error } = await supabase
    .from('purchase_invoice_extractions')
    .select(SELECT)
    .eq('status', 'EXTRAIDO')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapExtraction);
}

/** Marca el borrador confirmado, ligado al comprobante recién guardado con savePurchaseInvoice. */
export async function confirmExtraction(id: string, purchaseInvoiceId: string): Promise<void> {
  const { error } = await supabase
    .from('purchase_invoice_extractions')
    .update({ status: 'CONFIRMADO', purchase_invoice_id: purchaseInvoiceId })
    .eq('id', id);
  if (error) throw error;
}

export async function discardExtraction(id: string): Promise<void> {
  const { error } = await supabase
    .from('purchase_invoice_extractions')
    .update({ status: 'DESCARTADO' })
    .eq('id', id);
  if (error) throw error;
}

/** El bucket es privado: se muestra con una URL firmada, nunca con getPublicUrl. */
export async function getDraftAttachmentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

export function describeExtractionError(message: string): string {
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de facturas con IA en la base (supabase/purchase-invoice-extractions.sql).';
  }
  return message;
}
