import React from 'react';
import {
  ArrowLeft,
  Save,
  Send,
  FileCheck2,
  AlertTriangle,
  Lock,
  ArrowRight,
  ThumbsDown,
  Printer,
  Mail,
  MessageCircle,
} from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { SendDocumentModal } from '@/src/components/SendDocumentModal';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { QuotationDocument } from '@/src/components/QuotationDocument';
import { useAccionDesdeListado } from '@/src/lib/accionDesdeListado';
import { marcarEnviado } from '@/src/lib/comprobantes';
import { formatCuit } from '@/src/lib/fiscal';
import { fetchTallerHeader, formatAddress, type TallerHeader } from '@/src/lib/companySettings';
import { getErrorMessage, type WorkOrderItemInput } from '@/src/lib/workOrders';
import {
  describirEnvioCotizacion,
  enviarCotizacionParaAutorizar,
  rejectQuotationWorkOrder,
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

  const [quotation, setQuotation] = React.useState<QuotationDetail | null>(null);
  const [taller, setTaller] = React.useState<TallerHeader | null>(null);
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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const documentRef = React.useRef<HTMLDivElement>(null);

  /**
   * A dónde se vuelve al terminar. Normalmente el menú, pero si se llegó desde
   * una orden —con ?volver=OT-x— se vuelve a esa orden: quien mandó a imprimir
   * desde ahí está trabajando en la orden, no en el presupuesto.
   */
  const destinoAlSalir = searchParams.get('volver')
    ? `/orden/${searchParams.get('volver')}`
    : ['imprimir', 'descargar', 'enviar'].some((p) => searchParams.has(p))
      ? '/cotizaciones'
      : '/';

  const loadQuotation = React.useCallback(async () => {
    if (!number) return;
    setLoading(true);
    setError(null);
    try {
      // El membrete se carga junto con la cotización, no aparte: llegar acá
      // con ?imprimir=1 dispara la impresión apenas termina esta carga, y un
      // encabezado que llega después sale en pantalla pero no en el papel.
      const [data, datosTaller] = await Promise.all([
        fetchQuotationByNumber(number),
        fetchTallerHeader().catch(() => null),
      ]);
      setTaller(datosTaller);
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

  /**
   * Llegar con ?imprimir=1, ?descargar=1 o ?enviar=… hace la acción sola: son
   * el botón "Imprimir presupuesto" de la orden y los del listado. Al terminar
   * se vuelve a donde se vino (ver destinoAlSalir).
   *
   * Vive acá arriba, con el resto de los hooks, porque más abajo hay returns
   * tempranos —cargando, no encontrada—.
   */
  useAccionDesdeListado({
    listo: !loading && !!quotation,
    listado: destinoAlSalir,
    documentRef,
    nombreArchivo: `Presupuesto-${quotation?.number ?? ''}.pdf`,
    abrirEnvio: setSendModal,
  });

  if (loading) {
    return <div className="w-full p-8 text-center text-text-soft">Cargando cotización...</div>;
  }

  if (!quotation) {
    return (
      <div className="w-full p-8 text-center text-text-soft">
        No se encontró la cotización {number}.{' '}
        <Link to="/cotizaciones" className="text-accent-deep underline">Volver al listado</Link>
      </div>
    );
  }

  const frozen = !isQuotationEditable(quotation.status);
  const editable = isAdmin && !frozen;
  const expired = isExpired(quotation.validUntil, quotation.status);

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

  /**
   * Lo que esté escrito en pantalla queda guardado antes de cualquier otra
   * cosa: imprimir, mandar o irse. Una cotización congelada —o un operario
   * sin permiso de edición— no tiene nada que guardar.
   */
  async function guardarLoEditado() {
    if (!editable) return;
    await updateQuotationHeader(quotation.id, { component, notes, validUntil });
    await saveQuotationItems(quotation.id, items);
  }

  /**
   * Toda acción de la cotización termina en el menú. Cada cosa que se hace acá
   * —guardarla, mandarla, imprimirla— cierra el trámite de esa cotización, y
   * quedarse en la pantalla invita a repetir la acción sobre algo ya resuelto.
   */
  const volverAlMenu = () => navigate(destinoAlSalir);

  const handleSave = () => run(async () => {
    await guardarLoEditado();
    volverAlMenu();
  });

  const handleStatus = (status: QuotationDetail['status']) => run(async () => {
    await updateQuotationStatus(quotation.id, status);
    // El rechazo no se queda en la cotización: la orden que la originó deja de
    // esperar respuesta y libera el lugar que el vehículo ocupaba en la playa.
    if (status === 'RECHAZADA') await rejectQuotationWorkOrder(quotation.id);
    volverAlMenu();
  });

  /**
   * Mandarlo a autorizar no cierra la pantalla como el resto de las acciones:
   * después de enviar se suele mirar el estado, y a veces reenviar. Salir al
   * menú obligaría a volver a entrar para hacer exactamente eso.
   */
  const handleEnviarAutorizar = () => run(async () => {
    await guardarLoEditado();
    const resultado = await enviarCotizacionParaAutorizar(quotation.id);
    setNotice(describirEnvioCotizacion(resultado));
    await loadQuotation();
  });

  const handlePrint = () => run(async () => {
    await guardarLoEditado();
    // Se vuelve recién cuando se cierra el diálogo de impresión: navegar
    // mientras está abierto cancela la impresión o la saca cortada.
    window.addEventListener('afterprint', volverAlMenu, { once: true });
    window.print();
  });

  const handleOpenSend = (canal: 'email' | 'whatsapp') => run(async () => {
    await guardarLoEditado();
    setSendModal(canal);
  });


  const itemsTotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const itemsIva = itemsTotal * QUOTATION_IVA_RATE;

  return (
    <div className="w-full space-y-6">
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
              <span className="inline-flex items-center gap-1.5 rounded border border-state-wait px-2 py-0.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-state-wait">
                <AlertTriangle size={13} /> Vencida
              </span>
            )}
          </span>
        }
        subtitle={
          // Antes era un Link directo a /cotizaciones: salir por acá tiraba
          // sin avisar lo que se hubiera editado (componente, observaciones,
          // renglones), porque lo único que persistía esos cambios era el
          // botón Guardar. Ahora es la misma acción que Guardar —guarda y
          // recién ahí vuelve, respetando a dónde corresponda volver— así
          // que salir por acá nunca pierde nada.
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-text-soft hover:text-accent-deep disabled:opacity-60"
          >
            <ArrowLeft size={14} /> Volver a cotizaciones
          </button>
        }
        actions={
          isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              {(quotation.status === 'EMITIDA' || quotation.status === 'ENVIADA') && (
                <Button type="button" disabled={busy} onClick={handleEnviarAutorizar}>
                  <Send size={16} />{' '}
                  {quotation.status === 'ENVIADA' ? 'Reenviar para autorizar' : 'Enviar para autorizar'}
                </Button>
              )}
              <Button variant="ghost" type="button" disabled={busy} onClick={handlePrint}>
                <Printer size={16} /> Imprimir
              </Button>
              <Button variant="ghost" type="button" disabled={busy} onClick={() => handleOpenSend('email')}>
                <Mail size={16} /> Enviar por mail
              </Button>
              <Button variant="ghost" type="button" disabled={busy} onClick={() => handleOpenSend('whatsapp')}>
                <MessageCircle size={16} /> Enviar por WhatsApp
              </Button>
              <ActionBar
                quotation={quotation}
                busy={busy}
                editable={editable}
                onSave={handleSave}
                onReopen={() => handleStatus('EMITIDA')}
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
          <span className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-danger">
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
          Presupuesto de la orden de trabajo{' '}
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
          <span className="text-[13px] font-bold uppercase tracking-wider text-text-soft block mb-1">Cliente</span>
          <span className="text-sm font-bold text-text block">{quotation.customer?.name ?? '—'}</span>
          {quotation.customer?.legal_name && quotation.customer.legal_name !== quotation.customer.name && (
            <span className="text-[13px] text-text-soft block">{quotation.customer.legal_name}</span>
          )}
          {quotation.customer?.tax_id && (
            <span className="text-[13px] text-text-soft block mt-1 font-mono">{formatCuit(quotation.customer.tax_id)}</span>
          )}
        </div>
        <div className="bg-panel border border-line p-4">
          <span className="text-[13px] font-bold uppercase tracking-wider text-text-soft block mb-1">Vehículo / Equipo</span>
          <span className="text-sm font-bold text-text">
            {[quotation.vehicle?.brand, quotation.vehicle?.model].filter(Boolean).join(' ') || '—'}
            {quotation.vehicle?.license_plate ? ` - ${quotation.vehicle.license_plate}` : ''}
          </span>
        </div>
        <div className="bg-panel border border-line p-4">
          <span className="text-[13px] font-bold uppercase tracking-wider text-text-soft block mb-1">Válida hasta</span>
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
          WhatsApp son siempre este mismo bloque, no el formulario de arriba.
          Los renglones salen de items —lo que está editado en pantalla— y no
          de quotation.items, para que lo impreso sea lo que se está viendo. */}
      <div ref={documentRef}>
        <QuotationDocument
          taller={taller}
          quotation={{
            number: quotation.number,
            issueDate: quotation.createdAt,
            validUntil: quotation.validUntil,
            component: quotation.component,
            notes: quotation.notes,
            customerName: quotation.customer?.legal_name || quotation.customer?.name || '—',
            customerTaxId: quotation.customer?.tax_id ?? null,
            customerAddress: quotation.customer ? formatAddress({
              addressStreet: quotation.customer.address_street,
              addressCity: quotation.customer.address_city,
              addressState: quotation.customer.address_state,
              addressZip: quotation.customer.address_zip,
            }) : null,
            customerTaxCondition: quotation.customer?.tax_condition ?? null,
            vehicleBrand: quotation.vehicle?.brand ?? null,
            vehicleModel: quotation.vehicle?.model ?? null,
            licensePlate: quotation.vehicle?.license_plate ?? null,
            workOrderNumber: quotation.workOrderNumber,
            items: items.map((item) => ({
              code: item.code || null,
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          }}
        />
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
          onSent={() => marcarEnviado('presupuesto', quotation.id)}
          onClose={() => { setSendModal(null); volverAlMenu(); }}
        />
      )}
    </div>
  );
}

function ActionBar({
  quotation,
  busy,
  editable,
  onSave,
  onReopen,
}: {
  quotation: QuotationDetail;
  busy: boolean;
  editable: boolean;
  onSave: () => void;
  onReopen: () => void;
}) {
  const btn = 'px-4 py-2 text-[13px] font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 disabled:opacity-50';

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {editable && (
        <button onClick={onSave} disabled={busy} className={cn(btn, 'bg-accent-deep text-white hover:bg-accent-hover')}>
          <Save size={16} /> {busy ? 'Guardando...' : 'Guardar'}
        </button>
      )}

      {/* Aceptar y rechazar los decide el cliente desde su link, no el taller
          desde acá: este módulo quedó para controlar autorizaciones, no para
          firmarlas en nombre de quien tiene que autorizar.

          "Marcar enviada" también se fue: era lo único que disparaba el aviso
          automático por WhatsApp, y el presupuesto ahora sale cuando alguien
          lo manda a propósito con el botón de arriba. */}
      {quotation.status === 'RECHAZADA' && (
        <button onClick={onReopen} disabled={busy} className={cn(btn, 'border border-line text-text-soft hover:bg-panel-alt')}>
          Reabrir
        </button>
      )}
    </div>
  );
}
