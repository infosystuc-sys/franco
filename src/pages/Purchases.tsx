import React from 'react';
import { Plus, Search, Eye, AlertTriangle, ShoppingCart } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  balanceOf,
  describePurchaseError,
  fetchPurchases,
  formatDate,
  isOverdue,
  PURCHASE_DOC_TYPE_SHORT,
  PURCHASE_KIND_LABELS,
  signOf,
  summarizeBySupplier,
  type PurchaseListRow,
} from '@/src/lib/purchases';

type Filter = 'TODOS' | 'ADEUDADOS' | 'VENCIDOS' | 'ANULADOS';

const FILTER_LABELS: Record<Filter, string> = {
  TODOS: 'Todos',
  ADEUDADOS: 'Con saldo',
  VENCIDOS: 'Vencidos',
  ANULADOS: 'Anulados',
};

const FILTERS = Object.keys(FILTER_LABELS) as Filter[];

function matchesFilter(doc: PurchaseListRow, filter: Filter): boolean {
  const voided = doc.status === 'ANULADA';
  switch (filter) {
    case 'TODOS':
      return true;
    case 'ANULADOS':
      return voided;
    case 'VENCIDOS':
      return isOverdue(doc);
    case 'ADEUDADOS':
      return !voided && balanceOf(doc) > 0;
  }
}

/** El color codifica qué hay que hacer con el comprobante, de un vistazo. */
function stripColor(doc: PurchaseListRow): string {
  if (doc.status === 'ANULADA') return '#9a9a9a';
  if (isOverdue(doc)) return '#c62828';
  if (doc.docType === 'NOTA_CREDITO') return '#2e7d32';
  if (balanceOf(doc) <= 0) return '#2e7d32';
  return '#2b6cb0';
}

