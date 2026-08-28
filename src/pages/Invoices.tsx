import React from 'react';
import { Plus, Search, Eye, AlertTriangle, Receipt, ArrowRight } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { getErrorMessage, STATUS_STRIP } from '@/src/lib/workOrders';
import {
  balanceOf,
  daysUntilDue,
  describeInvoiceError,
  fetchInvoices,
  fetchPendingToInvoice,
  formatDate,
  INVOICE_STRIP,
  INVOICE_TYPE_LABELS,
  isOverdue,
  paymentStateOf,
  PAYMENT_STATE_BADGE,
  PAYMENT_STATE_LABELS,
  type InvoiceListRow,
  type PendingToInvoice,
} from '@/src/lib/invoices';

type Filter = 'TODAS' | 'IMPAGAS' | 'VENCIDAS' | 'PAGADAS' | 'ANULADAS';

const FILTER_LABELS: Record<Filter, string> = {
  TODAS: 'Todas',
  IMPAGAS: 'Por cobrar',
  VENCIDAS: 'Vencidas',
  PAGADAS: 'Pagadas',
  ANULADAS: 'Anuladas',
};

const FILTERS = Object.keys(FILTER_LABELS) as Filter[];

function matchesFilter(invoice: InvoiceListRow, filter: Filter): boolean {
  const voided = invoice.status === 'ANULADA';
  switch (filter) {
    case 'TODAS':
      return true;
    case 'ANULADAS':
      return voided;
    case 'VENCIDAS':
      return isOverdue(invoice);
    case 'PAGADAS':
      return !voided && paymentStateOf(invoice) === 'PAGADA';
    case 'IMPAGAS':
      return !voided && balanceOf(invoice) > 0;
  }
}

/** El color de la tira: lo que hay que hacer con esa factura, de un vistazo. */
function stripColor(invoice: InvoiceListRow): string {
  if (invoice.status === 'ANULADA') return INVOICE_STRIP.ANULADA;
  if (isOverdue(invoice)) return INVOICE_STRIP.VENCIDA;
  return INVOICE_STRIP[paymentStateOf(invoice)];
}

