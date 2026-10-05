import React from 'react';
import { Button, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { sendInvoiceByEmail, sendInvoiceByWhatsapp } from '@/src/lib/invoiceSending';
import type { ContactoDeEnvio } from '@/src/lib/customers';

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
  onSent,
  contactos,
}: {
  channel: 'email' | 'whatsapp';
  defaultDestino: string | null;
  /**
   * El contacto general del cliente y sus sectores. Con más de uno, se elige
   * a quién mandarlo y el campo se completa con su mail o teléfono.
   */
  contactos?: ContactoDeEnvio[];
  fileName: string;
  documentRef: React.RefObject<HTMLDivElement>;
  subject: string;
  text: string;
  onClose: () => void;
  /** Para dejar marcado el comprobante como enviado en su listado. */
  onSent?: () => Promise<void> | void;
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
      // Ya salió: si la marca falla, el envío no se deshace ni se avisa como error.
      try {
        await onSent?.();
      } catch {
        // sin marca de enviado: no es motivo para decir que falló el envío
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Panel className="max-h-[90vh] w-full max-w-sm overflow-y-auto p-5">
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
            {contactos && contactos.length > 1 && (
              <label className="mt-3 block text-xs font-bold uppercase tracking-wider text-text-soft">
                Enviar a
                <select
                  value={String(contactos.findIndex((c) => (isEmail ? c.email : c.phone) === destino))}
                  onChange={(e) => {
                    const c = contactos[Number(e.target.value)];
                    if (c) setDestino((isEmail ? c.email : c.phone) ?? '');
                  }}
                  className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
                >
                  <option value="-1" disabled>Otro destinatario</option>
                  {contactos.map((c, i) => {
                    const valor = isEmail ? c.email : c.phone;
                    return (
                      <option key={i} value={String(i)} disabled={!valor}>
                        {c.label} — {valor ?? (isEmail ? 'sin mail' : 'sin teléfono')}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
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
