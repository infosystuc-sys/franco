import React, { useState } from 'react';
import { XCircle, Save, Check, FileText, ArrowRight, History, Receipt } from 'lucide-react';
import { cn } from '@/src/lib/utils';
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
  assignEmployee,
  fetchStatusHistory,
  fetchWorkOrderByNumber,
  getErrorMessage,
  nextStatus,
  saveWorkOrderItems,
  STATUS_LABELS,
  STATUS_SEQUENCE,
  STATUS_STRIP,
  updateWorkOrderStatus,
  type StatusChange,
  type WorkOrderDetail,
  type WorkOrderItemInput,
} from '@/src/lib/workOrders';
import type { WorkOrderStatus } from '@/src/types';

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

  const loadOrder = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkOrderByNumber(id);
      setOrder(data);
      setItems(
        data?.items.map((i) => ({
          articleId: i.articleId ?? null,
          code: i.code,
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })) ?? []
      );
      setHistory(data ? await fetchStatusHistory(data.id) : []);

      // La factura se consulta aparte y sin propagar el error: el operario no
      // tiene permiso de lectura sobre facturas, y si la migracion todavia no
      // se aplico la tabla no existe. En ninguno de los dos casos deberia
      // caerse la pantalla de la orden: simplemente no hay boton.
      setInvoice(data ? await fetchInvoiceForWorkOrder(data.id).catch(() => null) : null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    loadOrder();
  }, [loadOrder]);

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

  async function handleStatusChange(status: WorkOrderStatus) {
    if (!order) return;
    setChangingStatus(true);
    setError(null);
    try {
      await updateWorkOrderStatus(order.id, status);
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

  async function handleSave() {
    if (!order) return;
    setSaving(true);
    setError(null);
    try {
      await saveWorkOrderItems(order.id, items);
      // Recargar: el stock pudo cambiar y los renglones ahora tienen id nuevo.
      await loadOrder();
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

  const statusIndex = STATUS_SEQUENCE.indexOf(order.status);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={<span className="font-mono text-3xl font-medium tracking-normal text-text">{order.number}</span>}
        meta={
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-soft">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5"
              style={{ backgroundColor: STATUS_STRIP[order.status] }}
            />
            {STATUS_LABELS[order.status]}
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
            <Link to="/">
              <Button variant="ghost" type="button">
                <XCircle size={16} /> Volver
              </Button>
            </Link>
            {isAdmin && <InvoiceAction order={order} invoice={invoice} />}
            {isAdmin && (
              <Button onClick={handleSave} disabled={saving}>
                <Save size={16} /> {saving ? 'Guardando…' : 'Guardar'}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-4">
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
          {isAdmin ? (
            <select
              value={order.employee?.id ?? ''}
              onChange={(e) => handleAssignEmployee(e.target.value || null)}
              disabled={assigningEmployee}
              className="w-full border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
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
      </div>

      {/* Avance del trabajo */}
      <Panel className="mb-6 px-5 py-6">
        <div className="relative flex items-start justify-between">
          <div className="absolute left-0 top-3 z-0 h-[3px] w-full bg-line" />
          <div
            className="absolute left-0 top-3 z-0 h-[3px] bg-accent transition-all duration-300"
            style={{ width: `${(statusIndex / (STATUS_SEQUENCE.length - 1)) * 100}%` }}
          />

          {STATUS_SEQUENCE.map((status, idx) => (
            <div key={status} className="relative z-10 flex w-24 flex-col items-center gap-2">
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
                {STATUS_LABELS[status]}
              </span>
            </div>
          ))}
        </div>

        {isAdmin && (
          <StatusControls
            order={order}
            invoice={invoice}
            busy={changingStatus}
            onChange={handleStatusChange}
          />
        )}
      </Panel>

      {history.length > 1 && (
        <div className="mb-6">
          <StatusHistory history={history} />
        </div>
      )}

      {/* Mismo editor de renglones que usan las cotizaciones */}
      <Panel className="p-5">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable={isAdmin}
        />
      </Panel>
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

  if (order.status !== 'TERMINADO') {
    return (
      <Button
        type="button"
        variant="ghost"
        disabled
        title={`Se factura cuando la orden está terminada. Ahora está en ${STATUS_LABELS[order.status]}.`}
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
 * Avance del estado de la OT. El botón principal sigue el flujo natural;
 * el desplegable permite corregir a cualquier otro estado si alguien se pasó.
 *
 * Terminada, "Corregir estado" pasa a llamarse "Reabrir orden": misma
 * mecánica (elegís el destino en el desplegable), pero con su propio rótulo
 * porque acá el volver atrás es la acción principal, no una corrección
 * excepcional. Si ya hay factura emitida, se avisa pero no se bloquea: la
 * factura no se actualiza sola.
 */
function StatusControls({
  order,
  invoice,
  busy,
  onChange,
}: {
  order: WorkOrderDetail;
  invoice: WorkOrderInvoiceRef | null;
  busy: boolean;
  onChange: (status: WorkOrderStatus) => void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const following = nextStatus(order.status);
  const isDone = order.status === 'TERMINADO';
  const reopenOptions = STATUS_SEQUENCE.filter((status) => status !== 'TERMINADO');
  const [reopenTarget, setReopenTarget] = useState<WorkOrderStatus>(
    reopenOptions[reopenOptions.length - 1]
  );

  return (
    <div className="mt-7 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {following ? (
          <Button onClick={() => onChange(following)} disabled={busy}>
            {busy ? 'Actualizando…' : `Avanzar a ${STATUS_LABELS[following]}`}
            <ArrowRight size={16} />
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-state-done">
            <Check size={16} /> Orden terminada
          </span>
        )}

        {correcting ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              {isDone ? 'Reabrir en' : 'Corregir a'}
            </span>
            {isDone ? (
              <>
                <select
                  value={reopenTarget}
                  onChange={(e) => setReopenTarget(e.target.value as WorkOrderStatus)}
                  disabled={busy}
                  className="border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
                >
                  {reopenOptions.map((status) => (
                    <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                  ))}
                </select>
                <button
                  onClick={() => onChange(reopenTarget)}
                  disabled={busy}
                  className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-deep hover:underline"
                >
                  Confirmar
                </button>
              </>
            ) : (
              <select
                value={order.status}
                onChange={(e) => onChange(e.target.value as WorkOrderStatus)}
                disabled={busy}
                className="border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
              >
                {STATUS_SEQUENCE.map((status) => (
                  <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                ))}
              </select>
            )}
            <button
              onClick={() => setCorrecting(false)}
              className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft hover:text-text"
            >
              {isDone ? 'Cancelar' : 'Listo'}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCorrecting(true)}
            className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft hover:text-accent-deep hover:underline"
          >
            {isDone ? 'Reabrir orden' : 'Corregir estado'}
          </button>
        )}
      </div>

      {isDone && correcting && invoice && (
        <p className="mt-3 border border-state-wait/40 bg-state-wait/10 px-3 py-2 text-xs text-state-wait">
          Esta orden ya tiene la {INVOICE_TYPE_LABELS[invoice.invoiceType]} {invoice.fullNumber} emitida.
          Reabrirla no anula ni actualiza esa factura: si hace falta corregirla, hacelo aparte.
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
            <StateStrip color={STATUS_STRIP[change.toStatus]} />
            <span className="flex items-center gap-2">
              {change.fromStatus && (
                <>
                  <span className="text-text-soft">{STATUS_LABELS[change.fromStatus]}</span>
                  <ArrowRight size={13} className="text-text-faint" />
                </>
              )}
              <span className="font-semibold text-text">{STATUS_LABELS[change.toStatus]}</span>
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
