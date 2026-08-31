import React from 'react';
import { Button, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { sendInvoiceByEmail, sendInvoiceByWhatsapp } from '@/src/lib/invoiceSending';

/**
 * Modal de envío por mail o WhatsApp, compartido por facturas, cotizaciones y
 * órdenes de pago: arma el PDF recién al confirmar (no antes), así el
 * destinatario se puede corregir sin pagar el costo de renderizar de nuevo, y
 * el documento que se manda es siempre el que está en pantalla en ese
 * momento.
 */
export function SendDocumentModal({
  channel,
  defaultDestino,
  fileName,
  documentRef,
  subject,
  text,
  onClose,
}: {
  channel: 'email' | 'whatsapp';
  defaultDestino: string | null;
  fileName: string;
  documentRef: React.RefObject<HTMLDivElement>;
  subject: string;
  text: string;
  onClose: () => void;
}) {
  const isEmail = channel === 'email';
  const [destino, setDestino] = React.useState(defaultDestino ?? '');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  async function handleSend() {
    if (!destino.trim() || !documentRef.current) return;
    setSending(true);
    setError(null);
    try {
      const { renderElementToPdfBase64 } = await import('@/src/lib/pdf');
      const pdfBase64 = await renderElementToPdfBase64(documentRef.current);
      if (isEmail) {
        await sendInvoiceByEmail({ to: destino.trim(), fileName, pdfBase64, subject, text });
      } else {
        await sendInvoiceByWhatsapp({ phone: destino.trim(), fileName, pdfBase64, caption: text });
      }
      setSent(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Panel className="w-full max-w-sm p-5">
        <h3 className="text-sm font-bold uppercase tracking-wider text-text">
          {isEmail ? 'Enviar por mail' : 'Enviar por WhatsApp'}
        </h3>

        {sent ? (
          <>
            <p className="mt-3 text-sm text-text-soft">
              {isEmail ? 'Mail enviado.' : 'Mensaje de WhatsApp enviado.'}
            </p>
            <div className="mt-4 flex justify-end">
              <Button type="button" onClick={onClose}>Cerrar</Button>
            </div>
          </>
        ) : (
          <>
            <label className="mt-3 block text-xs font-bold uppercase tracking-wider text-text-soft">
              {isEmail ? 'Mail del destinatario' : 'Teléfono del destinatario'}
              <input
                type={isEmail ? 'email' : 'tel'}
                value={destino}
                onChange={(e) => setDestino(e.target.value)}
                placeholder={isEmail ? 'cliente@mail.com' : '5493511234567'}
                className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
                autoFocus
              />
            </label>

            {error && (
              <p className="mt-3 text-xs text-danger">{error}</p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={onClose} disabled={sending}>
                Cancelar
              </Button>
              <Button type="button" onClick={handleSend} disabled={sending || !destino.trim()}>
                {sending ? 'Enviando…' : 'Enviar'}
              </Button>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
