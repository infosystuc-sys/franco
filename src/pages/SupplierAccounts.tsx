import React from 'react';
import { Plus } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describePaymentOrderError,
  fetchPaymentOrders,
  fetchSupplierDebts,
  type PaymentOrder,
  type SupplierDebt,
} from '@/src/lib/paymentOrders';
import { fetchPurchases, summarizeBySupplier, type SupplierBalance } from '@/src/lib/purchases';

interface SupplierAccount {
  supplierId: string;
  supplierName: string;
  documents: number;
  overdue: number;
  debt: number;
  credit: number;
}

/**
 * Cuenta corriente por proveedor. Antes estaba dos veces, arriba de Compras y
 * arriba de Pagos, cada una con la mitad de los datos; esas dos pantallas
 * pasaron a ser solo listados con la forma del de Tango, y esto quedó acá,
 * junto.
 *
 * Deber y tener a favor se muestran separados y no netos: deber $50.000 y
 * tener $10.000 a favor no es lo mismo que deber $40.000.
 */
function buildAccounts(
  debts: SupplierDebt[],
  orders: PaymentOrder[],
  balances: SupplierBalance[]
): SupplierAccount[] {
  const map = new Map<string, SupplierAccount>();
  const vacia = (supplierId: string, supplierName: string): SupplierAccount => ({
    supplierId,
    supplierName,
    documents: 0,
    overdue: 0,
    debt: 0,
    credit: 0,
  });

  for (const debt of debts) {
    map.set(debt.supplierId, { ...vacia(debt.supplierId, debt.supplierName), debt: debt.debt });
  }

  for (const order of orders) {
    if (order.status !== 'REGISTRADA') continue;
    const current = map.get(order.supplierId) ?? vacia(order.supplierId, order.supplierName);
    const used = order.values
      .filter((v) => v.kind === 'SALDO_A_FAVOR')
      .reduce((sum, v) => sum + v.amount, 0);
    current.credit = Math.round((current.credit + order.onAccountAmount - used) * 100) / 100;
    map.set(order.supplierId, current);
  }

  for (const b of balances) {
    const current = map.get(b.supplierId);
    if (!current) continue;
    current.documents = b.documents;
    current.overdue = b.overdue;
  }

  return [...map.values()]
    .filter((a) => a.debt !== 0 || a.credit > 0)
    .sort((a, b) => b.debt - a.debt);
}

export function SupplierAccounts() {
  const { role, canViewHistory } = useAuth();
  const navigate = useNavigate();
  const [accounts, setAccounts] = React.useState<SupplierAccount[]>([]);
  const [pagado, setPagado] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPaymentOrders(), fetchSupplierDebts(), fetchPurchases()])
      .then(([orders, debts, purchases]) => {
        if (cancelled) return;
        setAccounts(buildAccounts(debts, orders, summarizeBySupplier(purchases)));
        setPagado(
          orders.filter((o) => o.status === 'REGISTRADA').reduce((sum, o) => sum + o.totalAmount, 0)
        );
      })
      .catch((err) => !cancelled && setError(describePaymentOrderError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const deuda = accounts.reduce((sum, a) => sum + Math.max(0, a.debt), 0);
  const vencido = accounts.reduce((sum, a) => sum + a.overdue, 0);
  const credito = accounts.reduce((sum, a) => sum + a.credit, 0);

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Cuenta corriente de proveedores"
        subtitle="Lo que se le debe a cada proveedor y lo que tiene a favor. Doble click en uno para pagarle."
        actions={
          <>
            <Link to="/compras">
              <Button variant="ghost" type="button">Ver compras</Button>
            </Link>
            <Link to="/pagos">
              <Button variant="ghost" type="button">Ver pagos</Button>
            </Link>
            <Link to="/pagos/nueva">
              <Button><Plus size={16} /> Nueva orden de pago</Button>
            </Link>
          </>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {canViewHistory && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Kpi label="Por pagar" value={`$ ${formatMoney(deuda)}`} danger={deuda > 0} />
          <Kpi label="Vencido" value={`$ ${formatMoney(vencido)}`} danger={vencido > 0} />
          <Kpi label="Saldos a favor" value={`$ ${formatMoney(credito)}`} />
          <Kpi label="Pagado" value={`$ ${formatMoney(pagado)}`} />
        </div>
      )}

      <Panel className="overflow-x-auto overflow-y-hidden">
        <table className="table-stack w-full text-left text-[15px]">
          <thead className="h-9 bg-panel-head text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1">Proveedor</th>
              <th className="px-3 py-1 w-28 text-right">Comprobantes</th>
              <th className="px-3 py-1 w-32 text-right">Vencido</th>
              <th className="px-3 py-1 w-40 text-right">Se le debe</th>
              <th className="px-3 py-1 w-40 text-right">A favor</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-text-soft">Cargando…</td></tr>
            )}
            {!loading && accounts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-text-soft">
                  Ningún proveedor tiene saldo pendiente ni a favor.
                </td>
              </tr>
            )}
            {!loading &&
              accounts.map((a) => (
                <tr
                  key={a.supplierId}
                  onDoubleClick={() => navigate(`/pagos/nueva?proveedor=${a.supplierId}`)}
                  title="Doble click para pagar"
                  className="h-10 cursor-pointer border-b border-line last:border-b-0 hover:bg-panel-alt"
                >
                  <td data-primary className="px-4 py-1 font-semibold">{a.supplierName}</td>
                  <td data-label="Comprobantes" className="px-3 py-1 text-right text-text-soft">
                    {a.documents || '—'}
                  </td>
                  <td data-label="Vencido" className="px-3 py-1 text-right">
                    {a.overdue > 0 ? (
                      <span className="font-semibold text-danger">$ {formatMoney(a.overdue)}</span>
                    ) : (
                      <span className="text-text-faint">—</span>
                    )}
                  </td>
                  <td data-label="Se le debe" className="px-3 py-1 text-right font-display text-base font-medium">
                    {a.debt > 0 ? (
                      <span className="text-text">$ {formatMoney(a.debt)}</span>
                    ) : (
                      <span className="text-text-faint">—</span>
                    )}
                  </td>
                  <td data-label="A favor" className="px-3 py-1 text-right">
                    {a.credit > 0 ? (
                      <span className="font-semibold text-state-done">$ {formatMoney(a.credit)}</span>
                    ) : (
                      <span className="text-text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function Kpi({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <Panel className="p-4">
      <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-faint">
        {label}
      </span>
      <span className={cn('block font-display text-2xl font-medium', danger ? 'text-danger' : 'text-text')}>
        {value}
      </span>
    </Panel>
  );
}