export function Purchases() {
  const { role } = useAuth();
  const [docs, setDocs] = React.useState<PurchaseListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<Filter>('TODOS');

  React.useEffect(() => {
    let cancelled = false;
    fetchPurchases()
      .then((data) => !cancelled && setDocs(data))
      .catch((err) => !cancelled && setError(describePurchaseError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return docs.filter((doc) => {
      if (!matchesFilter(doc, filter)) return false;
      if (!term) return true;
      return [doc.fullNumber, doc.supplierName].some((field) =>
        String(field).toLowerCase().includes(term)
      );
    });
  }, [docs, search, filter]);

  const balances = React.useMemo(() => summarizeBySupplier(docs), [docs]);

  const totals = React.useMemo(() => {
    const live = docs.filter((doc) => doc.status === 'REGISTRADA');
    return {
      deuda: balances.reduce((sum, entry) => sum + entry.balance, 0),
      vencido: live.filter(isOverdue).reduce((sum, doc) => sum + balanceOf(doc), 0),
      comprobantes: live.length,
    };
  }, [docs, balances]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Compras"
        subtitle="Comprobantes recibidos de proveedores y lo que se les debe."
        actions={
          <Link to="/compras/nueva">
            <Button><Plus size={16} /> Nueva compra</Button>
          </Link>
        }
      />

      {error && (
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi label="Deuda total" value={`$ ${formatMoney(totals.deuda)}`} />
        <Kpi label="Vencido" value={`$ ${formatMoney(totals.vencido)}`} danger={totals.vencido > 0} />
        <Kpi label="Comprobantes" value={String(totals.comprobantes)} />
      </div>

      {/* ── Cuenta corriente ────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Cuenta corriente por proveedor" />
        <Panel className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="px-4 py-1">Proveedor</th>
                <th className="px-3 py-1 w-28 text-right">Comprobantes</th>
                <th className="px-3 py-1 w-32 text-right">Vencido</th>
                <th className="px-3 py-1 w-36 text-right">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-text-soft">Cargando…</td></tr>
              )}
              {!loading && balances.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-text-soft">
                    Ningún proveedor tiene movimientos todavía.
                  </td>
                </tr>
              )}
              {!loading &&
                balances.map((entry) => (
                  <tr key={entry.supplierId} className="h-10 border-b border-line last:border-b-0 hover:bg-panel-alt">
                    <td data-primary className="px-4 py-1 font-semibold">{entry.supplierName}</td>
                    <td data-label="Comprobantes" className="px-3 py-1 text-right text-text-soft">
                      {entry.documents}
                    </td>
                    <td data-label="Vencido" className="px-3 py-1 text-right">
                      {entry.overdue > 0 ? (
                        <span className="font-semibold text-danger">$ {formatMoney(entry.overdue)}</span>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>
                    <td data-label="Saldo" className="px-3 py-1 text-right font-display text-base font-medium">
                      $ {formatMoney(entry.balance)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      </section>

      {/* ── Comprobantes ────────────────────────────────────────────── */}
      <SectionHeader title="Comprobantes" />

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((option) => (
          <button
            key={option}
            onClick={() => setFilter(option)}
            className={cn(
              'border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
              filter === option
                ? 'border-accent bg-accent text-accent-ink'
                : 'border-line-strong bg-panel text-text-soft hover:bg-panel-alt'
            )}
          >
            {FILTER_LABELS[option]}
          </button>
        ))}

        <div className="relative ml-auto w-full sm:w-64">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Número o proveedor…"
            className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>
      </div>

      <Panel className="overflow-x-auto">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1 w-40">Comprobante</th>
              <th className="px-3 py-1">Proveedor</th>
              <th className="px-3 py-1 w-24">Tipo</th>
              <th className="px-3 py-1 w-28">Fecha</th>
              <th className="px-3 py-1 w-32">Vencimiento</th>
              <th className="px-3 py-1 w-32 text-right">Total</th>
              <th className="px-3 py-1 w-32 text-right">Saldo</th>
              <th className="px-3 py-1 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-text-soft">Cargando comprobantes…</td></tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-text-soft">
                  {docs.length === 0 ? (
                    <span className="flex flex-col items-center gap-2">
                      <ShoppingCart size={24} className="text-text-faint" />
                      Todavía no hay compras cargadas.
                    </span>
                  ) : (
                    'Ningún comprobante coincide con el filtro.'
                  )}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((doc) => {
                const voided = doc.status === 'ANULADA';
                const overdue = isOverdue(doc);
                const credit = doc.docType === 'NOTA_CREDITO';

                return (
                  <tr key={doc.id} className="relative h-11 border-b border-line hover:bg-panel-alt">
                    <td data-primary className="relative px-4 py-1">
                      <StateStrip color={stripColor(doc)} />
                      <Link
                        to={`/compra/${doc.id}`}
                        className="font-mono font-semibold text-text hover:text-accent-deep hover:underline"
                      >
                        {doc.letter} {doc.fullNumber}
                      </Link>
                    </td>

                    <td data-label="Proveedor" className="px-3 py-1">
                      <span className={cn(voided && 'text-text-faint line-through')}>{doc.supplierName}</span>
                      {voided && (
                        <span className="ml-2 bg-panel-head px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                          Anulado
                        </span>
                      )}
                    </td>

                    <td data-label="Tipo" className="px-3 py-1">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                        {PURCHASE_DOC_TYPE_SHORT[doc.docType]}
                      </span>
                      <span className="ml-1.5 text-[10px] text-text-faint">
                        {PURCHASE_KIND_LABELS[doc.kind]}
                      </span>
                    </td>

                    <td data-label="Fecha" className="px-3 py-1 text-text-soft">
                      {formatDate(doc.issueDate)}
                    </td>

                    <td data-label="Vencimiento" className="px-3 py-1">
                      {credit ? (
                        <span className="text-text-faint">—</span>
                      ) : (
                        <>
                          <span className={cn(overdue ? 'font-semibold text-danger' : 'text-text-soft')}>
                            {formatDate(doc.dueDate)}
                          </span>
                          {overdue && (
                            <AlertTriangle size={11} className="ml-1 inline text-danger" />
                          )}
                        </>
                      )}
                    </td>

                    <td data-label="Total" className="px-3 py-1 text-right">
                      {signOf(doc.docType) < 0 ? '−' : ''}$ {formatMoney(doc.totalAmount)}
                    </td>

                    <td data-label="Saldo" className="px-3 py-1 text-right font-semibold">
                      {voided ? (
                        <span className="text-text-faint">—</span>
                      ) : (
                        `$ ${formatMoney(balanceOf(doc))}`
                      )}
                    </td>

                    <td className="px-3 py-1 text-center">
                      <Link
                        to={`/compra/${doc.id}`}
                        aria-label={`Ver comprobante ${doc.fullNumber}`}
                        className="inline-flex text-text-soft transition-colors hover:text-accent-deep"
                      >
                        <Eye size={16} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Panel>

      <p className="text-xs text-text-soft">
        Los pagos todavía no se registran: el saldo de cada comprobante es su
        total. Eso lo resuelve el módulo de pagos. Las compras de artículos, que
        mueven stock, llegan en la etapa siguiente.
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
