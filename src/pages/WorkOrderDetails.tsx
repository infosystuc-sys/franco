import React, { useState } from 'react';
import { XCircle, Save, Check, FileText, ArrowRight, History, Receipt, Camera, ImageOff, Trash2, AlertTriangle, Send } from 'lucide-react';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/customers';
import { fetchOperarios, type Employee } from '@/src/lib/employees';
import {
  fetchInvoiceForWorkOrder,
  INVOICE_TYPE_LABELS,
  type WorkOrderInvoiceRef,
} from '@/src/lib/invoices';
import { VEHICLE_TYPE_LABELS } from '@/src/lib/vehicles';
import {
  addReceivedPart,
  assignEmployee,
  deleteReceivedPart,
  deleteWorkOrderPhoto,
  fetchStatusHistory,
  fetchWorkOrderByNumber,
  fetchWorkOrderStatuses,
  getErrorMessage,
  getWorkOrderPhotoUrl,
  RECEPTION_KIND_LABELS,
  requestPriceAuthorization,
  saveWorkOrderItems,
  setEstimatedDeliveryDate,
  setWorkOrderStatus,
  updateWorkOrderObservations,
  uploadWorkOrderPhoto,
  type StatusChange,
  type WorkOrderDetail,
  type WorkOrderItemInput,
  type WorkOrderPhoto,
  type WorkOrderStatusDef,
} from '@/src/lib/workOrders';

