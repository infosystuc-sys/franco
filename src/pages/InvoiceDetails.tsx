import React from 'react';
import { XCircle, Printer, Ban, AlertTriangle, Wrench, Mail, MessageCircle } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { sendInvoiceByEmail, sendInvoiceByWhatsapp } from '@/src/lib/invoiceSending';
import {
  balanceOf,
  daysUntilDue,
  describeInvoiceError,
  discriminatesVat,
  fetchInvoiceById,
  formatDate,
  INVOICE_TYPE_LABELS,
  isOverdue,
  paymentStateOf,
  PAYMENT_STATE_LABELS,
  voidInvoice,
  type InvoiceDetail,
} from '@/src/lib/invoices';
import { fetchRemitoByInvoice, type Remito } from '@/src/lib/remitos';

/**
 * La factura emitida. Es a la vez el documento que se imprime: las reglas de
 * @media print (en index.css) esconden menú, botones y pie, y dejan el
 * comprobante solo en la hoja. "Guardar como PDF" del navegador alcanza.
 */
export function InvoiceDetails() {
  const { role } = useAuth();
  const { id } = useParams();

  const [invoice, setInvoice] = React.useState<InvoiceDetail | null>(null);
  const [remito, setRemito] = React.useState<Remito | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [voiding, setVoiding] = React.useState(false);
  const [sendModal, setSendModal] = React.useState<'email' | 'whatsapp' | null>(null);
  const documentRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchInvoiceById(id);
      setInvoice(data);
      // El remito es opcional: si falla la consulta, la factura se sigue viendo igual.
      setRemito(data ? await fetchRemitoByInvoice(data.id).catch(() => null) : null);
    } catch (err) {
      setError(describeInvoiceError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">Cargando factura…</div>;
  }

  if (!invoice) {
    return (
      <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">
        No se encontró la factura.{' '}
        <Link to="/facturas" className="text-accent-deep underline">Ver todas</Link>
      </div>
    );
  }

  const voided = invoice.status === 'ANULADA';
  const overdue = isOverdue(invoice);
  const balance = balanceOf(invoice);
  const days = daysUntilDue(invoice.dueDate);

  async function handleVoid() {
    if (!invoice) return;
    const reason = window.prompt(
      `Anular la ${INVOICE_TYPE_LABELS[invoice.invoiceType]} ${invoice.fullNumber}.\n\n` +
        `La orden ${invoice.workOrderNumber ?? ''} vuelve a quedar facturable.\n` +
        `Indicá el motivo:`
    );
    if (reason === null) return;
    if (reason.trim() === '') {
      setError('Indicá el motivo de la anulación.');
      return;
    }

    setVoiding(true);
    setError(null);
    try {
      await voidInvoice(invoice.id, reason);
      await load();
    } catch (err) {
      setError(describeInvoiceError(getErrorMessage(err)));
    } finally {
      setVoiding(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print">
        <PageHeader
          title={
            <span className="font-mono text-3xl font-medium tracking-normal text-text">
              {invoice.fullNumber}
            </span>
          }
          meta={
            voided ? (
              <span className="inline-flex items-center gap-1.5 bg-panel-head px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                <Ban size={14} /> Anulada
              </span>
            ) : (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]',
                  overdue ? 'bg-danger-soft text-danger' : 'bg-panel-head text-text-soft'
                )}
              >
                {overdue ? <AlertTriangle size={14} /> : null}
                {overdue
                  ? `Vencida hace ${Math.abs(days)} ${Math.abs(days) === 1 ? 'día' : 'días'}`
                  : PAYMENT_STATE_LABELS[paymentStateOf(invoice)]}
              </span>
            )
          }
          subtitle={
            <>
              {invoice.workOrderNumber && (
                <Link
                  to={`/orden/${invoice.workOrderNumber}`}
                  className="inline-flex items-center gap-1.5 text-accent-deep hover:underline"
                >
                  <Wrench size={14} /> Sale de la orden {invoice.workOrderNumber}
                  {invoice.workOrderComponent ? ` · ${invoice.workOrderComponent}` : ''}
                </Link>
              )}
              {remito && (
                <span className="mt-1 block text-text-soft">
                  Con remito {remito.fullNumber}
                  {remito.status === 'ANULADO' && ' (anulado)'}
                </span>
              )}
            </>
          }
          actions={
            <>
              <Link to="/facturas">
                <Button variant="ghost" type="button">
                  <XCircle size={16} /> Volver
                </Button>
              </Link>
              <Button variant="ghost" type="button" onClick={() => window.print()}>
                <Printer size={16} /> Imprimir
              </Button>
              {!voided && (
                <>
                  <Button variant="ghost" type="button" onClick={() => setSendModal('email')}>
                    <Mail size={16} /> Enviar por mail
                  </Button>
                  <Button variant="ghost" type="button" onClick={() => setSendModal('whatsapp')}>
                    <MessageCircle size={16} /> Enviar por WhatsApp
                  </Button>
                </>
              )}
              {!voided && (
                <Button variant="danger" type="button" onClick={handleVoid} disabled={voiding}>
                  <Ban size={16} /> {voiding ? 'Anulando…' : 'Anular'}
                </Button>
              )}
            </>
          }
        />

        {error && (
          <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {voided && (
          <div className="mb-6 flex items-start gap-2 border border-line bg-panel-head px-4 py-3 text-sm">
            <Ban size={16} className="mt-0.5 shrink-0 text-text-soft" />
            <span>
              Anulada el {formatDate(invoice.voidedAt?.slice(0, 10) ?? null)}
              {invoice.voidedReason ? ` · ${invoice.voidedReason}` : ''}.{' '}
              {invoice.workOrderNumber && (
                <Link to={`/facturar/${invoice.workOrderNumber}`} className="text-accent-deep underline">
                  Volver a facturar la orden {invoice.workOrderNumber}
                </Link>
              )}
            </span>
          </div>
        )}

        {!voided && (
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Total" value={`$ ${formatMoney(invoice.totalAmount)}`} />
            <Metric label="Cobrado" value={`$ ${formatMoney(invoice.paidAmount)}`} />
            <Metric label="Saldo" value={`$ ${formatMoney(balance)}`} strong />
            <Metric
              label="Vencimiento"
              value={formatDate(invoice.dueDate)}
              hint={
                balance <= 0
                  ? 'Sin saldo'
                  : days < 0
                    ? `Vencida hace ${Math.abs(days)} d.`
                    : days === 0
                      ? 'Vence hoy'
                      : `En ${days} ${days === 1 ? 'día' : 'días'}`
              }
              danger={overdue}
            />
          </div>
        )}
      </div>

      <div ref={documentRef}>
        <InvoiceDocument invoice={invoice} />
        {remito && <RemitoDocument remito={remito} />}
      </div>

      {sendModal && (
        <SendInvoiceModal
          channel={sendModal}
          invoice={invoice}
          documentRef={documentRef}
          onClose={() => setSendModal(null)}
        />
      )}
    </div>
  );
}

/**
 * El PDF se arma recién al confirmar el envío (no antes): así el destinatario
 * se puede corregir sin pagar el costo de renderizar de nuevo, y el
 * documento que se manda es siempre el que está en pantalla en ese momento.
 */
function SendInvoiceModal({
  channel,
  invoice,
  documentRef,
  onClose,
}: {
  channel: 'email' | 'whatsapp';
  invoice: InvoiceDetail;
  documentRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
}) {
  const isEmail = channel === 'email';
  const [destino, setDestino] = React.useState(
    (isEmail ? invoice.customerEmail : invoice.customerPhone) ?? ''
  );
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
      const fileName = `${invoice.fullNumber}.pdf`;
      if (isEmail) {
        await sendInvoiceByEmail({
          to: destino.trim(),
          fileName,
          pdfBase64,
          subject: `${INVOICE_TYPE_LABELS[invoice.invoiceType]} ${invoice.fullNumber}`,
          text: `Adjuntamos la ${INVOICE_TYPE_LABELS[invoice.invoiceType]} ${invoice.fullNumber} por $ ${formatMoney(invoice.totalAmount)}.`,
        });
      } else {
        await sendInvoiceByWhatsapp({
          phone: destino.trim(),
          fileName,
          pdfBase64,
          caption: `${INVOICE_TYPE_LABELS[invoice.invoiceType]} ${invoice.fullNumber} — $ ${formatMoney(invoice.totalAmount)}`,
        });
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
              {isEmail ? 'Mail del cliente' : 'Teléfono del cliente'}
              <input
                type={isEmail ? 'email' : 'tel'}
                value={destino}
                onChange={(e) => setDestino(e.target.value)}
                placeholder={isEmail ? 'cliente@mail.com' : '5493511234567'}
                className="mt-1 w-full border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
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

/**
 * El remito: mismos renglones que la factura, sin precios. Se imprime junto
 * con la factura (comparte la clase print-document) porque en la práctica
 * viajan juntos con la mercadería.
 */
function RemitoDocument({ remito }: { remito: Remito }) {
  const voided = remito.status === 'ANULADO';
  return (
    <div className="print-document relative mt-6 border border-line bg-panel p-6 md:p-8">
      {voided && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <span className="rotate-[-20deg] border-4 border-danger/40 px-8 py-3 font-display text-6xl font-medium uppercase tracking-[0.1em] text-danger/30">
            Anulado
          </span>
        </div>
      )}

      <div className="flex items-start justify-between border-b-2 border-ink pb-4">
        <div>
          <h3 className="font-display text-xl uppercase tracking-[0.08em] text-text-faint">Remito</h3>
          <p className="mt-1 font-mono text-lg font-semibold text-text">{remito.fullNumber}</p>
        </div>
        <p className="text-[11px] text-text-soft">Fecha de emisión: {formatDate(remito.issueDate)}</p>
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-line py-4 text-[12px] sm:grid-cols-2">
        <Field label="Señor(es)" value={remito.customerLegalName || remito.customerName} />
        <Field
          label="CUIT / CUIL"
          value={remito.customerTaxId ? formatCuit(remito.customerTaxId) : '—'}
          mono
        />
        <Field label="Domicilio" value={remito.customerAddress || '—'} />
      </div>

      <div className="overflow-x-auto py-4">
        <table className="w-full text-left text-[12px]">
          <thead className="border-b-2 border-line-strong text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="w-24 py-1.5 pr-2">Código</th>
              <th className="py-1.5 pr-2">Descripción</th>
              <th className="w-20 py-1.5 text-right">Cantidad</th>
            </tr>
          </thead>
          <tbody>
            {remito.items.map((item, idx) => (
              <tr key={idx} className="border-b border-line">
                <td className="py-1.5 pr-2 font-mono text-text-soft">{item.code ?? ''}</td>
                <td className="py-1.5 pr-2">{item.description}</td>
                <td className="py-1.5 text-right">{item.quantity.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {voided && remito.voidedReason && (
        <p className="mt-3 border-t border-line pt-3 text-[11px] text-text-soft">{remito.voidedReason}</p>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  strong,
  danger,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  danger?: boolean;
}) {
  return (
    <Panel className="p-4">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
        {label}
      </span>
      <span
        className={cn(
          'block font-display text-xl font-medium',
          danger ? 'text-danger' : strong ? 'text-text' : 'text-text-soft'
        )}
      >
        {value}
      </span>
      {hint && <span className="mt-0.5 block text-[11px] text-text-faint">{hint}</span>}
    </Panel>
  );
}

/**
 * El comprobante propiamente dicho. Todo lo que muestra sale de la copia
 * congelada en la factura, no de joins al padrón: si el cliente cambió de
 * CUIT después, acá tiene que seguir figurando el que tenía al emitirse.
 */
function InvoiceDocument({ invoice }: { invoice: InvoiceDetail }) {
  const voided = invoice.status === 'ANULADA';
  const discriminates = discriminatesVat(invoice.invoiceType);

  return (
    <div className="print-document relative border border-line bg-panel p-6 md:p-8">
      {voided && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <span className="rotate-[-20deg] border-4 border-danger/40 px-8 py-3 font-display text-6xl font-medium uppercase tracking-[0.1em] text-danger/30">
            Anulada
          </span>
        </div>
      )}

      {/* Cabecera: emisor · letra · datos del comprobante */}
      <div className="grid grid-cols-1 gap-4 border-b-2 border-ink pb-5 sm:grid-cols-[1fr_auto_1fr]">
        <div>
          <h2 className="font-display text-2xl font-medium uppercase leading-tight text-text">
            {invoice.issuerLegalName}
          </h2>
          <dl className="mt-2 space-y-0.5 text-[11px] text-text-soft">
            {invoice.issuerAddress && <dd>{invoice.issuerAddress}</dd>}
            <dd>{TAX_CONDITION_LABELS[invoice.issuerTaxCondition]}</dd>
            {invoice.issuerTaxId && (
              <dd className="font-mono">CUIT {formatCuit(invoice.issuerTaxId)}</dd>
            )}
            {invoice.issuerGrossIncome && <dd>Ingresos Brutos {invoice.issuerGrossIncome}</dd>}
            {invoice.issuerActivityStartDate && (
              <dd>Inicio de actividades {formatDate(invoice.issuerActivityStartDate)}</dd>
            )}
          </dl>
        </div>

        {/* El recuadro de la letra, como en el comprobante impreso argentino. */}
        <div className="flex flex-col items-center justify-start self-start border-2 border-ink px-5 py-2">
          <span className="font-display text-4xl font-medium leading-none text-text">
            {invoice.invoiceType}
          </span>
          <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            Cód. {invoice.invoiceType === 'A' ? '01' : invoice.invoiceType === 'B' ? '06' : '11'}
          </span>
        </div>

        <div className="sm:text-right">
          <h3 className="font-display text-xl uppercase tracking-[0.08em] text-text-faint">
            {INVOICE_TYPE_LABELS[invoice.invoiceType]}
          </h3>
          <p className="mt-1 font-mono text-lg font-semibold text-text">{invoice.fullNumber}</p>
          <dl className="mt-2 space-y-0.5 text-[11px] text-text-soft">
            <dd>Fecha de emisión: {formatDate(invoice.issueDate)}</dd>
            <dd>Vencimiento: {formatDate(invoice.dueDate)}</dd>
          </dl>
        </div>
      </div>

      {/* Cliente */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-line py-4 text-[12px] sm:grid-cols-2">
        <Field label="Señor(es)" value={invoice.customerLegalName || invoice.customerName} />
        <Field
          label="CUIT / CUIL"
          value={invoice.customerTaxId ? formatCuit(invoice.customerTaxId) : '—'}
          mono
        />
        <Field label="Domicilio" value={invoice.customerAddress || '—'} />
        <Field
          label="Condición frente al IVA"
          value={TAX_CONDITION_LABELS[invoice.customerTaxCondition]}
        />
        <Field
          label="Condición de venta"
          value={`Cuenta corriente · ${invoice.paymentTermsDays} días`}
        />
        {invoice.workOrderNumber && (
          <Field label="Orden de trabajo" value={invoice.workOrderNumber} mono />
        )}
      </div>

      {/* Renglones */}
      <div className="overflow-x-auto py-4">
        <table className="w-full text-left text-[12px]">
          <thead className="border-b-2 border-line-strong text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="w-24 py-1.5 pr-2">Código</th>
              <th className="py-1.5 pr-2">Descripción</th>
              <th className="w-16 py-1.5 pr-2 text-right">Cant.</th>
              <th className="w-28 py-1.5 pr-2 text-right">P. unitario</th>
              <th className="w-28 py-1.5 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, idx) => (
              <tr key={idx} className="border-b border-line">
                <td className="py-1.5 pr-2 font-mono text-text-soft">{item.code ?? ''}</td>
                <td className="py-1.5 pr-2">{item.description}</td>
                <td className="py-1.5 pr-2 text-right">{item.quantity.toFixed(2)}</td>
                <td className="py-1.5 pr-2 text-right">$ {formatMoney(item.unitPrice)}</td>
                <td className="py-1.5 text-right font-semibold">$ {formatMoney(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totales */}
      <div className="flex justify-end border-t-2 border-ink pt-4">
        <div className="w-full space-y-1.5 sm:w-72">
          {discriminates ? (
            <>
              <Total label="Neto gravado" value={invoice.netAmount} />
              <Total label="IVA 21%" value={invoice.vatAmount} />
            </>
          ) : (
            <Total label="Subtotal" value={invoice.totalAmount} />
          )}
          <div className="flex items-baseline justify-between border-t-2 border-accent pt-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
              Total
            </span>
            <span className="font-display text-2xl font-medium text-text">
              $ {formatMoney(invoice.totalAmount)}
            </span>
          </div>
        </div>
      </div>

      {invoice.notes && (
        <div className="mt-5 border-t border-line pt-3">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Observaciones
          </span>
          <p className="whitespace-pre-line text-[12px] text-text-soft">{invoice.notes}</p>
        </div>
      )}

      <p className="mt-6 border-t border-line pt-3 text-center text-[10px] text-text-faint">
        Comprobante no válido como factura: pendiente de autorización de ARCA.
      </p>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <p className="flex gap-1.5">
      <span className="shrink-0 text-text-faint">{label}:</span>
      <span className={cn('font-semibold text-text', mono && 'font-mono')}>{value}</span>
    </p>
  );
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-[12px] text-text-soft">
      <span>{label}</span>
      <span className="text-text">$ {formatMoney(value)}</span>
    </div>
  );
}
