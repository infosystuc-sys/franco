import React from 'react';
import { XCircle, Ban, AlertTriangle, Printer, Boxes } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { VAT_TREATMENT_LABELS } from '@/src/lib/taxRates';
import {
  balanceOf,
  describePurchaseError,
  fetchPurchaseById,
  formatDate,
  isOverdue,
  PURCHASE_DOC_TYPE_LABELS,
  PURCHASE_KIND_LABELS,
  signOf,
  voidPurchaseInvoice,
  type PurchaseDetail,
} from '@/src/lib/purchases';

export function PurchaseDetails() {
  const { role } = useAuth();
  const { id } = useParams();

  const [doc, setDoc] = React.useState<PurchaseDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [voiding, setVoiding] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setDoc(await fetchPurchaseById(id));
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">Cargando comprobante…</div>;
  }

  if (!doc) {
    return (
      <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">
        No se encontró el comprobante.{' '}
        <Link to="/compras" className="text-accent-deep underline">Ver todos</Link>
      </div>
    );
  }

  const voided = doc.status === 'ANULADA';
  const overdue = isOverdue(doc);
  const isCredit = doc.docType === 'NOTA_CREDITO';

  async function handleVoid() {
    if (!doc) return;
    const reason = window.prompt(
      `Anular ${PURCHASE_DOC_TYPE_LABELS[doc.docType]} ${doc.letter} ${doc.fullNumber} de ${doc.supplierName}.\n\n` +
        `Deja de contar en la cuenta corriente y libera el número para volver a cargarlo.\n` +
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
      await voidPurchaseInvoice(doc.id, reason);
      await load();
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
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
              {doc.letter} {doc.fullNumber}
            </span>
          }
          meta={
            voided ? (
              <span className="inline-flex items-center gap-1.5 bg-panel-head px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                <Ban size={14} /> Anulado
              </span>
            ) : (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]',
                  overdue ? 'bg-danger-soft text-danger' : 'bg-panel-head text-text-soft'
                )}
              >
                {overdue && <AlertTriangle size={14} />}
                {PURCHASE_DOC_TYPE_LABELS[doc.docType]}
                {overdue ? ' · vencida' : ''}
              </span>
            )
          }
          subtitle={
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{doc.supplierName} · compra de {PURCHASE_KIND_LABELS[doc.kind].toLowerCase()}</span>
              {doc.kind === 'ARTICULOS' && (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]',
                    doc.movesStock ? 'bg-panel-head text-text-soft' : 'bg-panel-alt text-text-faint'
                  )}
                >
                  <Boxes size={11} />
                  {doc.movesStock
                    ? doc.docType === 'NOTA_CREDITO'
                      ? 'Descontó stock'
                      : 'Repuso stock'
                    : 'No movió stock'}
                </span>
              )}
            </span>
          }
          actions={
            <>
              <Link to="/compras">
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
          <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
        )}

        {voided && (
          <div className="mb-6 flex items-start gap-2 border border-line bg-panel-head px-4 py-3 text-sm">
            <Ban size={16} className="mt-0.5 shrink-0 text-text-soft" />
            <span>
              Anulado el {formatDate(doc.voidedAt?.slice(0, 10) ?? null)}
              {doc.voidedReason ? ` · ${doc.voidedReason}` : ''}. Ya no cuenta en
              la cuenta corriente del proveedor.
            </span>
          </div>
        )}

        {!voided && (
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Total" value={`$ ${formatMoney(doc.totalAmount)}`} />
            <Metric label={isCredit ? 'Aplicado' : 'Pagado'} value={`$ ${formatMoney(doc.settledAmount)}`} />
            <Metric
              label={isCredit ? 'A aplicar' : 'Saldo'}
              value={`$ ${formatMoney(balanceOf(doc))}`}
              strong
            />
            <Metric
              label="Vencimiento"
              value={formatDate(doc.dueDate)}
              hint={isCredit ? 'Las NC no vencen' : undefined}
              danger={overdue}
            />
          </div>
        )}
      </div>

      <div className="print-document border border-line bg-panel p-6 md:p-8">
        {/* Encabezado */}
        <div className="grid grid-cols-1 gap-4 border-b-2 border-ink pb-5 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
              Proveedor
            </span>
            <h2 className="font-display text-xl font-medium uppercase leading-tight text-text">
              {doc.supplierLegalName || doc.supplierName}
            </h2>
            <dl className="mt-1.5 space-y-0.5 text-[11px] text-text-soft">
              {doc.supplierTaxId && <dd className="font-mono">CUIT {formatCuit(doc.supplierTaxId)}</dd>}
              <dd>{TAX_CONDITION_LABELS[doc.supplierTaxCondition]}</dd>
            </dl>
          </div>

          <div className="sm:text-right">
            <h3 className="font-display text-lg uppercase tracking-[0.08em] text-text-faint">
              {PURCHASE_DOC_TYPE_LABELS[doc.docType]} {doc.letter}
            </h3>
            <p className="mt-1 font-mono text-lg font-semibold text-text">{doc.fullNumber}</p>
            <dl className="mt-1.5 space-y-0.5 text-[11px] text-text-soft">
              <dd>Fecha del comprobante: {formatDate(doc.issueDate)}</dd>
              <dd>Recibido: {formatDate(doc.receivedDate)}</dd>
              <dd>Vencimiento: {formatDate(doc.dueDate)} ({doc.paymentTermsDays} días)</dd>
            </dl>
          </div>
        </div>

        {/* Cuerpo */}
        <div className="overflow-x-auto py-4">
          <table className="w-full text-left text-[12px]">
            <thead className="border-b-2 border-line-strong text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="w-36 py-1.5 pr-2">{doc.kind === 'ARTICULOS' ? 'Código' : 'Concepto'}</th>
                <th className="py-1.5 pr-2">Detalle</th>
                <th className="w-14 py-1.5 pr-2 text-right">Cant.</th>
                <th className="w-24 py-1.5 pr-2 text-right">P. unit.</th>
                <th className="w-16 py-1.5 pr-2 text-right">Bonif.</th>
                <th className="w-20 py-1.5 pr-2">IVA</th>
                <th className="w-24 py-1.5 text-right">Neto</th>
              </tr>
            </thead>
            <tbody>
              {doc.items.map((item) => (
                <tr key={item.lineNumber} className="border-b border-line">
                  <td className="py-1.5 pr-2 font-mono text-text-soft">
                    {doc.kind === 'ARTICULOS' ? (item.code ?? '—') : (item.conceptName ?? '—')}
                  </td>
                  <td className="py-1.5 pr-2">{item.description}</td>
                  <td className="py-1.5 pr-2 text-right">{item.quantity.toFixed(2)}</td>
                  <td className="py-1.5 pr-2 text-right">$ {formatMoney(item.unitPrice)}</td>
                  <td className="py-1.5 pr-2 text-right">
                    {item.discountPercent > 0 ? `${item.discountPercent}%` : '—'}
                  </td>
                  <td className="py-1.5 pr-2 text-text-soft">
                    {item.vatTreatment === 'GRAVADO'
                      ? `${item.vatRate}%`
                      : VAT_TREATMENT_LABELS[item.vatTreatment]}
                  </td>
                  <td className="py-1.5 text-right font-semibold">$ {formatMoney(item.netAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pie */}
        <div className="flex justify-end border-t-2 border-ink pt-4">
          <dl className="w-full space-y-1 text-[12px] sm:w-80">
            <FootRow label="Bruto" value={doc.grossAmount} />
            {doc.lineDiscountAmount > 0 && (
              <FootRow label="Bonificación por renglón" value={-doc.lineDiscountAmount} muted />
            )}
            {doc.generalDiscountAmount > 0 && (
              <FootRow
                label={`Bonificación general ${doc.generalDiscountPercent}%`}
                value={-doc.generalDiscountAmount}
                muted
              />
            )}

            <div className="my-1.5 border-t border-line" />

            {doc.netTaxed > 0 && <FootRow label="Neto gravado" value={doc.netTaxed} />}
            {doc.netExempt > 0 && <FootRow label="Neto exento" value={doc.netExempt} />}
            {doc.netUntaxed > 0 && <FootRow label="Neto no gravado" value={doc.netUntaxed} />}
            {doc.vatAmount > 0 && <FootRow label="IVA" value={doc.vatAmount} />}

            {doc.taxes.map((tax, idx) => (
              <FootRow key={idx} label={`${tax.name} ${tax.rate}%`} value={tax.amount} />
            ))}

            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                Total {isCredit && '(resta en cuenta corriente)'}
              </dt>
              <dd className="font-display text-2xl font-medium text-text">
                {signOf(doc.docType) < 0 ? '−' : ''}$ {formatMoney(doc.totalAmount)}
              </dd>
            </div>
          </dl>
        </div>

        {doc.notes && (
          <div className="mt-5 border-t border-line pt-3">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-faint">
              Observaciones
            </span>
            <p className="whitespace-pre-line text-[12px] text-text-soft">{doc.notes}</p>
          </div>
        )}
      </div>
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

function FootRow({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-text-faint' : 'text-text-soft'}>{label}</dt>
      <dd className={cn('font-mono', muted ? 'text-text-faint' : 'text-text')}>
        {value < 0 ? '−' : ''}$ {formatMoney(Math.abs(value))}
      </dd>
    </div>
  );
}
