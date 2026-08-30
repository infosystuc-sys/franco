import React from 'react';
import { MessageSquare, Check } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  claimPendingRetention,
  fetchPendingRetentions,
  setRetentionCertificate,
  type PendingRetention,
} from '@/src/lib/retentions';

/**
 * Retenciones de cobranzas que quedaron sin comprobante. El reclamo es
 * manual — un click, un WhatsApp — porque el momento de insistir lo decide
 * el taller, no un recordatorio automático.
 */
export function PendingRetentions() {
  const { role } = useAuth();
  const [rows, setRows] = React.useState<PendingRetention[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [claimingId, setClaimingId] = React.useState<string | null>(null);
  const [claimedIds, setClaimedIds] = React.useState<Set<string>>(new Set());
  const [resolvingId, setResolvingId] = React.useState<string | null>(null);
  const [certificateDraft, setCertificateDraft] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchPendingRetentions());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleClaim(valueId: string) {
    setClaimingId(valueId);
    setError(null);
    try {
      await claimPendingRetention(valueId);
      setClaimedIds((current) => new Set(current).add(valueId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setClaimingId(null);
    }
  }

  async function handleResolve(valueId: string) {
    const certificate = certificateDraft[valueId]?.trim();
    if (!certificate) return;
    setResolvingId(valueId);
    setError(null);
    try {
      await setRetentionCertificate(valueId, certificate);
      setRows((current) => current.filter((r) => r.valueId !== valueId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setResolvingId(null);
    }
  }

  const groups = React.useMemo(() => {
    const map = new Map<string, { customerId: string; customerName: string; rows: PendingRetention[] }>();
    for (const row of rows) {
      const g = map.get(row.customerId) ?? { customerId: row.customerId, customerName: row.customerName, rows: [] };
      g.rows.push(row);
      map.set(row.customerId, g);
    }
    return [...map.values()].sort((a, b) => a.customerName.localeCompare(b.customerName));
  }, [rows]);

  const total = React.useMemo(() => rows.reduce((sum, r) => sum + r.amount, 0), [rows]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Retenciones pendientes"
        subtitle="Cobranzas con retención sin comprobante todavía. Reclamalo por WhatsApp o cargá el número cuando llegue."
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading && <p className="text-center text-text-soft">Cargando…</p>}

      {!loading && rows.length === 0 && (
        <Panel className="p-8 text-center text-sm text-text-soft">
          No hay retenciones pendientes de comprobante.
        </Panel>
      )}

      {!loading && rows.length > 0 && (
        <>
          <p className="mb-4 text-sm text-text-soft">
            <strong className="font-mono text-text">$ {formatMoney(total)}</strong> en {rows.length}{' '}
            {rows.length === 1 ? 'retención pendiente' : 'retenciones pendientes'}, de {groups.length}{' '}
            {groups.length === 1 ? 'cliente' : 'clientes'}.
          </p>

          <div className="space-y-6">
            {groups.map((group) => (
              <Panel key={group.customerId} className="p-5">
                <SectionHeader
                  title={
                    <Link to={`/cobranzas/nueva?cliente=${group.customerId}`} className="hover:text-accent-deep">
                      {group.customerName}
                    </Link>
                  }
                  actions={
                    <span className="font-mono text-sm text-text-soft">
                      $ {formatMoney(group.rows.reduce((sum, r) => sum + r.amount, 0))}
                    </span>
                  }
                />
                <ul className="space-y-2">
                  {group.rows.map((row) => (
                    <li
                      key={row.valueId}
                      className="flex flex-wrap items-center gap-2 border border-line bg-panel-alt px-3 py-2"
                    >
                      <span className="font-mono text-xs text-text-soft">{row.receiptFullNumber}</span>
                      <span className="text-xs text-text-soft">{formatDate(row.receiptDate)}</span>
                      <span className="text-sm text-text">{row.taxRateName}</span>
                      <span className="ml-auto font-mono text-sm font-semibold text-text">
                        $ {formatMoney(row.amount)}
                      </span>

                      <input
                        value={certificateDraft[row.valueId] ?? ''}
                        onChange={(e) =>
                          setCertificateDraft((c) => ({ ...c, [row.valueId]: e.target.value }))
                        }
                        placeholder="N° certificado"
                        className={cn(inputClass, 'mt-0 w-32 py-1 text-xs font-mono')}
                      />
                      <button
                        type="button"
                        onClick={() => handleResolve(row.valueId)}
                        disabled={!certificateDraft[row.valueId]?.trim() || resolvingId === row.valueId}
                        aria-label="Cargar comprobante"
                        className="p-1 text-text-soft transition-colors hover:text-state-done disabled:opacity-40"
                        title="Cargar comprobante"
                      >
                        <Check size={16} />
                      </button>

                      <Button
                        type="button"
                        variant={claimedIds.has(row.valueId) ? 'ghost' : 'secondary'}
                        onClick={() => handleClaim(row.valueId)}
                        disabled={claimingId === row.valueId}
                        className="px-2 py-1 text-xs"
                      >
                        <MessageSquare size={13} />
                        {claimingId === row.valueId
                          ? 'Enviando…'
                          : claimedIds.has(row.valueId)
                            ? 'Reclamado'
                            : 'Reclamar'}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Panel>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
