import React from 'react';
import { XCircle, Printer, Ban, FileCheck } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describePaymentOrderError,
  fetchPaymentOrderById,
  isCashValue,
  PAYMENT_VALUE_LABELS,
  PURCHASE_DOC_TYPE_SHORT,
  voidPaymentOrder,
  type PaymentOrder,
  type PaymentValue,
} from '@/src/lib/paymentOrders';

export function PaymentOrderDetails() {
  const { role } = useAuth();
  const { id } = useParams();

  const [order, setOrder] = React.useState<PaymentOrder | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [voiding, setVoiding] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setOrder(await fetchPaymentOrderById(id));
    } catch (err) {
      setError(describePaymentOrderError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="mx-auto max-w-3xl p-8 text-center text-text-soft">Cargando orden…</div>;
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-center text-text-soft">
        No se encontró la orden.{' '}
        <Link to="/pagos" className="text-accent-deep underline">Ver todas</Link>
      </div>
    );
  }

  const voided = order.status === 'ANULADA';
  const cashTotal = order.values.filter((v) => isCashValue(v.kind)).reduce((s, v) => s + v.amount, 0);
  const hasChecks = order.values.some((v) => v.kind === 'CHEQUE_ENDOSADO');

  async function handleVoid() {
    if (!order) return;
    const reason = window.prompt(
      `Anular la orden ${order.fullNumber} de ${order.supplierName}.\n\n` +
        `Los comprobantes vuelven a quedar pendientes, se anula el egreso en el libro de caja` +
        (hasChecks ? ` y los cheques endosados vuelven a la cartera` : '') +
        `.\n\nIndicá el motivo:`
    );
    if (reason === null) return;
    if (reason.trim() === '') {
      setError('Indicá el motivo de la anulación.');
      return;
    }
    setVoiding(true);
    setError(null);
    try {
      await voidPaymentOrder(order.id, reason);
      await load();
    } catch (err) {
      setError(describePaymentOrderError(getErrorMessage(err)));
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
              {order.fullNumber}
            </span>
          }
          meta={
            <span className="inline-flex items-center gap-1.5 rounded bg-panel-head px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
              {voided && <Ban size={14} />}
              {voided ? 'Anulada' : 'Orden de pago'}
            </span>
          }
          subtitle={order.supplierName}
          actions={
            <>
              <Link to="/pagos">
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
          <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {voided && (
          <div className="mb-6 flex items-start gap-2 rounded-md border border-line bg-panel-head px-4 py-3 text-sm">
            <Ban size={16} className="mt-0.5 shrink-0 text-text-soft" />
            <span>
              Anulada el {formatDate(order.voidedAt?.slice(0, 10) ?? null)}
              {order.voidedReason ? ` · ${order.voidedReason}` : ''}. Los comprobantes volvieron a
              quedar pendientes
              {hasChecks && ' y los cheques volvieron a la cartera'}.
            </span>
          </div>
        )}

        {!voided && cashTotal !== order.totalAmount && (
          <div className="mb-6 border border-line bg-panel-alt px-4 py-3 text-xs text-text-soft">
            De los $ {formatMoney(order.totalAmount)} de la orden, salieron de caja{' '}
            <strong className="font-mono text-text">$ {formatMoney(cashTotal)}</strong>. El resto son
            retenciones o saldo a favor: cancelan comprobante pero no son plata que sale.
          </div>
        )}
      </div>

      <div className="print-document border border-line bg-panel p-6 md:p-8">
        <div className="grid grid-cols-1 gap-4 border-b-2 border-ink pb-5 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
              Pagamos a
            </span>
            <h2 className="font-display text-xl font-medium uppercase leading-tight text-text">
              {order.supplierName}
            </h2>
          </div>
          <div className="sm:text-right">
            <h3 className="font-display text-lg uppercase tracking-[0.08em] text-text-faint">
              Orden de pago
            </h3>
            <p className="mt-1 font-mono text-lg font-semibold text-text">{order.fullNumber}</p>
            <p className="mt-1 text-[11px] text-text-soft">Fecha: {formatDate(order.paymentDate)}</p>
          </div>
        </div>

        {/* Imputaciones */}
        <div className="py-4">
          <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
            En cancelación de
          </span>

          {order.allocations.length === 0 ? (
            <p className="text-[12px] text-text-soft">
              Sin imputar: el importe queda a cuenta del proveedor.
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
                {order.allocations.map((a) => (
                  <tr key={a.purchaseInvoiceId ?? a.provisionalCreditNoteId} className="border-b border-line">
                    <td className="py-1.5 font-mono">
                      {a.isProvisional ? (
                        <span className="text-state-done">NC provisoria</span>
                      ) : (
                        <>{PURCHASE_DOC_TYPE_SHORT[a.docType]} {a.letter}</>
                      )}{' '}
                      {a.fullNumber}
                    </td>
                    <td
                      className={cn(
                        'py-1.5 text-right font-semibold',
                        a.amount < 0 && 'text-state-done'
                      )}
                    >
                      {a.amount < 0 ? '−' : ''}$ {formatMoney(Math.abs(a.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Valores */}
        {order.values.length > 0 && (
          <div className="border-t border-line py-4">
            <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
              Entregado en
            </span>
            <table className="w-full text-left text-[12px]">
              <tbody>
                {order.values.map((value, idx) => (
                  <tr key={idx} className="border-b border-line">
                    <td className="py-1.5"><ValueDescription value={value} /></td>
                    <td className="w-32 py-1.5 text-right font-semibold">
                      $ {formatMoney(value.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Totales */}
        <div className="flex justify-end border-t-2 border-ink pt-4">
          <dl className="w-full space-y-1 text-[12px] sm:w-72">
            <div className="flex justify-between">
              <dt className="text-text-soft">Imputado</dt>
              <dd className="font-mono text-text">$ {formatMoney(order.appliedAmount)}</dd>
            </div>
            {order.onAccountAmount > 0 && (
              <div className="flex justify-between">
                <dt className="text-text-soft">A cuenta</dt>
                <dd className="font-mono text-text">$ {formatMoney(order.onAccountAmount)}</dd>
              </div>
            )}
            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                Total pagado
              </dt>
              <dd className="font-display text-2xl font-medium text-text">
                $ {formatMoney(order.totalAmount)}
              </dd>
            </div>
          </dl>
        </div>

        {order.notes && (
          <div className="mt-5 border-t border-line pt-3">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-faint">
              Observaciones
            </span>
            <p className="whitespace-pre-line text-[12px] text-text-soft">{order.notes}</p>
          </div>
        )}

        <div className="mt-10 flex justify-between">
          <div className="w-56 border-t border-line pt-2 text-center text-[10px] uppercase tracking-[0.08em] text-text-faint">
            Por el taller
          </div>
          <div className="w-56 border-t border-line pt-2 text-center text-[10px] uppercase tracking-[0.08em] text-text-faint">
            Recibí conforme
          </div>
        </div>
      </div>
    </div>
  );
}

function ValueDescription({ value }: { value: PaymentValue }) {
  if (value.kind === 'CHEQUE_ENDOSADO') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <FileCheck size={12} className="text-accent-deep" />
        Cheque endosado <span className="font-mono">{value.checkNumber}</span>
        {value.checkBank && <span className="text-text-soft">— {value.checkBank}</span>}
      </span>
    );
  }

  if (value.kind === 'RETENCION') {
    return (
      <span>
        {value.taxRateName ?? 'Retención'}
        {value.certificateNumber && (
          <span className="text-text-soft">
            {' '}— cert. <span className="font-mono">{value.certificateNumber}</span>
          </span>
        )}
      </span>
    );
  }

  if (value.kind === 'MEDIO_PAGO') {
    return <span>{value.paymentMethodName ?? PAYMENT_VALUE_LABELS.MEDIO_PAGO}</span>;
  }

  return <span className="text-text-soft">Saldo a favor de pagos anteriores</span>;
}
