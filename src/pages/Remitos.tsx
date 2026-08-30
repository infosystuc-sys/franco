import React from 'react';
import { Plus, Search, Eye, Receipt, Ban, Package } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, StateStrip } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { formatDate } from '@/src/lib/invoices';
import { describeRemitoError, fetchRemitos, voidRemito, type RemitoListRow, type RemitoStatus } from '@/src/lib/remitos';

type Filter = 'TODOS' | 'PENDIENTES' | 'FACTURADOS' | 'ANULADOS';

const FILTER_LABELS: Record<Filter, string> = {
  TODOS: 'Todos',
  PENDIENTES: 'Pendientes de facturar',
  FACTURADOS: 'Facturados',
  ANULADOS: 'Anulados',
};

const FILTERS = Object.keys(FILTER_LABELS) as Filter[];

function isPendingRow(r: RemitoListRow): boolean {
  return r.status === 'EMITIDO' && r.invoiceId === null;
}

function matchesFilter(r: RemitoListRow, filter: Filter): boolean {
  switch (filter) {
    case 'TODOS': return true;
    case 'ANULADOS': return r.status === 'ANULADO';
    case 'FACTURADOS': return r.status === 'EMITIDO' && r.invoiceId !== null;
    case 'PENDIENTES': return isPendingRow(r);
  }
}

function stripColor(r: RemitoListRow): string {
  if (r.status === 'ANULADO') return 'var(--color-danger)';
  if (isPendingRow(r)) return 'var(--color-state-wait)';
  return 'var(--color-state-done)';
}

function statusLabel(r: RemitoListRow): string {
  if (r.status === 'ANULADO') return 'Anulado';
  if (isPendingRow(r)) return 'Pendiente';
  return 'Facturado';
}

/**
 * Remitos: los que se emitieron junto con una factura (el camino de siempre)
 * y los que se cargaron solos, entregados sin facturar todavía. Se
 * distinguen por invoice_id, no por un estado propio — "pendiente" es
 * simplemente "sin factura vinculada aún".
 */
export function Remitos() {
  const { role } = useAuth();
  const [rows, setRows] = React.useState<RemitoListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<Filter>('PENDIENTES');
  const [voidingId, setVoidingId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchRemitos());
    } catch (err) {
      setError(describeRemitoError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const counts = React.useMemo(() => {
    const base: Record<Filter, number> = { TODOS: 0, PENDIENTES: 0, FACTURADOS: 0, ANULADOS: 0 };
    for (const r of rows) {
      base.TODOS++;
      if (isPendingRow(r)) base.PENDIENTES++;
      else if (r.status === 'EMITIDO') base.FACTURADOS++;
      else base.ANULADOS++;
    }
    return base;
  }, [rows]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((r) => matchesFilter(r, filter))
      .filter((r) => !term || [r.fullNumber, r.customerName, r.invoiceFullNumber].filter(Boolean).some((v) => String(v).toLowerCase().includes(term)));
  }, [rows, filter, search]);

  async function handleVoid(r: RemitoListRow) {
    const reason = window.prompt(`¿Por qué se anula el remito ${r.fullNumber}?`);
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert('Hace falta un motivo.');
      return;
    }
    setVoidingId(r.id);
    setError(null);
    try {
      await voidRemito(r.id, reason);
      await load();
    } catch (err) {
      setError(describeRemitoError(getErrorMessage(err)));
    } finally {
      setVoidingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Remitos"
        subtitle="Entregas de mercadería, facturadas o pendientes de valorizar."
        actions={
          <Link to="/remitos/nuevo">
            <Button><Plus size={16} /> Nuevo remito</Button>
          </Link>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
              filter === f
                ? 'border-accent bg-accent/10 text-accent-deep'
                : 'border-line-strong bg-panel text-text-soft hover:bg-panel-alt'
            )}
          >
            {FILTER_LABELS[f]} ({counts[f]})
          </button>
        ))}
      </div>

      <div className="relative sm:w-72">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Número, cliente o factura…"
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="w-28 p-3 font-semibold">N° remito</th>
                <th className="p-3 font-semibold">Cliente</th>
                <th className="w-20 p-3 text-right font-semibold">Renglones</th>
                <th className="w-32 p-3 font-semibold">Estado</th>
                <th className="w-32 p-3 font-semibold">Factura</th>
                <th className="w-28 p-3 font-semibold">Fecha</th>
                <th className="w-24 p-3 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="p-8 text-center text-text-soft">Cargando…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-text-soft">
                    {rows.length === 0 ? 'No hay remitos cargados todavía.' : 'Ningún remito coincide con el filtro.'}
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr key={r.id} className="relative border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt">
                  <td data-primary className="relative py-3 pl-5 pr-3">
                    <StateStrip color={stripColor(r)} />
                    <Link to={`/remito/${r.id}`} className="font-mono font-semibold text-text hover:text-accent-deep hover:underline">
                      {r.fullNumber}
                    </Link>
                  </td>
                  <td data-label="Cliente" className="p-3">{r.customerName}</td>
                  <td data-label="Renglones" className="p-3 text-right font-mono text-text-soft">
                    <span className="inline-flex items-center gap-1"><Package size={13} /> {r.itemCount}</span>
                  </td>
                  <td data-label="Estado" className="p-3 text-text-soft">{statusLabel(r)}</td>
                  <td data-label="Factura" className="p-3">
                    {r.invoiceId ? (
                      <Link to={`/factura/${r.invoiceId}`} className="text-accent-deep hover:underline">
                        {r.invoiceFullNumber}
                      </Link>
                    ) : '—'}
                  </td>
                  <td data-label="Fecha" className="p-3 text-text-soft">{formatDate(r.issueDate)}</td>
                  <td className="p-3 text-right">
                    <Link to={`/remito/${r.id}`} title="Ver remito" className="inline-block p-1 text-text-soft transition-colors hover:text-text">
                      <Eye size={16} />
                    </Link>
                    {isPendingRow(r) && (
                      <>
                        <Link
                          to={`/facturas/nueva?remito=${r.id}`}
                          title="Facturar este remito"
                          className="ml-1 inline-block p-1 text-text-soft transition-colors hover:text-accent-deep"
                        >
                          <Receipt size={16} />
                        </Link>
                        <button
                          onClick={() => handleVoid(r)}
                          disabled={voidingId === r.id}
                          title="Anular remito"
                          className="ml-1 inline-block p-1 text-text-soft transition-colors hover:text-danger"
                        >
                          <Ban size={16} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