export function Invoices() {
  const { role, canViewHistory } = useAuth();
  const [invoices, setInvoices] = React.useState<InvoiceListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<Filter>('TODAS');
  const [pending, setPending] = React.useState<PendingToInvoice[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([fetchInvoices(), fetchPendingToInvoice()])
      .then(([issued, toInvoice]) => {
        if (cancelled) return;
        setInvoices(issued);
        setPending(toInvoice);
      })
      .catch((err) => !cancelled && setError(describeInvoiceError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return invoices.filter((invoice) => {
      if (!matchesFilter(invoice, filter)) return false;
      if (!term) return true;
      return [invoice.fullNumber, invoice.customerName, invoice.workOrderNumber]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });
  }, [invoices, search, filter]);

  const totals = React.useMemo(() => {
    const live = invoices.filter((invoice) => invoice.status === 'EMITIDA');
    return {
      emitidas: live.length,
      porCobrar: live.reduce((sum, invoice) => sum + balanceOf(invoice), 0),
      vencido: invoices
        .filter(isOverdue)
        .reduce((sum, invoice) => sum + balanceOf(invoice), 0),
    };
  }, [invoices]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title={canViewHistory ? 'Facturación' : ''}
        subtitle={canViewHistory ? 'Las facturas salen de una orden terminada, en cuenta corriente a 7 días.' : undefined}
        actions={
          <Link to="/facturas/nueva">
            <Button variant="secondary"><Plus size={16} /> Nueva factura</Button>
          </Link>
        }
      />

      {error && (
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {canViewHistory && (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi label="Facturas emitidas" value={String(totals.emitidas)} />
        <Kpi label="Por cobrar" value={`$ ${formatMoney(totals.porCobrar)}`} />
        <Kpi label="Vencido" value={`$ ${formatMoney(totals.vencido)}`} danger={totals.vencido > 0} />
      </div>
      )}

      <PendingToInvoiceList orders={pending} loading={loading} />

      {canViewHistory && (
      <>
      <SectionHeader title="Facturas emitidas" />

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
            placeholder="Número, cliente u orden…"
            className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>
      </div>

      <Panel className="overflow-x-auto">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1">Comprobante</th>
              <th className="px-3 py-1">Cliente</th>
              <th className="px-3 py-1 w-24">Orden</th>
              <th className="px-3 py-1 w-28">Emisión</th>
              <th className="px-3 py-1 w-32">Vencimiento</th>
              <th className="px-3 py-1 w-32 text-right">Total</th>
              <th className="px-3 py-1 w-32 text-right">Saldo</th>
              <th className="px-3 py-1 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-text-soft">Cargando facturas…</td>
              </tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-text-soft">
                  {invoices.length === 0 ? (
                    <span className="flex flex-col items-center gap-2">
                      <Receipt size={24} className="text-text-faint" />
                      Todavía no hay facturas emitidas. Salen de las órdenes de
                      arriba, con el botón <strong>Facturar</strong>.
                    </span>
                  ) : (
                    'Ninguna factura coincide con el filtro.'
                  )}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((invoice) => {
                const voided = invoice.status === 'ANULADA';
                const overdue = isOverdue(invoice);
                const balance = balanceOf(invoice);
                const days = daysUntilDue(invoice.dueDate);

                return (
                  <tr
                    key={invoice.id}
                    className="relative h-11 border-b border-line transition-colors hover:bg-panel-alt"
                  >
                    <td data-primary className="relative px-4 py-1">
                      <StateStrip color={stripColor(invoice)} />
                      <Link
                        to={`/factura/${invoice.id}`}
                        className="font-mono font-semibold text-text hover:text-accent-deep hover:underline"
                      >
                        {invoice.fullNumber}
                      </Link>
                      <span className="ml-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                        {INVOICE_TYPE_LABELS[invoice.invoiceType]}
                      </span>
                    </td>

                    <td data-label="Cliente" className="px-3 py-1">
                      <span className={cn(voided && 'text-text-faint line-through')}>
                        {invoice.customerName}
                      </span>
                      {voided ? (
                        <span className="ml-2 bg-panel-head px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                          Anulada
                        </span>
                      ) : (
                        <span
                          className={cn(
                            'ml-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]',
                            PAYMENT_STATE_BADGE[paymentStateOf(invoice)]
                          )}
                        >
                          {PAYMENT_STATE_LABELS[paymentStateOf(invoice)]}
                        </span>
                      )}
                    </td>

                    <td data-label="Orden" className="px-3 py-1 font-mono text-[12px] text-text-soft">
                      {invoice.workOrderNumber ? (
                        <Link to={`/orden/${invoice.workOrderNumber}`} className="hover:underline">
                          {invoice.workOrderNumber}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>

                    <td data-label="Emisión" className="px-3 py-1 text-text-soft">
                      {formatDate(invoice.issueDate)}
                    </td>

                    <td data-label="Vencimiento" className="px-3 py-1">
                      <span className={cn(overdue ? 'font-semibold text-danger' : 'text-text-soft')}>
                        {formatDate(invoice.dueDate)}
                      </span>
                      {overdue && (
                        <span className="ml-1.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-danger">
                          <AlertTriangle size={11} /> {Math.abs(days)} d.
                        </span>
                      )}
                    </td>

                    <td data-label="Total" className="px-3 py-1 text-right">
                      $ {formatMoney(invoice.totalAmount)}
                    </td>

                    <td data-label="Saldo" className="px-3 py-1 text-right font-semibold">
                      {voided ? <span className="text-text-faint">—</span> : `$ ${formatMoney(balance)}`}
                    </td>

                    <td className="px-3 py-1 text-center">
                      <Link
                        to={`/factura/${invoice.id}`}
                        aria-label={`Ver factura ${invoice.fullNumber}`}
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
        Los cobros todavía no se registran: el saldo de cada factura es su total.
        Eso lo resuelve el módulo de cobranzas.
      </p>
      </>
      )}
    </div>
  );
}

/**
 * Lo que hay para facturar. Va arriba de las emitidas porque es la razón por
 * la que se entra acá: el listado de facturas es consulta, esto es trabajo
 * pendiente. También es el único camino a una orden terminada, que el panel
 * no muestra por ser una cola de trabajo.
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

      <Panel className="overflow-x-auto">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
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
                    <StateStrip color={STATUS_STRIP.TERMINADO} />
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
                      <span className="block text-[11px] text-text-faint">{order.component}</span>
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

function Kpi({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <Panel className="p-4">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
        {label}
      </span>
      <span
        className={cn('block font-display text-2xl font-medium', danger ? 'text-danger' : 'text-text')}
      >
        {value}
      </span>
    </Panel>
  );
}
