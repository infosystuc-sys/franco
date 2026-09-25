import React from 'react';
import { Receipt, ArrowRight } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { describeInvoiceError, fetchPendingToInvoice, type PendingToInvoice } from '@/src/lib/invoices';

export function InvoicesPending() {
  const { role } = useAuth();
  const [orders, setOrders] = React.useState<PendingToInvoice[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchPendingToInvoice()
      .then((rows) => !cancelled && setOrders(rows))
      .catch((err) => !cancelled && setError(describeInvoiceError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Órdenes para facturar"
        subtitle="Las órdenes terminadas que todavía no tienen factura."
        actions={
          <Link to="/facturas">
            <Button variant="ghost" type="button">Ver facturas emitidas</Button>
          </Link>
        }
      />
      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}
      <PendingToInvoiceList orders={orders} loading={loading} />
    </div>
  );
}

/**
 * Lo que hay para facturar: las órdenes terminadas sin factura. Es el único
 * camino a una orden terminada, que el panel no muestra por ser una cola de
 * trabajo. Antes iba arriba del listado de facturas; ese listado pasó a tener
 * la forma del de Tango, que es solo comprobantes emitidos.
 */
function PendingToInvoiceList({
  orders,
  loading,
}: {
  orders: PendingToInvoice[];
  loading: boolean;
}) {
  return (
    <div>
      <SectionHeader
        title={`Pendientes de facturar${orders.length > 0 ? ` (${orders.length})` : ''}`}
      />

      <Panel className="overflow-x-auto overflow-y-hidden">
        <table className="table-stack w-full text-left text-[15px]">
          <thead className="h-9 bg-panel-head text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1 w-28">Orden</th>
              <th className="px-3 py-1">Cliente</th>
              <th className="px-3 py-1">Vehículo / Componente</th>
              <th className="px-3 py-1 w-36"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-text-soft">Cargando…</td>
              </tr>
            )}

            {!loading && orders.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-text-soft">
                  No hay órdenes terminadas sin facturar.
                </td>
              </tr>
            )}

            {!loading &&
              orders.map((order) => (
                <tr
                  key={order.id}
                  className="relative h-11 border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt"
                >
                  <td data-primary className="relative px-4 py-1">
                    <StateStrip color="var(--color-state-done)" />
                    <Link
                      to={`/orden/${order.number}`}
                      className="font-mono font-semibold text-text hover:text-accent-deep hover:underline"
                    >
                      {order.number}
                    </Link>
                  </td>
                  <td data-label="Cliente" className="px-3 py-1">{order.customerName}</td>
                  <td data-label="Vehículo" className="px-3 py-1 text-text-soft">
                    <span className="block">{order.vehicleLabel}</span>
                    {order.component && (
                      <span className="block text-[13px] text-text-faint">{order.component}</span>
                    )}
                  </td>
                  <td className="px-3 py-1 text-right">
                    <Link to={`/facturar/${order.number}`}>
                      <Button type="button" className="px-3">
                        <Receipt size={15} /> Facturar <ArrowRight size={14} />
                      </Button>
                    </Link>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
