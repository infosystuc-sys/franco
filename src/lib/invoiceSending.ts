import { supabase } from '@/src/lib/supabase';

/** Si ya hay una credencial de Gmail cargada en la bóveda, sin revelarla. */
export async function hasGmailCredential(): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_gmail_credential');
  if (error) throw error;
  return !!data;
}

/** Carga (o reemplaza) la credencial de Gmail. Nunca se vuelve a leer desde acá. */
export async function setGmailCredential(password: string): Promise<void> {
  const { error } = await supabase.rpc('set_gmail_credential', { p_password: password });
  if (error) throw error;
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
  return error instanceof Error ? error.message : 'No se pudo enviar la factura.';
}

/** Manda la factura (PDF en base64, ya armado en el navegador) por mail. */
export async function sendInvoiceByEmail(params: {
  to: string;
  fileName: string;
  pdfBase64: string;
  subject: string;
  text: string;
}): Promise<void> {
  const { error } = await supabase.functions.invoke('enviar-factura', {
    body: {
      accion: 'email',
      destinatario: params.to,
      nombreArchivo: params.fileName,
      archivoBase64: params.pdfBase64,
      asunto: params.subject,
      texto: params.text,
    },
  });
  if (error) throw new Error(await describeFunctionError(error));
}

/** Manda la factura (PDF en base64, ya armado en el navegador) por WhatsApp. */
export async function sendInvoiceByWhatsapp(params: {
  phone: string;
  fileName: string;
  pdfBase64: string;
  caption: string;
}): Promise<void> {
  const { error } = await supabase.functions.invoke('enviar-factura', {
    body: {
      accion: 'whatsapp',
      destinatario: params.phone,
      nombreArchivo: params.fileName,
      archivoBase64: params.pdfBase64,
      texto: params.caption,
    },
  });
  if (error) throw new Error(await describeFunctionError(error));
}
