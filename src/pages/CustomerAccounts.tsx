import React from 'react';
import { Plus } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describeReceiptError,
  fetchReceipts,
  fetchSaldosDeClientes,
  type SaldoCliente,
} from '@/src/lib/receipts';

/**
 * Cuenta corriente por cliente: lo que debe, lo que tiene a favor y el saldo.
 *
 * Deber y tener a favor se muestran también por separado: deber $50.000 y
 * tener $10.000 a favor no es lo mismo que deber $40.000 — hay una factura
 * concreta impaga y un crédito que se aplica en el próximo recibo. El saldo
 * es el mismo número que el subtotal del cliente en la composición de saldos.
 */
export function CustomerAccounts() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [accounts, setAccounts] = React.useState<SaldoCliente[]>([]);
  const [cobrado, setCobrado] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSaldosDeClientes(), fetchReceipts()])
      .then(([saldos, receipts]) => {
        if (cancelled) return;
        setAccounts([...saldos].sort((a, b) => b.saldo - a.saldo));
        setCobrado(
          receipts.filter((r) => r.status === 'REGISTRADO').reduce((sum, r) => sum + r.totalAmount, 0)
        );
      })
      .catch((err) => !cancelled && setError(describeReceiptError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const deuda = accounts.reduce((sum, a) => sum + a.deuda, 0);
  const aFavor = accounts.reduce((sum, a) => sum + a.aFavor, 0);
  const saldo = accounts.reduce((sum, a) => sum + a.saldo, 0);

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Cuenta corriente de clientes"
        subtitle="Lo que debe cada cliente, lo que tiene a favor y su saldo. Doble click en uno para cobrarle."
        actions={
          <>
            <Link to="/cobranzas">
              <Button variant="ghost" type="button">Ver recibos</Button>
            </Link>
            <Link to="/informe/saldos-clientes">
              <Button variant="ghost" type="button">Composición de saldos</Button>
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

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Kpi label="Por cobrar" value={`$ ${formatMoney(deuda)}`} danger={deuda > 0} />
        <Kpi label="Saldos a favor" value={`$ ${formatMoney(aFavor)}`} />
        <Kpi label="Saldo total" value={`$ ${formatMoney(saldo)}`} />
        <Kpi label="Cobrado" value={`$ ${formatMoney(cobrado)}`} />
      </div>

      <section>
        <SectionHeader title="Cuenta corriente por cliente" />
        <Panel className="overflow-x-auto overflow-y-hidden">
          <table className="table-stack w-full text-left text-[15px]">
            <thead className="h-9 bg-panel-head text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="px-4 py-1">Cliente</th>
                <th className="px-3 py-1 w-40 text-right">Debe</th>
                <th className="px-3 py-1 w-40 text-right">A favor</th>
                <th className="px-3 py-1 w-40 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-text-soft">Cargando…</td></tr>
              )}
              {!loading && accounts.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-text-soft">
                    Ningún cliente tiene saldo pendiente ni a favor.
                  </td>
                </tr>
              )}
              {!loading &&
                accounts.map((a) => (
                  <tr
                    key={a.customerId}
                    onDoubleClick={() => navigate(`/cobranzas/nueva?cliente=${a.customerId}`)}
                    title="Doble click para cobrar"
                    className="h-10 cursor-pointer border-b border-line last:border-b-0 hover:bg-panel-alt"
                  >
                    <td data-primary className="px-4 py-1 font-semibold">{a.customerName}</td>
                    <td data-label="Debe" className="px-3 py-1 text-right">
                      {a.deuda > 0 ? `$ ${formatMoney(a.deuda)}` : <span className="text-text-faint">—</span>}
                    </td>
                    <td data-label="A favor" className="px-3 py-1 text-right">
                      {a.aFavor > 0 ? (
                        <span className="font-semibold text-state-done">$ {formatMoney(a.aFavor)}</span>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>
                    <td data-label="Saldo" className="px-3 py-1 text-right font-display text-base font-medium">
                      {a.saldo < 0 ? (
                        <span className="text-state-done" title="A favor del cliente">− $ {formatMoney(-a.saldo)}</span>
                      ) : (
                        <span className="text-text">$ {formatMoney(a.saldo)}</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
            {!loading && accounts.length > 0 && (
              <tfoot className="border-t-2 border-ink bg-panel-head font-semibold">
                <tr className="h-10">
                  <td className="px-4 py-1">TOTALES</td>
                  <td className="px-3 py-1 text-right">$ {formatMoney(deuda)}</td>
                  <td className="px-3 py-1 text-right">$ {formatMoney(aFavor)}</td>
                  <td className="px-3 py-1 text-right">$ {formatMoney(saldo)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </Panel>
      </section>
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
