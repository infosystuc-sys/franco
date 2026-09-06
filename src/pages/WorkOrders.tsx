import React from 'react';
import { Plus, Search, Eye, Edit2, AlertTriangle, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { cn, formatDate } from '@/src/lib/utils';
import { Button, PageHeader, Panel, StateStrip } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { NewWorkOrderModal } from '@/src/components/NewWorkOrderModal';
import { DeleteWorkOrdersModal } from '@/src/components/DeleteWorkOrdersModal';
import {
  fetchAllWorkOrders,
  fetchWorkOrderStatuses,
  getErrorMessage,
  type WorkOrderDeletionResult,
  type WorkOrderRow,
  type WorkOrderStatusDef,
} from '@/src/lib/workOrders';

/**
 * El listado completo de órdenes, en cualquier estado.
 *
 * El Panel es una cola de trabajo y por diseño solo muestra lo pendiente;
 * acá está todo, con quién la tiene asignada y desde cuándo, para poder
 * buscar una orden terminada hace tres semanas sin tener que recordarla.
 *
 * Un operario ve únicamente sus propias órdenes: lo decide el RLS de
 * work_orders, no esta pantalla.
 */
export function WorkOrders() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const navigate = useNavigate();

  const [orders, setOrders] = React.useState<WorkOrderRow[]>([]);
  const [statuses, setStatuses] = React.useState<WorkOrderStatusDef[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('');
  const [showNewOrder, setShowNewOrder] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [showDelete, setShowDelete] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const loadOrders = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [orderRows, statusDefs] = await Promise.all([fetchAllWorkOrders(), fetchWorkOrderStatuses(true)]);
      setOrders(orderRows);
      setStatuses(statusDefs);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const counts = React.useMemo(() => {
    const base: Record<string, number> = {};
    statuses.forEach((status) => { base[status.id] = 0; });
    orders.forEach((order) => { base[order.status.id] = (base[order.status.id] ?? 0) + 1; });
    return base;
  }, [orders, statuses]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (statusFilter && order.status.id !== statusFilter) return false;
      if (!term) return true;
      return [order.number, order.customerName, order.vehicleLabel, order.component, order.employeeName]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });
  }, [orders, search, statusFilter]);

  /**
   * Solo se actúa sobre lo que está marcado Y visible. Si se marcan tres
   * órdenes y después un filtro esconde una, el botón dice "las 2" y borra
   * esas dos: nunca se lleva puesta una fila que en ese momento no está en
   * pantalla.
   */
  const selectedOrders = React.useMemo(
    () => filtered.filter((order) => selectedIds.has(order.id)),
    [filtered, selectedIds]
  );
  const allFilteredSelected = filtered.length > 0 && selectedOrders.length === filtered.length;

  function toggleOne(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allFilteredSelected) filtered.forEach((order) => next.delete(order.id));
      else filtered.forEach((order) => next.add(order.id));
      return next;
    });
  }

  function handleDeleted(results: WorkOrderDeletionResult[]) {
    const borradas = results.filter((r) => r.deleted).map((r) => r.orderNumber);
    // La base revalida: entre que se armó la confirmación y se aceptó, alguien
    // pudo haber facturado una de estas órdenes. Eso hay que decirlo.
    const rechazadas = results.filter((r) => !r.deleted);

    const partes: string[] = [];
    if (borradas.length > 0) {
      partes.push(
        borradas.length === 1
          ? `Se eliminó la orden ${borradas[0]}.`
          : `Se eliminaron ${borradas.length} órdenes: ${borradas.join(', ')}.`
      );
    }
    rechazadas.forEach((r) => partes.push(`No se pudo eliminar ${r.orderNumber}: ${r.reason}.`));

    setNotice(partes.join(' ') || null);
    setShowDelete(false);
    setSelectedIds(new Set());
    loadOrders();
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Órdenes de Trabajo"
        subtitle="Todas las órdenes, en cualquier estado."
        actions={
          isAdmin && (
            <Button onClick={() => setShowNewOrder(true)}>
              <Plus size={16} /> Nueva orden
            </Button>
          )
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-line-strong bg-panel-alt px-4 py-3 text-sm text-text">
          <span>{notice}</span>
          <button
            onClick={() => setNotice(null)}
            aria-label="Cerrar aviso"
            className="shrink-0 text-text-soft hover:text-text"
          >
            ×
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {statuses.map((status) => (
          <button
            key={status.id}
            onClick={() => setStatusFilter(statusFilter === status.id ? '' : status.id)}
            className={cn(
              'relative overflow-hidden border p-3 text-left transition-colors',
              statusFilter === status.id
                ? 'border-accent bg-accent/10'
                : 'border-line-strong bg-panel hover:bg-panel-alt'
            )}
          >
            <StateStrip color={status.color} />
            <span className="block pl-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              {status.label}
            </span>
            <span className="block pl-2 font-display text-2xl font-medium text-text">
              {loading ? '—' : counts[status.id] ?? 0}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative sm:w-72">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Número, cliente, vehículo o empleado…"
            className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>

        {isAdmin && selectedOrders.length > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              {selectedOrders.length === 1
                ? '1 orden seleccionada'
                : `${selectedOrders.length} órdenes seleccionadas`}
            </span>
            <Button variant="danger" onClick={() => setShowDelete(true)}>
              <Trash2 size={16} /> Eliminar
            </Button>
          </div>
        )}
      </div>

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                {isAdmin && (
                  <th className="w-10 p-3">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleAllFiltered}
                      disabled={filtered.length === 0}
                      aria-label="Seleccionar todas las órdenes de la lista"
                      className="align-middle accent-accent"
                    />
                  </th>
                )}
                <th className="w-28 p-3 font-semibold">N° OT</th>
                <th className="p-3 font-semibold">Cliente</th>
                <th className="p-3 font-semibold">Vehículo / Equipo</th>
                <th className="w-40 p-3 font-semibold">Estado</th>
                <th className="w-36 p-3 font-semibold">Empleado</th>
                <th className="w-28 p-3 font-semibold">Fecha</th>
                <th className="w-28 p-3 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={isAdmin ? 8 : 7} className="p-8 text-center text-text-soft">Cargando…</td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 8 : 7} className="p-8 text-center text-text-soft">
                    {orders.length === 0
                      ? 'No hay órdenes cargadas todavía.'
                      : 'Ninguna orden coincide con la búsqueda.'}
                  </td>
                </tr>
              )}
              {filtered.map((order) => (
                <tr
                  key={order.id}
                  onDoubleClick={() => navigate(`/orden/${order.number}`)}
                  className="relative cursor-pointer border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt"
                >
                  {isAdmin && (
                    // El doble clic de la fila abre la orden; marcar no debe
                    // navegar, así que el clic muere acá.
                    <td className="p-3" onDoubleClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(order.id)}
                        onChange={() => toggleOne(order.id)}
                        aria-label={`Seleccionar la orden ${order.number}`}
                        className="align-middle accent-accent"
                      />
                    </td>
                  )}
                  <td data-primary className="relative py-3 pl-5 pr-3">
                    <StateStrip color={order.status.color} />
                    <Link
                      to={`/orden/${order.number}`}
                      className="inline-flex items-center gap-1.5 font-mono font-semibold text-text hover:text-accent-deep hover:underline"
                    >
                      {order.number}
                      {order.priceDiffers && (
                        <span title="El monto de la OT difiere de la cotización original">
                          <AlertTriangle size={14} className="text-state-wait" />
                        </span>
                      )}
                    </Link>
                  </td>
                  <td data-label="Cliente" className="p-3">{order.customerName}</td>
                  <td data-label="Vehículo" className="p-3">
                    <span className="block">{order.vehicleLabel}</span>
                    {order.component && (
                      <span className="block text-[11px] text-text-soft">{order.component}</span>
                    )}
                  </td>
                  <td data-label="Estado" className="p-3">
                    <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2"
                        style={{ backgroundColor: order.status.color }}
                      />
                      {order.status.label}
                    </span>
                  </td>
                  <td data-label="Empleado" className="p-3 text-text-soft">
                    {order.employeeName ?? '—'}
                  </td>
                  <td data-label="Fecha" className="p-3 text-text-soft">
                    {formatDate(order.createdAt.slice(0, 10))}
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      to={`/seguimiento/${order.publicToken}`}
                      title="Ver como lo ve el cliente"
                      className="inline-block p-1 text-text-soft transition-colors hover:text-accent-deep"
                    >
                      <Eye size={16} />
                    </Link>
                    <Link
                      to={`/orden/${order.number}`}
                      title={isAdmin ? 'Editar orden' : 'Ver detalle'}
                      className="ml-1 inline-block p-1 text-text-soft transition-colors hover:text-text"
                    >
                      <Edit2 size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {showNewOrder && (
        <NewWorkOrderModal
          onClose={() => setShowNewOrder(false)}
          onCreated={(workOrder) => {
            setShowNewOrder(false);
            navigate(`/orden/${workOrder.number}`);
          }}
        />
      )}

      {showDelete && (
        <DeleteWorkOrdersModal
          orders={selectedOrders.map((order) => ({
            id: order.id,
            number: order.number,
            customerName: order.customerName,
          }))}
          onClose={() => setShowDelete(false)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}
