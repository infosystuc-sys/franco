import React from 'react';
import { Plus, Search, Eye, Stamp } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, StateStrip } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { formatDate, INVOICE_STRIP } from '@/src/lib/invoices';
import {
  describeCreditNoteError,
  fetchCreditNotes,
  type CreditNoteListRow,
} from '@/src/lib/creditNotes';
import { emitirNcEnArca } from '@/src/lib/arcaFacturacion';

/**
 * Las notas de crédito emitidas. Igual que el listado de facturas, incluida la
 * posibilidad de reintentarle el CAE a una que ARCA rechazó sin tener que
 * abrirla.
 */
export function CreditNotes() {
  const { role } = useAuth();
  const [rows, setRows] = React.useState<CreditNoteListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [reintentando, setReintentando] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    fetchCreditNotes()
      .then(setRows)
      .catch((err) => setError(describeCreditNoteError(getErrorMessage(err))))
      .finally(() => setLoading(false));
  }, [role]);

  async function reintentarCae(nc: CreditNoteListRow) {
    const motivo = nc.caeRechazo ? `\n\nLa vez anterior ARCA dijo:\n${nc.caeRechazo}` : '';
    if (
      !window.confirm(
        `Pedirle a ARCA el CAE de la nota de crédito ${nc.fullNumber}, por ` +
          `$ ${formatMoney(nc.totalAmount)}.${motivo}\n\nSi la autoriza, queda emitida ` +
          'y no se puede deshacer.'
      )
    ) {
      return;
    }

    setReintentando(nc.id);
    setError(null);
    try {
      await emitirNcEnArca(nc.id);
      setRows(await fetchCreditNotes());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setReintentando(null);
    }
  }

  if (role !== 'admin') return <Navigate to="/" replace />;

  const term = search.trim().toLowerCase();
  const filtradas = rows.filter((r) =>
    !term ||
    [r.fullNumber, r.customerName, r.invoiceFullNumber].some((v) =>
      String(v).toLowerCase().includes(term)
    )
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notas de crédito"
        subtitle="Revierten una factura que ARCA ya autorizó."
        actions={
          <Link to="/notas-credito/nueva">
            <Button type="button"><Plus size={16} /> Nueva</Button>
          </Link>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <label className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2">
        <Search size={16} className="text-text-faint" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por número, cliente o factura…"
          className="w-full bg-transparent text-sm text-text outline-none"
        />
      </label>

      <Panel>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-text-faint">
              <th className="px-4 py-2">Número</th>
              <th className="px-3 py-2">Cliente</th>
              <th className="px-3 py-2">Revierte</th>
              <th className="px-3 py-2">Emisión</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-soft">Cargando…</td></tr>
            )}
            {!loading && filtradas.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-soft">
                Todavía no hay notas de crédito.
              </td></tr>
            )}
            {!loading && filtradas.map((nc) => {
              const pendiente = nc.status === 'PENDIENTE_CAE';
              return (
                <tr key={nc.id} className="relative h-11 border-b border-line hover:bg-panel-alt">
                  <td data-primary className="relative px-4 py-1">
                    <StateStrip color={pendiente ? INVOICE_STRIP.PENDIENTE_CAE : INVOICE_STRIP.PAGADA} />
                    <Link
                      to={`/nota-credito/${nc.id}`}
                      className="font-mono font-semibold text-text hover:text-accent-deep hover:underline"
                    >
                      {nc.fullNumber}
                    </Link>
                    <span className="ml-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                      NC {nc.invoiceType}
                    </span>
                  </td>
                  <td data-label="Cliente" className="px-3 py-1">
                    {nc.customerName}
                    {pendiente && (
                      <span className="ml-2 rounded bg-panel-head px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                        Esperando CAE
                      </span>
                    )}
                  </td>
                  <td data-label="Revierte" className="px-3 py-1 font-mono text-[13px] text-text-soft">
                    <Link to={`/factura/${nc.invoiceId}`} className="hover:underline">
                      {nc.invoiceFullNumber}
                    </Link>
                    {!nc.cancelaTotal && <span className="ml-1 text-text-faint">(parcial)</span>}
                  </td>
                  <td data-label="Emisión" className="px-3 py-1 text-text-soft">
                    {formatDate(nc.issueDate)}
                  </td>
                  <td data-label="Total" className="px-3 py-1 text-right">
                    $ {formatMoney(nc.totalAmount)}
                  </td>
                  <td className="px-3 py-1 text-center">
                    <div className="inline-flex items-center gap-2">
                      {pendiente && (
                        <button
                          type="button"
                          onClick={() => reintentarCae(nc)}
                          disabled={reintentando !== null}
                          title={nc.caeRechazo ? `ARCA la rechazó: ${nc.caeRechazo}` : 'Pedirle el CAE a ARCA.'}
                          aria-label={`Pedir el CAE de la nota de crédito ${nc.fullNumber}`}
                          className={cn(
                            'inline-flex transition-colors disabled:opacity-40',
                            nc.caeRechazo ? 'text-danger hover:text-danger/70' : 'text-text-soft hover:text-accent-deep'
                          )}
                        >
                          <Stamp size={16} className={cn(reintentando === nc.id && 'animate-pulse')} />
                        </button>
                      )}
                      <Link
                        to={`/nota-credito/${nc.id}`}
                        aria-label={`Ver la nota de crédito ${nc.fullNumber}`}
                        className="inline-flex text-text-soft transition-colors hover:text-accent-deep"
                      >
                        <Eye size={16} />
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
