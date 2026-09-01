import React from 'react';
import { Plus, Search, Eye, Edit2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { cn, formatDate } from '@/src/lib/utils';
import { Button, PageHeader, Panel, StateStrip } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { NewWorkOrderModal } from '@/src/components/NewWorkOrderModal';
import {
  fetchAllWorkOrders,
  fetchWorkOrderStatuses,
  getErrorMessage,
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

      <div className="relative sm:w-72">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Número, cliente, vehículo o empleado…"
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
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
                  <td colSpan={7} className="p-8 text-center text-text-soft">Cargando…</td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-text-soft">
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
                  <td data-primary className="relative py-3 pl-5 pr-3">
                    <StateStrip color={order.status.color} />
                    <Link
                      to={`/orden/${order.number}`}
                      className="font-mono font-semibold text-text hover:text-accent-deep hover:underline"
                    >
                      {order.number}
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
    </div>
  );
}
