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
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Link } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { Button, Panel, PageHeader, SectionHeader, StateStrip } from '@/src/components/ui';
import { NewWorkOrderModal } from '@/src/components/NewWorkOrderModal';
import { MenuHome } from '@/src/pages/MenuHome';
import {
  fetchDashboardData,
  getErrorMessage,
  hasLinkedEmployee,
  STATUS_LABELS,
  STATUS_STRIP,
  type WorkOrderListRow,
} from '@/src/lib/workOrders';

/**
 * El admin entra al menú estilo Tango (MenuHome): ese reemplaza al panel de
 * control como pantalla de inicio. El operario no tiene nada que hacer ahí
 * —no ve casi ninguna categoría— así que sigue entrando directo a sus
 * órdenes asignadas, que es lo único que le compete.
 */
export function Dashboard() {
  const { role } = useAuth();
  if (role === 'admin') return <MenuHome />;
  return <WorkOrderPanel />;
}

function WorkOrderPanel() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [orders, setOrders] = React.useState<WorkOrderListRow[]>([]);
  const [kpis, setKpis] = React.useState({ autorizadas: 0, enReparacion: 0, espRepuestos: 0, terminadasHoy: 0, cerradasMes: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showNewOrder, setShowNewOrder] = React.useState(false);
  // null mientras no se sabe (o no aplica, por ser admin): solo se usa para
  // elegir el mensaje de la lista vacía de un operario.
  const [linkedEmployee, setLinkedEmployee] = React.useState<boolean | null>(null);

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

  // Aparte de loadData: si esto fallara no debe tapar la lista de órdenes,
  // que es lo importante. Solo decide qué mensaje mostrar si queda vacía.
  React.useEffect(() => {
    if (role !== 'operario') return;
    hasLinkedEmployee()
      .then(setLinkedEmployee)
      .catch(() => setLinkedEmployee(null));
  }, [role]);

  // Un operario dado de baja (o nunca vinculado) también ve la lista vacía,
  // pero por un motivo distinto al de "todavía no tenés nada asignado": sin
  // esto, parece que el sistema falla en lugar de explicar qué pasa.
  const emptyMessage = isAdmin
    ? 'No hay órdenes abiertas. Empezá por una cotización.'
    : linkedEmployee === false
      ? 'Tu usuario no está vinculado a ningún empleado activo. Pedile al administrador que lo revise.'
      : 'No tenés órdenes asignadas. El encargado del taller te las asigna desde la orden de trabajo.';

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
                    {emptyMessage}
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
          onCreated={() => {
            setShowNewOrder(false);
            loadData();
          }}
        />
      )}

    </div>
  );
}
