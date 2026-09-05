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

/** Tope de tamaño del archivo a leer. Una foto de celular ronda los 2–5 MB;
 *  arriba de 10 MB casi seguro es un escaneo innecesariamente pesado, y el
 *  viaje entero (subida + base64 + Gemini) se vuelve una espera larga que
 *  después falla del otro lado. */
export const MAX_DRAFT_FILE_BYTES = 10 * 1024 * 1024;

const ACCEPTED_MIME_PREFIXES = ['image/'];
const ACCEPTED_MIME_TYPES = ['application/pdf'];

/** Valida el archivo antes de subirlo. Devuelve el motivo del rechazo, o null si está bien. */
export function describeDraftFileProblem(file: File): string | null {
  const type = file.type || '';
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const looksAccepted =
    ACCEPTED_MIME_TYPES.includes(type) ||
    ACCEPTED_MIME_PREFIXES.some((prefix) => type.startsWith(prefix)) ||
    // Algunos navegadores no informan el type: se cae al de la extensión.
    (type === '' && ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext));

  if (!looksAccepted) {
    return 'Solo se puede subir un PDF o una foto (JPG, PNG). Ese archivo no es ninguno de los dos.';
  }
  if (file.size === 0) {
    return 'El archivo está vacío.';
  }
  if (file.size > MAX_DRAFT_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `El archivo pesa ${mb} MB y el máximo es 10 MB. Sacá la foto con menos resolución o comprimí el PDF.`;
  }
  return null;
}

/** Sube el PDF/foto al bucket de borradores. La Edge Function lo lee después con la service key. */
export async function uploadPurchaseInvoiceDraft(
  file: File
): Promise<{ storagePath: string; mimeType: string }> {
  const problema = describeDraftFileProblem(file);
  if (problema) throw new Error(problema);

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

/**
 * Borradores leídos por IA que todavía no se confirmaron ni descartaron.
 * Incluye los que quedaron en ERROR: si no, un borrador fallido es
 * inalcanzable en cuanto el usuario cierra la pestaña, y con él el botón de
 * reintentar la lectura sobre el archivo ya subido.
 */
export async function fetchPendingExtractions(): Promise<PurchaseExtraction[]> {
  const { data, error } = await supabase
    .from('purchase_invoice_extractions')
    .select(SELECT)
    .in('status', ['EXTRAIDO', 'ERROR'])
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

/**
 * Borra el borrador y el archivo que se había subido.
 *
 * Primero la fila y después el archivo, no al revés: un archivo huérfano no
 * lo ve nadie, pero una fila apuntando a un archivo que ya no está rompe la
 * pantalla de revisión al querer mostrar el adjunto.
 *
 * Un borrador ya confirmado no se puede borrar — lo impide la base, porque es
 * el único rastro que une una compra guardada con el comprobante escaneado.
 */
export async function deleteExtraction(extraction: PurchaseExtraction): Promise<void> {
  const { error } = await supabase.from('purchase_invoice_extractions').delete().eq('id', extraction.id);
  if (error) throw error;

  // El archivo es secundario: si falla su borrado, el borrador ya no existe y
  // la pantalla no tiene por qué mostrar un error por un residuo invisible.
  await supabase.storage.from(BUCKET).remove([extraction.attachmentStoragePath]);
}

/** Qué comprobante es este borrador, para poder distinguir uno de otro en la lista. */
export function describeExtraction(extraction: PurchaseExtraction): string {
  const valores = (extraction.rawExtraction as any)?.valores ?? {};
  const proveedor = String(valores.proveedor_razon_social ?? '').trim();
  const punto = String(valores.punto_venta ?? '').trim();
  const numero = String(valores.numero ?? '').trim();
  const comprobante = punto && numero ? `${punto}-${numero}` : numero;
  return [proveedor, comprobante].filter(Boolean).join(' · ');
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
