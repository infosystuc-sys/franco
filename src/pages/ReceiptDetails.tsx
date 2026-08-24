import React from 'react';
import { XCircle, Printer, Ban, FileCheck } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describeReceiptError,
  fetchReceiptById,
  isCashValue,
  VALUE_KIND_LABELS,
  voidReceipt,
  type Receipt,
  type ReceiptValue,
} from '@/src/lib/receipts';

/**
 * El recibo emitido, que es a la vez el documento imprimible: las reglas de
 * @media print esconden menú y botones y dejan el comprobante solo en la hoja.
 */
export function ReceiptDetails() {
  const { role } = useAuth();
  const { id } = useParams();

  const [receipt, setReceipt] = React.useState<Receipt | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [voiding, setVoiding] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setReceipt(await fetchReceiptById(id));
    } catch (err) {
      setError(describeReceiptError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="mx-auto max-w-3xl p-8 text-center text-text-soft">Cargando recibo…</div>;
  }

  if (!receipt) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-center text-text-soft">
        No se encontró el recibo.{' '}
        <Link to="/cobranzas" className="text-accent-deep underline">Ver todos</Link>
      </div>
    );
  }

  const voided = receipt.status === 'ANULADO';
  const cashTotal = receipt.values
    .filter((v) => isCashValue(v.kind))
    .reduce((sum, v) => sum + v.amount, 0);

  async function handleVoid() {
    if (!receipt) return;
    const reason = window.prompt(
      `Anular el recibo ${receipt.fullNumber} de ${receipt.customerName}.\n\n` +
        `Las facturas vuelven a quedar impagas, se anula el ingreso en el libro de caja ` +
        `y los cheques salen de la cartera.\n\nIndicá el motivo:`
    );
    if (reason === null) return;
    if (reason.trim() === '') {
      setError('Indicá el motivo de la anulación.');
      return;
    }
    setVoiding(true);
    setError(null);
    try {
      await voidReceipt(receipt.id, reason);
      await load();
    } catch (err) {
      setError(describeReceiptError(getErrorMessage(err)));
    } finally {
      setVoiding(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print">
        <PageHeader
          title={
            <span className="font-mono text-3xl font-medium tracking-normal text-text">
              {receipt.fullNumber}
            </span>
          }
          meta={
            voided ? (
              <span className="inline-flex items-center gap-1.5 bg-panel-head px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                <Ban size={14} /> Anulado
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 bg-panel-head px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                Recibo de cobranza
              </span>
            )
          }
          subtitle={receipt.customerName}
          actions={
            <>
              <Link to="/cobranzas">
                <Button variant="ghost" type="button"><XCircle size={16} /> Volver</Button>
              </Link>
              <Button variant="ghost" type="button" onClick={() => window.print()}>
                <Printer size={16} /> Imprimir
              </Button>
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
              Anulado el {formatDate(receipt.voidedAt?.slice(0, 10) ?? null)}
              {receipt.voidedReason ? ` · ${receipt.voidedReason}` : ''}. Las facturas volvieron a
              quedar impagas y el ingreso se anuló en el libro de caja.
            </span>
          </div>
        )}

        {!voided && cashTotal !== receipt.totalAmount && (
          <div className="mb-6 border border-line bg-panel-alt px-4 py-3 text-xs text-text-soft">
            De los $ {formatMoney(receipt.totalAmount)} cobrados, entraron a caja{' '}
            <strong className="font-mono text-text">$ {formatMoney(cashTotal)}</strong>. El resto son
            retenciones o saldo a favor: cancelan factura pero no son plata que ingresa.
          </div>
        )}
      </div>

      <div className="print-document border border-line bg-panel p-6 md:p-8">
        <div className="grid grid-cols-1 gap-4 border-b-2 border-ink pb-5 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
              Recibimos de
            </span>
            <h2 className="font-display text-xl font-medium uppercase leading-tight text-text">
              {receipt.customerName}
            </h2>
          </div>
          <div className="sm:text-right">
            <h3 className="font-display text-lg uppercase tracking-[0.08em] text-text-faint">
              Recibo de cobranza
            </h3>
            <p className="mt-1 font-mono text-lg font-semibold text-text">{receipt.fullNumber}</p>
            <p className="mt-1 text-[11px] text-text-soft">Fecha: {formatDate(receipt.receiptDate)}</p>
          </div>
        </div>

        {/* Imputaciones */}
        <div className="py-4">
          <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
            En cancelación de
          </span>

          {receipt.allocations.length === 0 ? (
            <p className="text-[12px] text-text-soft">
              Sin imputar: el importe queda a cuenta del cliente.
            </p>
          ) : (
            <table className="w-full text-left text-[12px]">
              <thead className="border-b border-line text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <tr>
                  <th className="py-1.5">Comprobante</th>
                  <th className="w-32 py-1.5 text-right">Importe</th>
                </tr>
              </thead>
              <tbody>
                {receipt.allocations.map((a) => (
                  <tr key={a.invoiceId} className="border-b border-line">
                    <td className="py-1.5 font-mono">{a.invoiceType} {a.invoiceFullNumber}</td>
                    <td className="py-1.5 text-right font-semibold">$ {formatMoney(a.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Valores */}
        <div className="border-t border-line py-4">
          <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
            Recibido en
          </span>
          <table className="w-full text-left text-[12px]">
            <tbody>
              {receipt.values.map((value, idx) => (
                <tr key={idx} className="border-b border-line">
                  <td className="py-1.5">
                    <ValueDescription value={value} />
                  </td>
                  <td className="w-32 py-1.5 text-right font-semibold">$ {formatMoney(value.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totales */}
        <div className="flex justify-end border-t-2 border-ink pt-4">
          <dl className="w-full space-y-1 text-[12px] sm:w-72">
            <div className="flex justify-between">
              <dt className="text-text-soft">Imputado</dt>
              <dd className="font-mono text-text">$ {formatMoney(receipt.appliedAmount)}</dd>
            </div>
            {receipt.onAccountAmount > 0 && (
              <div className="flex justify-between">
                <dt className="text-text-soft">A cuenta</dt>
                <dd className="font-mono text-text">$ {formatMoney(receipt.onAccountAmount)}</dd>
              </div>
            )}
            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                Total recibido
              </dt>
              <dd className="font-display text-2xl font-medium text-text">
                $ {formatMoney(receipt.totalAmount)}
              </dd>
            </div>
          </dl>
        </div>

        {receipt.notes && (
          <div className="mt-5 border-t border-line pt-3">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-faint">
              Observaciones
            </span>
            <p className="whitespace-pre-line text-[12px] text-text-soft">{receipt.notes}</p>
          </div>
        )}

        <div className="mt-10 flex justify-end">
          <div className="w-56 border-t border-line pt-2 text-center text-[10px] uppercase tracking-[0.08em] text-text-faint">
            Firma y sello
          </div>
        </div>
      </div>
    </div>
  );
}

/** Cada tipo de valor se describe con lo que lo identifica de verdad. */
function ValueDescription({ value }: { value: ReceiptValue }) {
  if (value.kind === 'CHEQUE') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <FileCheck size={12} className="text-accent-deep" />
        Cheque <span className="font-mono">{value.checkNumber}</span>
        {value.checkBank && <span className="text-text-soft">— {value.checkBank}</span>}
      </span>
    );
  }

  if (value.kind === 'RETENCION') {
    return (
      <span>
        {value.taxRateName ?? 'Retención'}
        {value.certificateNumber && (
          <span className="text-text-soft"> — cert. <span className="font-mono">{value.certificateNumber}</span></span>
        )}
      </span>
    );
  }

  if (value.kind === 'MEDIO_PAGO') {
    return <span>{value.paymentMethodName ?? VALUE_KIND_LABELS.MEDIO_PAGO}</span>;
  }

  return <span className="text-text-soft">Saldo a favor de cobros anteriores</span>;
}
