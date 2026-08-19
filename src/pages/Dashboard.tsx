import React from 'react';
import {
  CheckCircle2,
  Wrench,
  Hourglass,
  CheckCircle,
  FolderOpen,
  Plus,
  Eye,
  Edit2,
  X
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Link } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { Button, Label, Panel, PageHeader, SectionHeader, StateStrip, fieldClass } from '@/src/components/ui';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { vehicleLabel } from '@/src/lib/vehicles';
import {
  createWorkOrder,
  fetchDashboardData,
  getErrorMessage,
  STATUS_LABELS,
  STATUS_STRIP,
  type WorkOrderListRow,
} from '@/src/lib/workOrders';

export function Dashboard() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [orders, setOrders] = React.useState<WorkOrderListRow[]>([]);
  const [kpis, setKpis] = React.useState({ autorizadas: 0, enReparacion: 0, espRepuestos: 0, terminadasHoy: 0, cerradasMes: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showNewOrder, setShowNewOrder] = React.useState(false);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { kpis, pendingOrders } = await fetchDashboardData();
      setKpis(kpis);
      setOrders(pendingOrders);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  // Cada indicador es un estado del circuito: el color es el mismo que marca
  // la tira lateral de la fila, así el número y la orden se asocian solos.
  const kpiCards = [
    { label: 'Autorizadas', value: kpis.autorizadas, icon: CheckCircle2, strip: STATUS_STRIP.AUTORIZADO },
    { label: 'Esp. Repuestos', value: kpis.espRepuestos, icon: Hourglass, strip: STATUS_STRIP.EN_ESPERA_REP },
    { label: 'En Reparación', value: kpis.enReparacion, icon: Wrench, strip: STATUS_STRIP.EN_REPARACION },
    { label: 'Terminadas hoy', value: kpis.terminadasHoy, icon: CheckCircle, strip: STATUS_STRIP.TERMINADO },
    { label: 'Cerradas del mes', value: kpis.cerradasMes, icon: FolderOpen, strip: 'var(--color-state-idle)' },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Panel de control"
        subtitle="Órdenes abiertas en el taller, por etapa."
        actions={
          isAdmin && (
            <Button onClick={() => setShowNewOrder(true)}>
              <Plus size={16} /> Nueva orden
            </Button>
          )
        }
      />

      {error && (
        <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          No se pudo conectar con Supabase: {error}
        </div>
      )}

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-5">
        {kpiCards.map((kpi) => (
          <Panel key={kpi.label} className="relative flex flex-col justify-between p-4 pl-5">
            <StateStrip color={kpi.strip} />
            <div className="mb-3 flex items-start justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase leading-tight tracking-[0.06em] text-text-soft">
                {kpi.label}
              </span>
              <kpi.icon size={18} className="shrink-0 text-text-faint" />
            </div>
            <span className="font-display text-4xl font-medium leading-none text-text">
              {loading ? '—' : kpi.value}
            </span>
          </Panel>
        ))}
      </div>

      <SectionHeader title="Órdenes que requieren atención" />

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="w-28 p-3 font-semibold">N° OT</th>
                <th className="p-3 font-semibold">Cliente</th>
                <th className="p-3 font-semibold">Vehículo / Equipo</th>
                <th className="w-40 p-3 font-semibold">Estado</th>
                <th className="w-28 p-3 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-text-soft">Cargando…</td>
                </tr>
              )}
              {!loading && orders.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-text-soft">
                    No hay órdenes abiertas. Empezá por una cotización.
                  </td>
                </tr>
              )}
              {orders.map((order) => (
                <tr
                  key={order.id}
                  className="relative border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt"
                >
                  <td data-primary className="relative py-3 pl-5 pr-3">
                    <StateStrip color={STATUS_STRIP[order.status]} />
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
                        style={{ backgroundColor: STATUS_STRIP[order.status] }}
                      />
                      {STATUS_LABELS[order.status]}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      to={`/seguimiento/${order.number}`}
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
          onCreated={() => {
            setShowNewOrder(false);
            loadData();
          }}
        />
      )}
    </div>
  );
}

function NewWorkOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = React.useState(true);
  const [customerId, setCustomerId] = React.useState('');
  const [vehicleId, setVehicleId] = React.useState('');
  const [component, setComponent] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchCustomers(true)
      .then((data) => !cancelled && setCustomers(data))
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoadingCustomers(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  // Solo se ofrecen vehículos activos para nuevas órdenes.
  const vehicles = (selectedCustomer?.vehicles ?? []).filter((v) => v.active);

  // Al cambiar de cliente, se preselecciona su vehículo si tiene uno solo.
  function handleCustomerChange(id: string) {
    setCustomerId(id);
    const customer = customers.find((c) => c.id === id);
    const activeVehicles = (customer?.vehicles ?? []).filter((v) => v.active);
    setVehicleId(activeVehicles.length === 1 ? activeVehicles[0].id : '');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!customerId) {
      setError('Elegí un cliente.');
      return;
    }
    if (!vehicleId) {
      setError('Elegí un vehículo. Si el cliente no tiene ninguno cargado, agregalo desde Clientes.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createWorkOrder({ customerId, vehicleId, component });
      onCreated();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md border border-line-strong bg-panel">
        <div className="flex items-center justify-between border-b border-line bg-panel-head px-5 py-3">
          <h2 className="font-display text-xl uppercase tracking-[0.04em] text-text-faint">
            Nueva orden de trabajo
          </h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <div className="grid grid-cols-1 gap-4">
            <Label>
              Cliente
              <select
                value={customerId}
                onChange={(e) => handleCustomerChange(e.target.value)}
                disabled={loadingCustomers}
                className={fieldClass(true, 'font-normal normal-case')}
              >
                <option value="">
                  {loadingCustomers ? 'Cargando clientes…' : 'Elegí un cliente'}
                </option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                    {customer.taxId ? ` — ${formatCuit(customer.taxId)}` : ''}
                  </option>
                ))}
              </select>
              {!loadingCustomers && customers.length === 0 && (
                <span className="mt-1 block text-[11px] font-normal normal-case text-danger">
                  No hay clientes activos. Cargá uno en Clientes.
                </span>
              )}
            </Label>

            <Label>
              Vehículo / Equipo
              <select
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                disabled={!selectedCustomer}
                className={fieldClass(true, 'font-normal normal-case disabled:bg-panel-alt')}
              >
                <option value="">
                  {!selectedCustomer ? 'Elegí primero un cliente' : 'Elegí un vehículo'}
                </option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicleLabel(vehicle)}
                  </option>
                ))}
              </select>
              {selectedCustomer && vehicles.length === 0 && (
                <span className="mt-1 block text-[11px] font-normal normal-case text-danger">
                  Este cliente no tiene vehículos activos. Agregale uno en Vehículos.
                </span>
              )}
            </Label>

            <Label>
              Componente
              <input
                value={component}
                onChange={(e) => setComponent(e.target.value)}
                className={fieldClass(false, 'font-normal normal-case')}
                placeholder="Bomba de inyección Common Rail"
              />
            </Label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Creando…' : 'Crear orden'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
