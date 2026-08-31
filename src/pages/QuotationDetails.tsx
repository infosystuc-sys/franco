import React from 'react';
import {
  ArrowLeft,
  Save,
  Send,
  Check,
  XCircle,
  FileCheck2,
  AlertTriangle,
  Lock,
  ArrowRight,
  ThumbsDown,
  Printer,
  Mail,
  MessageCircle,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { SendDocumentModal } from '@/src/components/SendDocumentModal';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { formatCuit } from '@/src/lib/fiscal';
import { getErrorMessage, type WorkOrderItemInput } from '@/src/lib/workOrders';
import {
  convertToWorkOrder,
  fetchQuotationByNumber,
  isExpired,
  isQuotationEditable,
  QUOTATION_STATUS_BADGE,
  QUOTATION_STATUS_LABELS,
  QUOTATION_STATUS_STRIP,
  saveQuotationItems,
  updateQuotationHeader,
  updateQuotationStatus,
  type QuotationDetail,
} from '@/src/lib/quotations';

const QUOTATION_IVA_RATE = 0.21;

export function QuotationDetails() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const { number } = useParams();
  const navigate = useNavigate();

  const [quotation, setQuotation] = React.useState<QuotationDetail | null>(null);
  const [items, setItems] = React.useState<WorkOrderItemInput[]>([]);
  const [component, setComponent] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [validUntil, setValidUntil] = React.useState('');
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [sendModal, setSendModal] = React.useState<'email' | 'whatsapp' | null>(null);
  const documentRef = React.useRef<HTMLDivElement>(null);

  const loadQuotation = React.useCallback(async () => {
    if (!number) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchQuotationByNumber(number);
      setQuotation(data);
      setItems(data?.items ?? []);
      setComponent(data?.component ?? '');
      setNotes(data?.notes ?? '');
      setValidUntil(data?.validUntil ?? '');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [number]);

  React.useEffect(() => { loadQuotation(); }, [loadQuotation]);

  React.useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetchArticles(false)
      .then((data) => !cancelled && setArticles(data))
      .catch(() => {/* el catálogo es opcional: se pueden cargar líneas manuales */});
    return () => { cancelled = true; };
  }, [isAdmin]);

  if (loading) {
    return <div className="max-w-7xl mx-auto p-8 text-center text-text-soft">Cargando cotización...</div>;
  }

  if (!quotation) {
    return (
      <div className="max-w-7xl mx-auto p-8 text-center text-text-soft">
        No se encontró la cotización {number}.{' '}
        <Link to="/cotizaciones" className="text-accent-deep underline">Volver al listado</Link>
      </div>
    );
  }

  const frozen = !isQuotationEditable(quotation.status);
  const editable = isAdmin && !frozen;
  const expired = isExpired(quotation.validUntil, quotation.status);
  // Refleja lo que está en pantalla, no necesariamente lo último guardado:
  // si agregaron renglones y todavía no guardaron, igual habilita enviar. La
  // base es la que de verdad impide dejarla vacía, esto es solo la UX rápida.
  const hasItems = items.length > 0;

  async function run(action: () => Promise<void>, successMessage?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successMessage) setNotice(successMessage);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const handleSave = () => run(async () => {
    await updateQuotationHeader(quotation.id, { component, notes, validUntil });
    await saveQuotationItems(quotation.id, items);
    await loadQuotation();
  }, 'Cambios guardados.');

  const handleStatus = (status: QuotationDetail['status'], message: string) => run(async () => {
    await updateQuotationStatus(quotation.id, status);
    await loadQuotation();
  }, message);

  function handleSend() {
    if (items.length === 0) {
      setNotice(null);
      setError('No se puede enviar: cargá al menos un renglón antes de enviarla.');
      return;
    }
    handleStatus('ENVIADA', 'Cotización marcada como enviada.');
  }

  const handleConvert = () => run(async () => {
    const created = await convertToWorkOrder(quotation.id);
    navigate(`/orden/${created.number}`);
  });

  const itemsTotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const itemsIva = itemsTotal * QUOTATION_IVA_RATE;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="no-print space-y-6">
      <PageHeader
        title={<span className="font-mono text-3xl font-medium tracking-normal text-text">{quotation.number}</span>}
        meta={
          <span className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-soft">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5"
                style={{ backgroundColor: QUOTATION_STATUS_STRIP[quotation.status] }}
              />
              {QUOTATION_STATUS_LABELS[quotation.status]}
            </span>
            {expired && (
              <span className="inline-flex items-center gap-1.5 rounded border border-state-wait px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-state-wait">
                <AlertTriangle size={13} /> Vencida
              </span>
            )}
          </span>
        }
        subtitle={
          <Link to="/cotizaciones" className="inline-flex items-center gap-1.5 text-text-soft hover:text-accent-deep">
            <ArrowLeft size={14} /> Volver a cotizaciones
          </Link>
        }
        actions={
          isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" type="button" onClick={() => window.print()}>
                <Printer size={16} /> Imprimir
              </Button>
              <Button variant="ghost" type="button" onClick={() => setSendModal('email')}>
                <Mail size={16} /> Enviar por mail
              </Button>
              <Button variant="ghost" type="button" onClick={() => setSendModal('whatsapp')}>
                <MessageCircle size={16} /> Enviar por WhatsApp
              </Button>
              <ActionBar
                quotation={quotation}
                busy={busy}
                editable={editable}
                hasItems={hasItems}
                onSave={handleSave}
                onSend={handleSend}
                onAccept={() => handleStatus('ACEPTADA', 'Cotización aceptada. Ya podés convertirla en orden de trabajo.')}
                onReject={() => handleStatus('RECHAZADA', 'Cotización rechazada.')}
                onReopen={() => handleStatus('EMITIDA', 'Cotización reabierta como borrador. Corregila y volvé a enviarla cuando esté lista.')}
                onConvert={handleConvert}
              />
            </div>
          )
        }
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}

      {/* El motivo del rechazo es lo que dice si conviene recotizar o si el
          trabajo se perdió. Se sigue mostrando después de reabrir la
          cotización: es justo cuando más sirve tenerlo a la vista. */}
      {quotation.rejectionReason && (
        <div className="border border-line bg-panel-alt px-4 py-3">
          <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-danger">
            <ThumbsDown size={13} />
            {quotation.status === 'RECHAZADA' ? 'El cliente rechazó' : 'Rechazo anterior'}
            {quotation.decidedAt && (
              <span className="font-normal normal-case tracking-normal text-text-soft">
                · {new Date(quotation.decidedAt).toLocaleDateString('es-AR')}
              </span>
            )}
          </span>
          <p className="whitespace-pre-line text-sm text-text">{quotation.rejectionReason}</p>
        </div>
      )}
      {notice && (
        <div className="bg-panel-alt border border-state-done/40 text-state-done text-sm px-4 py-3">{notice}</div>
      )}

      {quotation.workOrderNumber && (
        <div className="bg-panel-alt border border-line text-text-soft text-sm px-4 py-3 flex items-center gap-2">
          <FileCheck2 size={16} />
          Esta cotización generó la orden de trabajo{' '}
          <Link to={`/orden/${quotation.workOrderNumber}`} className="font-bold text-accent-deep hover:underline inline-flex items-center gap-1">
            {quotation.workOrderNumber} <ArrowRight size={13} />
          </Link>
        </div>
      )}

      {frozen && !quotation.workOrderNumber && (
        <div className="bg-panel-alt border border-line text-text-soft text-sm px-4 py-3 flex items-center gap-2">
          <Lock size={16} />
          La cotización está {QUOTATION_STATUS_LABELS[quotation.status].toLowerCase()} y no puede modificarse.
        </div>
      )}

      {/* Datos de cabecera */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-panel border border-line p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-text-soft block mb-1">Cliente</span>
          <span className="text-sm font-bold text-text block">{quotation.customer?.name ?? '—'}</span>
          {quotation.customer?.legal_name && quotation.customer.legal_name !== quotation.customer.name && (
            <span className="text-[11px] text-text-soft block">{quotation.customer.legal_name}</span>
          )}
          {quotation.customer?.tax_id && (
            <span className="text-[11px] text-text-soft block mt-1 font-mono">{formatCuit(quotation.customer.tax_id)}</span>
          )}
        </div>
        <div className="bg-panel border border-line p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-text-soft block mb-1">Vehículo / Equipo</span>
          <span className="text-sm font-bold text-text">
            {[quotation.vehicle?.brand, quotation.vehicle?.model].filter(Boolean).join(' ') || '—'}
            {quotation.vehicle?.license_plate ? ` - ${quotation.vehicle.license_plate}` : ''}
          </span>
        </div>
        <div className="bg-panel border border-line p-4">
          <span className="text-[11px] font-bold uppercase tracking-wider text-text-soft block mb-1">Válida hasta</span>
          {editable ? (
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="w-full border border-line px-2 py-1 text-sm"
            />
          ) : (
            <span className={cn("text-sm font-bold", expired ? "text-state-wait" : "text-text")}>
              {quotation.validUntil
                ? new Date(`${quotation.validUntil}T00:00:00`).toLocaleDateString('es-AR')
                : 'Sin vencimiento'}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
          Componente
          {editable ? (
            <input
              value={component}
              onChange={(e) => setComponent(e.target.value)}
              className="mt-1 w-full border border-line px-3 py-2 text-sm font-normal normal-case"
              placeholder="Ej: Bomba de Inyección Common Rail"
            />
          ) : (
            <p className="mt-1 text-sm font-normal normal-case text-text">{quotation.component || '—'}</p>
          )}
        </label>
        <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
          Observaciones
          {editable ? (
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full border border-line px-3 py-2 text-sm font-normal normal-case resize-y"
              placeholder="Condiciones, plazos de entrega..."
            />
          ) : (
            <p className="mt-1 text-sm font-normal normal-case text-text">{quotation.notes || '—'}</p>
          )}
        </label>
      </div>

      {/* Renglones: mismo editor que la OT */}
      <div className="bg-panel border border-line p-5">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable={editable}
        />
      </div>
      </div>

      {/* Vista imprimible: lo que se imprime y lo que se manda por mail o
          WhatsApp son siempre este mismo bloque, no el formulario de arriba. */}
      <div ref={documentRef} className="print-document border border-line bg-panel p-6 md:p-8">
        <div className="grid grid-cols-1 gap-4 border-b-2 border-ink pb-5 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
              Presupuesto para
            </span>
            <h2 className="font-display text-xl font-medium uppercase leading-tight text-text">
              {quotation.customer?.name ?? '—'}
            </h2>
            {quotation.customer?.tax_id && (
              <p className="mt-1 font-mono text-[11px] text-text-soft">{formatCuit(quotation.customer.tax_id)}</p>
            )}
          </div>
          <div className="sm:text-right">
            <h3 className="font-display text-lg uppercase tracking-[0.08em] text-text-faint">Presupuesto</h3>
            <p className="mt-1 font-mono text-lg font-semibold text-text">{quotation.number}</p>
            {quotation.validUntil && (
              <p className="mt-1 text-[11px] text-text-soft">
                Válido hasta {new Date(`${quotation.validUntil}T00:00:00`).toLocaleDateString('es-AR')}
              </p>
            )}
          </div>
        </div>

        <div className="py-4 text-[12px] text-text-soft">
          {[quotation.vehicle?.brand, quotation.vehicle?.model].filter(Boolean).join(' ') || '—'}
          {quotation.vehicle?.license_plate ? ` · ${quotation.vehicle.license_plate}` : ''}
          {quotation.component ? ` · ${quotation.component}` : ''}
        </div>

        <table className="w-full text-left text-[12px]">
          <thead className="border-b border-line text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="py-1.5">Detalle</th>
              <th className="w-20 py-1.5 text-right">Cant.</th>
              <th className="w-28 py-1.5 text-right">Precio</th>
              <th className="w-28 py-1.5 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={idx} className="border-b border-line">
                <td className="py-1.5">{item.description}</td>
                <td className="py-1.5 text-right">{item.quantity.toFixed(2)}</td>
                <td className="py-1.5 text-right">$ {formatMoney(item.unitPrice)}</td>
                <td className="py-1.5 text-right font-semibold">$ {formatMoney(item.quantity * item.unitPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-end border-t-2 border-ink pt-4">
          <dl className="w-full space-y-1 text-[12px] sm:w-72">
            <div className="flex justify-between">
              <dt className="text-text-soft">Subtotal</dt>
              <dd className="font-mono text-text">$ {formatMoney(itemsTotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-soft">IVA 21%</dt>
              <dd className="font-mono text-text">$ {formatMoney(itemsIva)}</dd>
            </div>
            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</dt>
              <dd className="font-display text-2xl font-medium text-text">
                $ {formatMoney(itemsTotal + itemsIva)}
              </dd>
            </div>
          </dl>
        </div>

        {quotation.notes && (
          <div className="mt-5 border-t border-line pt-3">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.06em] text-text-faint">
              Observaciones
            </span>
            <p className="whitespace-pre-line text-[12px] text-text-soft">{quotation.notes}</p>
          </div>
        )}
      </div>

      {sendModal && (
        <SendDocumentModal
          channel={sendModal}
          defaultDestino={(sendModal === 'email' ? quotation.customer?.email : quotation.customer?.phone) ?? null}
          fileName={`Presupuesto-${quotation.number}.pdf`}
          documentRef={documentRef}
          subject={`Presupuesto ${quotation.number}`}
          text={
            sendModal === 'email'
              ? `Adjuntamos el presupuesto ${quotation.number} por $ ${formatMoney(itemsTotal + itemsIva)}.`
              : `Presupuesto ${quotation.number} — $ ${formatMoney(itemsTotal + itemsIva)}`
          }
          onClose={() => setSendModal(null)}
        />
      )}
    </div>
  );
}

function ActionBar({
  quotation,
  busy,
  editable,
  hasItems,
  onSave,
  onSend,
  onAccept,
  onReject,
  onReopen,
  onConvert,
}: {
  quotation: QuotationDetail;
  busy: boolean;
  editable: boolean;
  hasItems: boolean;
  onSave: () => void;
  onSend: () => void;
  onAccept: () => void;
  onReject: () => void;
  onReopen: () => void;
  onConvert: () => void;
}) {
  const btn = 'px-4 py-2 text-[11px] font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 disabled:opacity-50';

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {editable && (
        <button onClick={onSave} disabled={busy} className={cn(btn, 'bg-accent-deep text-white hover:bg-accent-hover')}>
          <Save size={16} /> {busy ? 'Guardando...' : 'Guardar'}
        </button>
      )}

      {quotation.status === 'EMITIDA' && (
        <button
          onClick={onSend}
          disabled={busy || !hasItems}
          title={hasItems ? undefined : 'Cargá al menos un renglón antes de enviarla.'}
          className={cn(btn, 'bg-blue-600 text-white hover:bg-blue-700')}
        >
          <Send size={16} /> Marcar enviada
        </button>
      )}

      {(quotation.status === 'EMITIDA' || quotation.status === 'ENVIADA') && (
        <>
          <button onClick={onAccept} disabled={busy} className={cn(btn, 'bg-state-done text-white hover:bg-state-done')}>
            <Check size={16} /> Aceptar
          </button>
          <button onClick={onReject} disabled={busy} className={cn(btn, 'bg-danger text-white hover:bg-danger-hover')}>
            <XCircle size={16} /> Rechazar
          </button>
        </>
      )}

      {quotation.status === 'ACEPTADA' && !quotation.workOrderNumber && (
        <button onClick={onConvert} disabled={busy} className={cn(btn, 'bg-accent text-accent-ink hover:bg-accent-deep hover:text-white')}>
          <FileCheck2 size={16} /> {busy ? 'Convirtiendo...' : 'Convertir en orden de trabajo'}
        </button>
      )}

      {quotation.status === 'RECHAZADA' && (
        <button onClick={onReopen} disabled={busy} className={cn(btn, 'border border-line text-text-soft hover:bg-panel-alt')}>
          Reabrir
        </button>
      )}
    </div>
  );
}