export function WorkOrderDetails() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const { id } = useParams();
  const [order, setOrder] = useState<WorkOrderDetail | null>(null);
  const [items, setItems] = useState<WorkOrderItemInput[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [history, setHistory] = useState<StatusChange[]>([]);
  const [changingStatus, setChangingStatus] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [assigningEmployee, setAssigningEmployee] = useState(false);
  const [invoice, setInvoice] = useState<WorkOrderInvoiceRef | null>(null);
  const [statuses, setStatuses] = useState<WorkOrderStatusDef[]>([]);
  const [requestingPriceAuth, setRequestingPriceAuth] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [observations, setObservations] = useState('');
  const [partName, setPartName] = useState('');
  const [partSerial, setPartSerial] = useState('');

  // Qué OT ya sincronizó `items` desde la base — no un booleano, porque el
  // mismo componente sigue vivo al navegar de una OT a otra (useParams solo
  // cambia `id`, no remonta).
  const itemsLoadedForRef = React.useRef<string | null>(null);

  function mapItems(data: WorkOrderDetail | null): WorkOrderItemInput[] {
    return (
      data?.items.map((i) => ({
        articleId: i.articleId ?? null,
        code: i.code,
        description: i.description,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })) ?? []
    );
  }

  const loadOrder = React.useCallback(async (): Promise<WorkOrderDetail | null> => {
    if (!id) return null;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkOrderByNumber(id);
      setOrder(data);
      // Los renglones son un borrador local (ver ItemsEditor/handleSave): un
      // refresco disparado por otra acción (cambiar estado, asignar
      // empleado, fecha estimada, fotos...) no debe pisar una edición sin
      // guardar. Solo se sincronizan acá la primera vez que se carga esta
      // OT — después de un guardado exitoso, handleSave los actualiza por
      // su cuenta con la respuesta fresca.
      if (itemsLoadedForRef.current !== id) {
        setItems(mapItems(data));
        itemsLoadedForRef.current = id;
      }
      setHistory(data ? await fetchStatusHistory(data.id) : []);

      // La factura se consulta aparte y sin propagar el error: el operario no
      // tiene permiso de lectura sobre facturas, y si la migracion todavia no
      // se aplico la tabla no existe. En ninguno de los dos casos deberia
      // caerse la pantalla de la orden: simplemente no hay boton.
      setInvoice(data ? await fetchInvoiceForWorkOrder(data.id).catch(() => null) : null);
      return data;
    } catch (err) {
      setError(getErrorMessage(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  // Las observaciones son un campo de texto libre que se guarda al perder el
  // foco (ver handleSaveObservations): hace falta resincronizar el estado
  // local cada vez que llega una OT nueva o un valor fresco desde la base,
  // igual que loadOrder hace con `order` mismo.
  React.useEffect(() => {
    setObservations(order?.observations ?? '');
  }, [order?.id, order?.observations]);

  // El avance visual y el desplegable de cambio de estado los ve cualquiera
  // que entra a la ficha, no solo el admin (que además puede cambiarlo).
  React.useEffect(() => {
    let cancelled = false;
    fetchWorkOrderStatuses(true)
      .then((data) => !cancelled && setStatuses(data))
      .catch(() => {/* si falla, el avance queda vacío; el resto de la ficha sigue andando */});
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetchArticles(false)
      .then((data) => !cancelled && setArticles(data))
      .catch(() => {/* el catálogo es opcional: si falla, se puede seguir cargando líneas manuales */});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // Solo el admin asigna: al operario le alcanza con ver el nombre, así que
  // no vale la pena traer la lista de empleados para su sesión. Solo se
  // ofrecen operarios: el dueño o un administrativo no se asignan a una OT.
  React.useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetchOperarios()
      .then((data) => !cancelled && setEmployees(data))
      .catch(() => {/* si falla, el selector queda vacío y se puede reintentar recargando */});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  async function handleStatusChange(statusId: string) {
    if (!order) return;
    setChangingStatus(true);
    setError(null);
    try {
      await setWorkOrderStatus(order.id, statusId);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setChangingStatus(false);
    }
  }

  async function handleAssignEmployee(employeeId: string | null) {
    if (!order) return;
    setAssigningEmployee(true);
    setError(null);
    try {
      await assignEmployee(order.id, employeeId);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAssigningEmployee(false);
    }
  }

  async function handleEstimatedDeliveryChange(date: string) {
    if (!order) return;
    setError(null);
    try {
      await setEstimatedDeliveryDate(order.id, date || null);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleRequestPriceAuth() {
    if (!order) return;
    setRequestingPriceAuth(true);
    setError(null);
    try {
      await requestPriceAuthorization(order.id);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRequestingPriceAuth(false);
    }
  }

  /**
   * Se guarda al salir del campo: es una nota larga, no ameritaba un botón
   * de guardado propio para un único textarea. Si falla, no basta con
   * mostrar el error: hay que devolver el campo al valor que quedó
   * realmente guardado en la base, porque si no el usuario ve su texto en
   * pantalla y cree que se guardó cuando en realidad se perdió.
   */
  async function handleSaveObservations() {
    if (!order || observations === (order.observations ?? '')) return;
    try {
      await updateWorkOrderObservations(order.id, observations);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
      setObservations(order.observations ?? '');
    }
  }

  async function handleAddPart() {
    if (!order) return;
    try {
      await addReceivedPart(order.id, partName, partSerial);
      setPartName('');
      setPartSerial('');
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDeletePart(id: string) {
    try {
      await deleteReceivedPart(id);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleSave() {
    if (!order) return;
    setSaving(true);
    setError(null);
    try {
      await saveWorkOrderItems(order.id, items);
      // Recargar: el stock pudo cambiar y los renglones ahora tienen id
      // nuevo. loadOrder ya no toca `items` en refrescos posteriores al
      // primero (ver comentario ahí), así que acá sí se resincroniza a
      // propósito con la respuesta fresca.
      const fresh = await loadOrder();
      setItems(mapItems(fresh));
      if (isAdmin) fetchArticles(false).then(setArticles).catch(() => {});
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="max-w-7xl mx-auto p-8 text-center text-text-soft">Cargando orden...</div>;
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-7xl p-8 text-center text-text-soft">
        No se encontró la orden {id}.{' '}
        <Link to="/" className="text-accent-deep underline">Volver al panel</Link>
      </div>
    );
  }

  // Con factura emitida la OT queda congelada: lo único que la desbloquea es
  // anular esa factura (fuera de esta pantalla, desde Facturación).
  const locked = !!invoice;
  const statusIndex = statuses.findIndex((s) => s.id === order.status.id);
  const currentTotal = order.items.reduce((sum, i) => sum + i.subtotal, 0);
  const priceDiffers =
    order.quotedTotal !== null && Math.abs(currentTotal - order.quotedTotal) > 0.005;
  const priceAuthCoversCurrent =
    order.priceAuth.status === 'AUTORIZADO' &&
    order.priceAuth.requestedTotal !== null &&
    Math.abs(order.priceAuth.requestedTotal - currentTotal) < 0.005;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={<span className="font-mono text-3xl font-medium tracking-normal text-text">{order.number}</span>}
        meta={
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-soft">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5"
              style={{ backgroundColor: order.status.color }}
            />
            {order.status.label}
          </span>
        }
        subtitle={
          order.quotationNumber ? (
            <Link
              to={`/cotizacion/${order.quotationNumber}`}
              className="inline-flex items-center gap-1.5 text-accent-deep hover:underline"
            >
              <FileText size={14} /> Nace de la cotización {order.quotationNumber}
            </Link>
          ) : (
            'Orden cargada directamente, sin cotización previa.'
          )
        }
        actions={
          <>
            <Link to="/ordenes">
              <Button variant="ghost" type="button">
                <XCircle size={16} /> Volver
              </Button>
            </Link>
            {isAdmin && <InvoiceAction order={order} invoice={invoice} />}
            {isAdmin && !locked && (
              <Button onClick={handleSave} disabled={saving}>
                <Save size={16} /> {saving ? 'Guardando…' : 'Guardar'}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {order.quotedTotal !== null && priceDiffers && !priceAuthCoversCurrent && (
        <div className="mb-6 flex flex-col gap-2 rounded-md border border-state-wait/40 bg-state-wait/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2 text-text">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-state-wait" />
            <span>
              El monto de la OT ({formatMoney(currentTotal)}) difiere del presupuesto original
              ({formatMoney(order.quotedTotal)}).
              {order.priceAuth.status === 'PENDIENTE' && (
                <>
                  {' '}Esperando la respuesta del cliente
                  {order.priceAuth.requestedAt ? ` (pedida el ${new Date(order.priceAuth.requestedAt).toLocaleDateString('es-AR')})` : ''}.
                  No se puede cerrar la OT hasta que autorice.
                </>
              )}
              {order.priceAuth.status === 'RECHAZADO' && (
                <>
                  {' '}El cliente no autorizó el cambio
                  {order.priceAuth.reason ? `: "${order.priceAuth.reason}"` : '.'} No se puede cerrar la OT así.
                </>
              )}
            </span>
          </span>
          {isAdmin && order.priceAuth.status !== 'PENDIENTE' && (
            <Button variant="ghost" onClick={handleRequestPriceAuth} disabled={requestingPriceAuth}>
              <Send size={15} /> {requestingPriceAuth ? 'Enviando…' : 'Solicitar autorización'}
            </Button>
          )}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-5">
        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Cliente
          </span>
          <span className="block text-sm font-semibold text-text">{order.customer?.name ?? '—'}</span>
          {order.customer?.legal_name && order.customer.legal_name !== order.customer.name && (
            <span className="block text-xs text-text-soft">{order.customer.legal_name}</span>
          )}
          {order.customer && (
            <span className="mt-1.5 block text-xs text-text-soft">
              {order.customer.tax_id && (
                <span className="font-mono">{formatCuit(order.customer.tax_id)} · </span>
              )}
              {TAX_CONDITION_LABELS[order.customer.tax_condition]}
            </span>
          )}
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Vehículo / Equipo
          </span>
          <span className="block text-sm font-semibold text-text">
            {[order.vehicle?.brand, order.vehicle?.model].filter(Boolean).join(' ') || '—'}
          </span>
          {order.vehicle?.license_plate && (
            <span className="mt-1 inline-block border border-line bg-panel-alt px-2 py-0.5 font-mono text-xs font-semibold">
              {order.vehicle.license_plate}
            </span>
          )}
          {order.vehicle && (
            <span className="mt-1.5 block text-xs text-text-soft">
              {[
                VEHICLE_TYPE_LABELS[order.vehicle.vehicle_type],
                order.vehicle.year ? String(order.vehicle.year) : null,
                [order.vehicle.engine_brand, order.vehicle.engine_model].filter(Boolean).join(' ') || null,
                order.vehicle.injection_system,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Componente
          </span>
          <span className="text-sm font-semibold text-text">{order.component ?? '—'}</span>
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Empleado
          </span>
          {isAdmin && !locked ? (
            <select
              value={order.employee?.id ?? ''}
              onChange={(e) => handleAssignEmployee(e.target.value || null)}
              disabled={assigningEmployee}
              className="w-full rounded border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
            >
              <option value="">Sin asignar</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}{employee.workplace ? ` — ${employee.workplace}` : ''}
                </option>
              ))}
            </select>
          ) : (
            // El operario solo consulta quién quedó a cargo: la asignación es tarea del admin.
            <span className="block text-sm font-semibold text-text">{order.employee?.name ?? 'Sin asignar'}</span>
          )}
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Entrega estimada
          </span>
          {isAdmin && !locked ? (
            <input
              type="date"
              value={order.estimatedDeliveryDate ?? ''}
              onChange={(e) => handleEstimatedDeliveryChange(e.target.value)}
              className="w-full rounded border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
            />
          ) : (
            <span className="block text-sm font-semibold text-text">
              {order.estimatedDeliveryDate ? formatDate(order.estimatedDeliveryDate) : 'Sin definir'}
            </span>
          )}
        </Panel>
      </div>

      {/* Avance del trabajo */}
      {statuses.length > 0 && (
        <Panel className="mb-6 px-5 py-6">
          <div className="relative flex items-start justify-between">
            <div className="absolute left-0 top-3 z-0 h-[3px] w-full bg-line" />
            <div
              className="absolute left-0 top-3 z-0 h-[3px] bg-accent transition-all duration-300"
              style={{ width: `${statuses.length > 1 ? (Math.max(statusIndex, 0) / (statuses.length - 1)) * 100 : 0}%` }}
            />

            {statuses.map((status, idx) => (
              <div key={status.id} className="relative z-10 flex w-24 flex-col items-center gap-2">
                {idx === statusIndex ? (
                  <span className="flex h-[26px] w-[26px] -mt-[6px] items-center justify-center border-[3px] border-accent bg-panel">
                    <span className="h-2 w-2 bg-accent" />
                  </span>
                ) : idx < statusIndex ? (
                  <span className="flex h-[26px] w-[26px] -mt-[6px] items-center justify-center bg-accent text-accent-ink">
                    <Check size={14} strokeWidth={3} />
                  </span>
                ) : (
                  <span className="mt-[1px] flex h-5 w-5 items-center justify-center border border-line-strong bg-panel-alt" />
                )}
                <span
                  className={cn(
                    'text-center text-[10px] font-semibold uppercase leading-tight tracking-[0.05em]',
                    idx === statusIndex ? 'text-text' : 'text-text-faint'
                  )}
                >
                  {status.label}
                </span>
              </div>
            ))}
          </div>

          {isAdmin && (
            <StatusControls
              order={order}
              statuses={statuses}
              invoice={invoice}
              busy={changingStatus}
              onChange={handleStatusChange}
            />
          )}
        </Panel>
      )}

      {history.length > 1 && (
        <div className="mb-6">
          {showHistory ? (
            <>
              <StatusHistory history={history} />
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="mt-2 text-xs font-semibold text-text-soft hover:text-text"
              >
                Ocultar historial
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowHistory(true)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-text-soft hover:text-text"
            >
              <History size={14} /> Ver historial de estados ({history.length})
            </button>
          )}
        </div>
      )}

      {/* Mismo editor de renglones que usan las cotizaciones */}
      <Panel className="p-5">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable={isAdmin && !locked}
        />
      </Panel>

      {/* Lo que se dejó asentado al recibir: piezas sueltas y cualquier
          observación del cliente o de quien recibió. */}
      <div className="mt-6">
        <Panel className="space-y-4 p-5">
          <SectionHeader title={`Recepción · ${RECEPTION_KIND_LABELS[order.receptionKind]}`} />

          <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
            Observaciones
            <textarea
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              onBlur={handleSaveObservations}
              disabled={!isAdmin}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none disabled:bg-panel-alt"
            />
          </label>

          <div className="space-y-2">
            <span className="text-xs font-bold uppercase tracking-wider text-text-soft">
              Piezas recibidas{order.receivedParts.length > 0 && ` (${order.receivedParts.length})`}
            </span>
            {order.receivedParts.length === 0 ? (
              <p className="text-sm text-text-soft">No se registraron piezas al recibir.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {order.receivedParts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span>{p.name} — <span className="font-mono text-xs">{p.serialNumber}</span></span>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => handleDeletePart(p.id)}
                        aria-label={`Quitar ${p.name}`}
                        className="text-text-soft transition-colors hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {isAdmin && (
              <div className="flex gap-2">
                <input
                  value={partName}
                  onChange={(e) => setPartName(e.target.value)}
                  placeholder="Bomba inyectora"
                  className="mt-0 flex-1 rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
                />
                <input
                  value={partSerial}
                  onChange={(e) => setPartSerial(e.target.value)}
                  placeholder="N° de serie"
                  className="mt-0 w-40 rounded-md border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-accent-deep focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!partName.trim() || !partSerial.trim()}
                  onClick={handleAddPart}
                  className="border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt disabled:opacity-50"
                >
                  Agregar
                </button>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {order && (
        <div className="mt-6">
          <PhotosSection order={order} isAdmin={isAdmin} onChanged={loadOrder} onError={setError} />
        </div>
      )}
    </div>
  );
}

/**
 * Fotos del estado de las piezas durante la reparación. Mismo patrón que
 * las fotos de Ingreso de vehículos: se pueden agregar en cualquier
 * momento, no solo al terminar, y se sacan directo con la cámara del
 * celular o tablet.
 */
function PhotosSection({
  order,
  isAdmin,
  onChanged,
  onError,
}: {
  order: WorkOrderDetail;
  isAdmin: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    onError('');
    try {
      for (const file of Array.from(files)) {
        await uploadWorkOrderPhoto(order.id, file);
      }
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <Panel className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeader title={`Fotos${order.photos.length > 0 ? ` (${order.photos.length})` : ''}`} />
        {isAdmin && (
          <label className="cursor-pointer">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(e) => handleFiles(e.target.files)}
              disabled={uploading}
              className="hidden"
            />
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-accent-ink hover:bg-accent-deep hover:text-white transition-colors">
              <Camera size={15} /> {uploading ? 'Subiendo...' : 'Agregar foto'}
            </span>
          </label>
        )}
      </div>

      {order.photos.length === 0 ? (
        <p className="flex flex-col items-center gap-2 py-8 text-sm text-text-soft">
          <ImageOff size={22} className="text-text-faint" />
          Todavía no hay fotos cargadas.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {order.photos.map((photo) => (
            <PhotoThumb key={photo.id} photo={photo} isAdmin={isAdmin} onChanged={onChanged} onError={onError} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function PhotoThumb({
  photo,
  isAdmin,
  onChanged,
  onError,
}: {
  photo: WorkOrderPhoto;
  isAdmin: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    getWorkOrderPhotoUrl(photo.storagePath)
      .then((signed) => !cancelled && setUrl(signed))
      .catch(() => {/* la miniatura queda vacía; no vale la pena cortar el resto de la pantalla */});
    return () => { cancelled = true; };
  }, [photo.storagePath]);

  async function handleDelete() {
    if (!window.confirm('¿Eliminar esta foto?')) return;
    setDeleting(true);
    try {
      await deleteWorkOrderPhoto(photo);
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <div className="group relative aspect-square overflow-hidden rounded-md border border-line bg-panel-alt">
      {url ? (
        <img src={url} alt="Foto de la orden" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-text-faint">
          <Camera size={20} />
        </div>
      )}
      {isAdmin && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          title="Eliminar foto"
          className="absolute right-1 top-1 bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-danger group-hover:opacity-100 disabled:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * El acceso a la facturación desde la orden.
 *
 * Ya facturada deja de ser un botón y pasa a ser un link al comprobante:
 * ofrecer "Facturar" sobre una orden que ya tiene factura sería prometer algo
 * que la base va a rechazar. Sin terminar queda deshabilitado explicando por
 * qué, que es más útil que esconderlo.
 */
function InvoiceAction({
  order,
  invoice,
}: {
  order: WorkOrderDetail;
  invoice: WorkOrderInvoiceRef | null;
}) {
  if (invoice) {
    return (
      <Link to={`/factura/${invoice.id}`}>
        <Button variant="secondary" type="button">
          <Receipt size={16} /> {INVOICE_TYPE_LABELS[invoice.invoiceType]} {invoice.fullNumber}
        </Button>
      </Link>
    );
  }

  if (!order.status.isTerminal) {
    return (
      <Button
        type="button"
        variant="ghost"
        disabled
        title={`Se factura cuando la orden está terminada. Ahora está en ${order.status.label}.`}
      >
        <Receipt size={16} /> Facturar
      </Button>
    );
  }

  return (
    <Link to={`/facturar/${order.number}`}>
      <Button variant="secondary" type="button">
        <Receipt size={16} /> Facturar
      </Button>
    </Link>
  );
}

/**
 * Cambio de estado de la OT: un desplegable único con todos los estados,
 * aplica apenas se elige uno distinto. Reemplaza al viejo botón de "avanzar
 * al siguiente paso" — cualquier salto, adelante o atrás, es la misma
 * acción. Si la orden ya está terminada y facturada, avisa que cambiar el
 * estado no anula ni actualiza esa factura, pero no lo bloquea.
 */
function StatusControls({
  order,
  statuses,
  invoice,
  busy,
  onChange,
}: {
  order: WorkOrderDetail;
  statuses: WorkOrderStatusDef[];
  invoice: WorkOrderInvoiceRef | null;
  busy: boolean;
  onChange: (statusId: string) => void;
}) {
  const isDone = order.status.isTerminal;
  // Si el estado actual de la OT se desactivó desde el ABM después de
  // asignarse, igual tiene que aparecer en la lista — si no, el
  // desplegable arranca mostrando otra cosa distinta de lo que la OT
  // realmente tiene.
  const options = statuses.some((s) => s.id === order.status.id)
    ? statuses
    : [order.status, ...statuses];

  return (
    <div className="mt-7 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
          Estado
        </span>
        <select
          value={order.status.id}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy || !!invoice}
          className="rounded border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none disabled:opacity-60"
        >
          {options.map((status) => (
            <option key={status.id} value={status.id}>{status.label}</option>
          ))}
        </select>
        {busy && (
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            Actualizando…
          </span>
        )}
      </div>

      {invoice && (
        <p className="mt-3 rounded-md border border-state-wait/40 bg-state-wait/10 px-3 py-2 text-xs text-state-wait">
          Esta orden ya tiene la {INVOICE_TYPE_LABELS[invoice.invoiceType]} {invoice.fullNumber} emitida:
          queda bloqueada, no se puede modificar. Para corregir algo, anulá esa factura primero.
        </p>
      )}
    </div>
  );
}

function StatusHistory({ history }: { history: StatusChange[] }) {
  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line bg-panel-head px-5 py-2.5">
        <h2 className="flex items-center gap-1.5 font-display text-base uppercase tracking-[0.08em] text-text-faint">
          <History size={15} /> Historial de estados
        </h2>
      </div>
      <ul className="divide-y divide-line">
        {[...history].reverse().map((change) => (
          <li
            key={change.id}
            className="relative flex flex-wrap items-center justify-between gap-3 py-2.5 pl-5 pr-5 text-[13px]"
          >
            <StateStrip color={change.toStatus.color} />
            <span className="flex items-center gap-2">
              {change.fromStatus && (
                <>
                  <span className="text-text-soft">{change.fromStatus.label}</span>
                  <ArrowRight size={13} className="text-text-faint" />
                </>
              )}
              <span className="font-semibold text-text">{change.toStatus.label}</span>
              {!change.fromStatus && (
                <span className="text-[10px] uppercase tracking-[0.08em] text-text-faint">apertura</span>
              )}
            </span>
            <span className="font-mono text-[11px] text-text-soft">
              {new Date(change.changedAt).toLocaleString('es-AR')}
              {change.changedByEmail && ` · ${change.changedByEmail}`}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
