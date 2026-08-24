import React from 'react';
import { Plus, Search, Eye, Ban, HandCoins } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
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

export function Receipts() {
  const { role } = useAuth();
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const [debts, setDebts] = React.useState<CustomerDebt[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');

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

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return receipts;
    return receipts.filter((r) =>
      [r.fullNumber, r.customerName].some((f) => f.toLowerCase().includes(term))
    );
  }, [receipts, search]);

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
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Cobranzas"
        subtitle="Los recibos con que se cancelan las facturas de venta."
        actions={
          <Link to="/cobranzas/nueva">
            <Button><Plus size={16} /> Nueva cobranza</Button>
          </Link>
        }
      />

      {error && (
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi label="Por cobrar" value={`$ ${formatMoney(totals.deuda)}`} danger={totals.deuda > 0} />
        <Kpi label="Saldos a favor" value={`$ ${formatMoney(totals.credito)}`} />
        <Kpi label="Cobrado" value={`$ ${formatMoney(totals.cobrado)}`} />
      </div>

      {/* ── Cuenta corriente ────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Cuenta corriente por cliente" />
        <Panel className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
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
                  <tr key={account.customerId} className="h-10 border-b border-line last:border-b-0 hover:bg-panel-alt">
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

      {/* ── Recibos ─────────────────────────────────────────────────── */}
      <SectionHeader title="Recibos" />

      <div className="relative sm:w-72">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Número o cliente…"
          className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <Panel className="overflow-x-auto">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1 w-36">Recibo</th>
              <th className="px-3 py-1 w-28">Fecha</th>
              <th className="px-3 py-1">Cliente</th>
              <th className="px-3 py-1 w-48">Imputado a</th>
              <th className="px-3 py-1 w-32 text-right">Cobrado</th>
              <th className="px-3 py-1 w-32 text-right">A cuenta</th>
              <th className="px-3 py-1 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-text-soft">Cargando recibos…</td></tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-text-soft">
                  {receipts.length === 0 ? (
                    <span className="flex flex-col items-center gap-2">
                      <HandCoins size={24} className="text-text-faint" />
                      Todavía no hay cobranzas registradas.
                    </span>
                  ) : (
                    'Ningún recibo coincide con la búsqueda.'
                  )}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((receipt) => {
                const voided = receipt.status === 'ANULADO';
                return (
                  <tr key={receipt.id} className="relative h-11 border-b border-line last:border-b-0 hover:bg-panel-alt">
                    <td data-primary className="relative px-4 py-1">
                      <StateStrip color={voided ? '#9a9a9a' : '#2e7d32'} />
                      <Link
                        to={`/recibo/${receipt.id}`}
                        className={cn(
                          'font-mono font-semibold hover:underline',
                          voided ? 'text-text-faint line-through' : 'text-text hover:text-accent-deep'
                        )}
                      >
                        {receipt.fullNumber}
                      </Link>
                      {voided && (
                        <span className="ml-2 bg-panel-head px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                          Anulado
                        </span>
                      )}
                    </td>

                    <td data-label="Fecha" className="px-3 py-1 text-text-soft">
                      {formatDate(receipt.receiptDate)}
                    </td>

                    <td data-label="Cliente" className="px-3 py-1">{receipt.customerName}</td>

                    <td data-label="Imputado a" className="px-3 py-1 text-[11px] text-text-soft">
                      {receipt.allocations.length === 0 ? (
                        <span className="text-text-faint">a cuenta</span>
                      ) : (
                        receipt.allocations.map((a) => (
                          <span key={a.invoiceId} className="block font-mono">
                            {a.invoiceType} {a.invoiceFullNumber}
                          </span>
                        ))
                      )}
                    </td>

                    <td data-label="Cobrado" className="px-3 py-1 text-right font-semibold">
                      <span className={cn(voided && 'text-text-faint line-through')}>
                        $ {formatMoney(receipt.totalAmount)}
                      </span>
                    </td>

                    <td data-label="A cuenta" className="px-3 py-1 text-right">
                      {receipt.onAccountAmount > 0 && !voided ? (
                        <span className="font-semibold text-state-done">
                          $ {formatMoney(receipt.onAccountAmount)}
                        </span>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>

                    <td className="px-3 py-1 text-center">
                      <Link
                        to={`/recibo/${receipt.id}`}
                        aria-label={`Ver recibo ${receipt.fullNumber}`}
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
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
        {label}
      </span>
      <span className={cn('block font-display text-2xl font-medium', danger ? 'text-danger' : 'text-text')}>
        {value}
      </span>
    </Panel>
  );
}
