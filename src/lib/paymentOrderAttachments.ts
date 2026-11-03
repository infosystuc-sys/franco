import { supabase } from '@/src/lib/supabase';

/**
 * Las constancias del banco (transferencia, eCheq) subidas a una orden de
 * pago. Viajan adjuntas cuando la orden se manda al proveedor. Ver
 * supabase/migrations/20261103_comprobantes_de_pago_en_op.sql.
 */

const BUCKET = 'payment-order-attachments';
/** Una constancia del banco pesa unos cientos de KB; más que esto no viaja bien por WhatsApp. */
const TAMANIO_MAXIMO = 8 * 1024 * 1024;

export interface PaymentOrderAttachment {
  id: string;
  storagePath: string;
  fileName: string;
  sizeBytes: number | null;
  createdAt: string;
}

export async function fetchPaymentOrderAttachments(paymentOrderId: string): Promise<PaymentOrderAttachment[]> {
  const { data, error } = await supabase
    .from('payment_order_attachments')
    .select('id, storage_path, file_name, size_bytes, created_at')
    .eq('payment_order_id', paymentOrderId)
    .order('created_at');
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    storagePath: r.storage_path,
    fileName: r.file_name,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
  }));
}

export async function uploadPaymentOrderAttachment(paymentOrderId: string, file: File): Promise<void> {
  const esPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!esPdf) throw new Error(`${file.name} no es un PDF.`);
  if (file.size > TAMANIO_MAXIMO) throw new Error(`${file.name} pesa más de 8 MB.`);

  const path = `${paymentOrderId}/${crypto.randomUUID()}.pdf`;
  const { error: errorSubida } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: 'application/pdf' });
  if (errorSubida) throw errorSubida;

  const { error } = await supabase.from('payment_order_attachments').insert({
    payment_order_id: paymentOrderId,
    storage_path: path,
    file_name: file.name,
    size_bytes: file.size,
  });
  if (error) {
    // Sin la fila, el archivo quedaría huérfano en el bucket.
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
}

export async function deletePaymentOrderAttachment(attachment: PaymentOrderAttachment): Promise<void> {
  const { error } = await supabase.from('payment_order_attachments').delete().eq('id', attachment.id);
  if (error) throw error;
  await supabase.storage.from(BUCKET).remove([attachment.storagePath]);
}

/** El bucket es privado: se abre con una URL firmada. */
export async function getPaymentOrderAttachmentUrl(attachment: PaymentOrderAttachment): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(attachment.storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

/** Los PDF en base64, para mandarlos junto con la orden. */
export async function loadAttachmentsAsBase64(
  attachments: PaymentOrderAttachment[]
): Promise<{ fileName: string; base64: string }[]> {
  return Promise.all(
    attachments.map(async (a) => {
      const { data, error } = await supabase.storage.from(BUCKET).download(a.storagePath);
      if (error || !data) throw new Error(`No se pudo leer ${a.fileName} para adjuntarlo.`);
      return { fileName: a.fileName, base64: await blobABase64(data) };
    })
  );
}

function blobABase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).replace(/^data:[^,]*,/, ''));
    lector.onerror = () => reject(lector.error);
    lector.readAsDataURL(blob);
  });
}

export function describeAttachmentError(message: string): string {
  if (
    message.includes('payment_order_attachments') ||
    message.toLowerCase().includes('bucket not found')
  ) {
    return 'Falta correr la migración de comprobantes de pago en Supabase: supabase/migrations/20261103_comprobantes_de_pago_en_op.sql.';
  }
  return message;
}
