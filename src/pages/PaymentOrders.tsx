import React from 'react';
import { Plus, Search, Eye, Ban, Banknote } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describePaymentOrderError,
  fetchPaymentOrders,
  fetchSupplierDebts,
  PURCHASE_DOC_TYPE_SHORT,
  type PaymentOrder,
  type SupplierDebt,
} from '@/src/lib/paymentOrders';

interface SupplierAccount {
  supplierId: string;
  supplierName: string;
  debt: number;
  credit: number;
}

function buildAccounts(debts: SupplierDebt[], orders: PaymentOrder[]): SupplierAccount[] {
  const map = new Map<string, SupplierAccount>();

  for (const debt of debts) {
    map.set(debt.supplierId, { ...debt, credit: 0 });
  }

  for (const order of orders) {
    if (order.status !== 'REGISTRADA') continue;
    const current = map.get(order.supplierId) ?? {
      supplierId: order.supplierId,
      supplierName: order.supplierName,
      debt: 0,
      credit: 0,
    };
    const used = order.values
      .filter((v) => v.kind === 'SALDO_A_FAVOR')
      .reduce((sum, v) => sum + v.amount, 0);
    current.credit = Math.round((current.credit + order.onAccountAmount - used) * 100) / 100;
    map.set(order.supplierId, current);
  }

  return [...map.values()]
    .filter((a) => a.debt !== 0 || a.credit > 0)
    .sort((a, b) => b.debt - a.debt);
}

