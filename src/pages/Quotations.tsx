import React from 'react';
import { Search, Eye, Copy, Trash2, AlertTriangle, ArrowRight } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { vehicleLabel } from '@/src/lib/vehicles';
import {
  deleteQuotation,
  describeQuotationError,
  duplicateQuotation,
  fetchQuotations,
  isExpired,
  QUOTATION_STATUS_BADGE,
  QUOTATION_STATUS_LABELS,
  QUOTATION_STATUS_SEQUENCE,
  type QuotationListRow,
  type QuotationStatus,
} from '@/src/lib/quotations';

export function Quotations() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const navigate = useNavigate();

  const [quotations, setQuotations] = React.useState<QuotationListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<QuotationStatus | ''>('');

  const loadQuotations = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setQuotations(await fetchQuotations());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadQuotations();
  }, [loadQuotations]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return quotations.filter((q) => {
      if (statusFilter && q.status !== statusFilter) return false;
      if (!term) return true;
      return [q.number, q.customerName, q.vehicleLabel, q.component]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });
  }, [quotations, search, statusFilter]);

  const counts = React.useMemo(() => {
    const base = { EMITIDA: 0, ENVIADA: 0, ACEPTADA: 0, RECHAZADA: 0 } as Record<QuotationStatus, number>;
    quotations.forEach((q) => { base[q.status] += 1; });
    return base;
  }, [quotations]);

  async function handleDuplicate(quotation: QuotationListRow) {
    setError(null);
    try {
      const created = await duplicateQuotation(quotation.id);
      navigate(`/cotizacion/${created.number}`);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDelete(quotation: QuotationListRow) {
    if (!window.confirm(`¿Eliminar la cotización ${quotation.number}?`)) return;
    setError(null);
    try {
      await deleteQuotation(quotation.id);
      loadQuotations();
    } catch (err) {
      setError(describeQuotationError(getErrorMessage(err)));
    }
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Cotizaciones"
        subtitle="Las cotizaciones nacen en la orden de trabajo. Acá se controla en qué quedó cada autorización."
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {QUOTATION_STATUS_SEQUENCE.map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(statusFilter === status ? '' : status)}
            className={cn(
              "bg-panel border p-4 flex flex-col justify-between text-left transition-colors",
              statusFilter === status ? "border-accent-deep ring-1 ring-accent-deep" : "border-line hover:border-line-strong"
            )}
          >
            <span className="text-[12px] text-text-soft">{QUOTATION_STATUS_LABELS[status]}</span>
            <span className="text-[28px] font-bold text-text leading-tight">
              {loading ? '—' : counts[status]}
            </span>
          </button>
        ))}
      </div>

      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por número, cliente, vehículo..."
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="p-3 font-semibold w-28">N° Cotiz.</th>
                <th className="p-3 font-semibold">Cliente</th>
                <th className="p-3 font-semibold">Vehículo / Equipo</th>
                <th className="p-3 font-semibold w-32">Estado</th>
                <th className="p-3 font-semibold w-28">Validez</th>
                <th className="p-3 font-semibold w-28 text-right">Total</th>
                <th className="p-3 font-semibold w-28">OT</th>
                <th className="p-3 font-semibold w-28 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="p-6 text-center text-text-soft">Cargando...</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-text-soft">
                    {search || statusFilter
                      ? 'Ninguna cotización coincide con el filtro.'
                      : 'No hay cotizaciones cargadas.'}
                  </td>
                </tr>
              )}
              {filtered.map((quotation) => {
                const expired = isExpired(quotation.validUntil, quotation.status);
                return (
                  <tr key={quotation.id} className="border-b border-line hover:bg-panel-alt transition-colors">
                    <td data-primary className="p-3 font-semibold">
                      <Link to={`/cotizacion/${quotation.number}`} className="hover:text-accent-deep hover:underline">
                        {quotation.number}
                      </Link>
                    </td>
                    <td data-label="Cliente" className="p-3">{quotation.customerName}</td>
                    <td data-label="Vehículo" className="p-3">
                      <div>{quotation.vehicleLabel}</div>
                      {quotation.component && (
                        <div className="text-[11px] text-text-soft">{quotation.component}</div>
                      )}
                    </td>
                    <td data-label="Estado" className="p-3">
                      <span className={cn(
                        "px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        QUOTATION_STATUS_BADGE[quotation.status]
                      )}>
                        {QUOTATION_STATUS_LABELS[quotation.status]}
                      </span>
                    </td>
                    <td data-label="Validez" className="p-3 text-[11px]">
                      {quotation.validUntil ? (
                        <span className={cn(expired && "text-state-wait font-bold inline-flex items-center gap-1")}>
                          {expired && <AlertTriangle size={12} />}
                          {new Date(`${quotation.validUntil}T00:00:00`).toLocaleDateString('es-AR')}
                        </span>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>
                    <td data-label="Total" className="p-3 text-right font-bold">$ {quotation.total.toFixed(2)}</td>
                    <td data-label="OT" className="p-3">
                      {quotation.workOrderNumber ? (
                        <Link
                          to={`/orden/${quotation.workOrderNumber}`}
                          className="text-accent-deep font-bold hover:underline inline-flex items-center gap-1"
                        >
                          {quotation.workOrderNumber} <ArrowRight size={12} />
                        </Link>
                      ) : (
                        <span className="text-text-faint">—</span>
                      )}
                    </td>
                    <td className="p-3 text-right space-x-1">
                      <Link to={`/cotizacion/${quotation.number}`} title="Ver detalle" className="text-text-soft hover:text-text p-1 inline-block">
                        <Eye size={16} />
                      </Link>
                      {isAdmin && (
                        <>
                          <button onClick={() => handleDuplicate(quotation)} title="Duplicar" className="text-text-soft hover:text-text p-1">
                            <Copy size={16} />
                          </button>
                          <button
                            onClick={() => handleDelete(quotation)}
                            disabled={!!quotation.workOrderNumber}
                            title={
                              quotation.workOrderNumber
                                ? `No se puede eliminar: está enganchada a la orden ${quotation.workOrderNumber}`
                                : 'Eliminar'
                            }
                            className={cn(
                              'p-1',
                              quotation.workOrderNumber
                                ? 'text-text-faint cursor-not-allowed'
                                : 'text-text-soft hover:text-danger'
                            )}
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
