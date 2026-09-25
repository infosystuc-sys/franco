import React from 'react';
import { Plus } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describeReceiptError,
  fetchCustomerDebts,
  fetchReceipts,
  type CustomerDebt,
  type Receipt,
} from '@/src/lib/receipts';

interface CustomerAccount {
  customerId: string;
  customerName: string;
  debt: number;
  credit: number;
}

/**
 * Cuenta corriente por cliente: lo que debe y lo que tiene a favor.
 *
 * Los dos números se muestran separados y no netos a propósito: deber
 * $50.000 y tener $10.000 a favor no es lo mismo que deber $40.000 — hay una
 * factura concreta impaga y un crédito que hay que aplicar a mano.
 */
function buildAccounts(debts: CustomerDebt[], receipts: Receipt[]): CustomerAccount[] {
  const map = new Map<string, CustomerAccount>();

  for (const debt of debts) {
    map.set(debt.customerId, {
      customerId: debt.customerId,
      customerName: debt.customerName,
      debt: debt.debt,
      credit: 0,
    });
  }

  for (const receipt of receipts) {
    if (receipt.status !== 'REGISTRADO') continue;
    const current = map.get(receipt.customerId) ?? {
      customerId: receipt.customerId,
      customerName: receipt.customerName,
      debt: 0,
      credit: 0,
    };
    // Lo cobrado de más suma crédito; lo que ya se usó de ese crédito lo resta.
    const used = receipt.values
      .filter((v) => v.kind === 'SALDO_A_FAVOR')
      .reduce((sum, v) => sum + v.amount, 0);
    current.credit = Math.round((current.credit + receipt.onAccountAmount - used) * 100) / 100;
    map.set(receipt.customerId, current);
  }

  return [...map.values()]
    .filter((account) => account.debt > 0 || account.credit > 0)
    .sort((a, b) => b.debt - a.debt);
}

/**
 * Cuenta corriente por cliente: lo que debe cada uno y lo que tiene a favor.
 * Antes compartía pantalla con el listado de recibos; Cobranzas pasó a ser
 * solo el listado, con la forma del de Tango, y esto quedó en su lugar.
 */
export function CustomerAccounts() {
  const { role, canViewHistory } = useAuth();
  const navigate = useNavigate();
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const [debts, setDebts] = React.useState<CustomerDebt[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([fetchReceipts(), fetchCustomerDebts()])
      .then(([r, d]) => {
        if (cancelled) return;
        setReceipts(r);
        setDebts(d);
      })
      .catch((err) => !cancelled && setError(describeReceiptError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const accounts = React.useMemo(() => buildAccounts(debts, receipts), [debts, receipts]);

  const totals = React.useMemo(
    () => ({
      deuda: accounts.reduce((sum, a) => sum + a.debt, 0),
      credito: accounts.reduce((sum, a) => sum + a.credit, 0),
      cobrado: receipts
        .filter((r) => r.status === 'REGISTRADO')
        .reduce((sum, r) => sum + r.totalAmount, 0),
    }),
    [accounts, receipts]
  );

  if (role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Cuenta corriente de clientes"
        subtitle="Lo que debe cada cliente y lo que tiene a favor. Doble click en uno para cobrarle."
        actions={
          <>
            <Link to="/cobranzas">
              <Button variant="ghost" type="button">Ver recibos</Button>
            </Link>
            <Link to="/cobranzas/nueva">
              <Button><Plus size={16} /> Nueva cobranza</Button>
            </Link>
          </>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {canViewHistory && (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi label="Por cobrar" value={`$ ${formatMoney(totals.deuda)}`} danger={totals.deuda > 0} />
        <Kpi label="Saldos a favor" value={`$ ${formatMoney(totals.credito)}`} />
        <Kpi label="Cobrado" value={`$ ${formatMoney(totals.cobrado)}`} />
      </div>
      )}

      {/* ── Cuenta corriente ────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Cuenta corriente por cliente" />
        <Panel className="overflow-x-auto overflow-y-hidden">
          <table className="table-stack w-full text-left text-[15px]">
            <thead className="h-9 bg-panel-head text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="px-4 py-1">Cliente</th>
                <th className="px-3 py-1 w-40 text-right">Debe</th>
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
                    Ningún cliente tiene saldo pendiente ni a favor.
                  </td>
                </tr>
              )}
              {!loading &&
                accounts.map((account) => (
                  <tr
                    key={account.customerId}
                    onDoubleClick={() => navigate(`/cobranzas/nueva?cliente=${account.customerId}`)}
                    title="Doble click para cobrar"
                    className="h-10 cursor-pointer border-b border-line last:border-b-0 hover:bg-panel-alt"
                  >
                    <td data-primary className="px-4 py-1 font-semibold">{account.customerName}</td>
                    <td data-label="Debe" className="px-3 py-1 text-right font-display text-base font-medium">
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

      <p className="text-xs text-text-soft">
        Deber y tener a favor se muestran separados, no netos: deber $50.000 y
        tener $10.000 a favor no es lo mismo que deber $40.000 — hay una factura
        concreta impaga y un crédito que se aplica a mano en el próximo recibo.
      </p>
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