export function PaymentOrders() {
  const { role, canViewHistory } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = React.useState<PaymentOrder[]>([]);
  const [debts, setDebts] = React.useState<SupplierDebt[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPaymentOrders(), fetchSupplierDebts()])
      .then(([o, d]) => {
        if (cancelled) return;
        setOrders(o);
        setDebts(d);
      })
      .catch((err) => !cancelled && setError(describePaymentOrderError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const accounts = React.useMemo(() => buildAccounts(debts, orders), [debts, orders]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return orders;
    return orders.filter((o) =>
      [o.fullNumber, o.supplierName].some((f) => f.toLowerCase().includes(term))
    );
  }, [orders, search]);

  const totals = React.useMemo(
    () => ({
      deuda: accounts.reduce((sum, a) => sum + Math.max(0, a.debt), 0),
      credito: accounts.reduce((sum, a) => sum + a.credit, 0),
      pagado: orders
        .filter((o) => o.status === 'REGISTRADA')
        .reduce((sum, o) => sum + o.totalAmount, 0),
    }),
    [accounts, orders]
  );

  if (role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title={canViewHistory ? 'Pagos' : ''}
        subtitle={canViewHistory ? 'Las órdenes con que se cancelan los comprobantes de compra.' : undefined}
        actions={
          <Link to="/pagos/nueva">
            <Button><Plus size={16} /> Nueva orden de pago</Button>
          </Link>
        }
      />

      {error && (
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {canViewHistory && (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi label="Por pagar" value={`$ ${formatMoney(totals.deuda)}`} danger={totals.deuda > 0} />
        <Kpi label="Saldos a favor" value={`$ ${formatMoney(totals.credito)}`} />
        <Kpi label="Pagado" value={`$ ${formatMoney(totals.pagado)}`} />
      </div>
      )}

      <section>
        <SectionHeader title="Cuenta corriente por proveedor" />
        <Panel className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="px-4 py-1">Proveedor</th>
                <th className="px-3 py-1 w-40 text-right">Se le debe</th>
                <th className="px-3 py-1 w-40 text-right">A favor</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={3} className="px-4 py-6 text-center text-text-soft">Cargando…</td></tr>
              )}
              {!loading && accounts.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-text-soft">
                    Ningún proveedor tiene saldo pendiente ni a favor.
                  </td>
                </tr>
              )}
              {!loading &&
                accounts.map((account) => (
                  <tr
                    key={account.supplierId}
                    onDoubleClick={() => navigate(`/pagos/nueva?proveedor=${account.supplierId}`)}
                    title="Doble click para pagar"
                    className="h-10 cursor-pointer border-b border-line last:border-b-0 hover:bg-panel-alt"
                  >
                    <td data-primary className="px-4 py-1 font-semibold">{account.supplierName}</td>
                    <td data-label="Se le debe" className="px-3 py-1 text-right font-display text-base font-medium">
                      {account.debt > 0 ? (
                        <span className="text-text">$ {formatMoney(account.debt)}</span>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>
                    <td data-label="A favor" className="px-3 py-1 text-right">
                      {account.credit > 0 ? (
                        <span className="font-semibold text-state-done">$ {formatMoney(account.credit)}</span>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      </section>

      {canViewHistory && (
      <>
      <SectionHeader title="Órdenes de pago" />

      <div className="relative sm:w-72">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Número o proveedor…"
          className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <Panel className="overflow-x-auto">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1 w-36">Orden</th>
              <th className="px-3 py-1 w-28">Fecha</th>
              <th className="px-3 py-1">Proveedor</th>
              <th className="px-3 py-1 w-48">Imputado a</th>
              <th className="px-3 py-1 w-32 text-right">Pagado</th>
              <th className="px-3 py-1 w-32 text-right">A cuenta</th>
              <th className="px-3 py-1 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-text-soft">Cargando órdenes…</td></tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-text-soft">
                  {orders.length === 0 ? (
                    <span className="flex flex-col items-center gap-2">
                      <Banknote size={24} className="text-text-faint" />
                      Todavía no hay órdenes de pago.
                    </span>
                  ) : (
                    'Ninguna orden coincide con la búsqueda.'
                  )}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((order) => {
                const voided = order.status === 'ANULADA';
                return (
                  <tr key={order.id} className="relative h-11 border-b border-line last:border-b-0 hover:bg-panel-alt">
                    <td data-primary className="relative px-4 py-1">
                      <StateStrip color={voided ? '#9a9a9a' : '#c62828'} />
                      <Link
                        to={`/pago/${order.id}`}
                        className={cn(
                          'font-mono font-semibold hover:underline',
                          voided ? 'text-text-faint line-through' : 'text-text hover:text-accent-deep'
                        )}
                      >
                        {order.fullNumber}
                      </Link>
                      {voided && (
                        <span className="ml-2 bg-panel-head px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                          Anulada
                        </span>
                      )}
                    </td>

                    <td data-label="Fecha" className="px-3 py-1 text-text-soft">
                      {formatDate(order.paymentDate)}
                    </td>

                    <td data-label="Proveedor" className="px-3 py-1">{order.supplierName}</td>

                    <td data-label="Imputado a" className="px-3 py-1 text-[11px] text-text-soft">
                      {order.allocations.length === 0 ? (
                        <span className="text-text-faint">a cuenta</span>
                      ) : (
                        order.allocations.map((a) => (
                          <span key={a.purchaseInvoiceId} className="block font-mono">
                            {PURCHASE_DOC_TYPE_SHORT[a.docType]} {a.letter} {a.fullNumber}
                          </span>
                        ))
                      )}
                    </td>

                    <td data-label="Pagado" className="px-3 py-1 text-right font-semibold">
                      <span className={cn(voided && 'text-text-faint line-through')}>
                        $ {formatMoney(order.totalAmount)}
                      </span>
                    </td>

                    <td data-label="A cuenta" className="px-3 py-1 text-right">
                      {order.onAccountAmount > 0 && !voided ? (
                        <span className="font-semibold text-state-done">
                          $ {formatMoney(order.onAccountAmount)}
                        </span>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>

                    <td className="px-3 py-1 text-center">
                      <Link
                        to={`/pago/${order.id}`}
                        aria-label={`Ver orden ${order.fullNumber}`}
                        className="inline-flex text-text-soft transition-colors hover:text-accent-deep"
                      >
                        {voided ? <Ban size={16} /> : <Eye size={16} />}
                      </Link>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Panel>
      </>
      )}
    </div>
  );
}

function Kpi({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <Panel className="p-4">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
        {label}
      </span>
      <span className={cn('block font-display text-2xl font-medium', danger ? 'text-danger' : 'text-text')}>
        {value}
      </span>
    </Panel>
  );
}
