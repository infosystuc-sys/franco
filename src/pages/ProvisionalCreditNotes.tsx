import React from 'react';
import { Link2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describePaymentOrderError,
  fetchOpenPurchaseDocs,
  fetchProvisionalCreditNotesPendingFormalization,
  matchProvisionalCreditNote,
  type OpenPurchaseDoc,
  type ProvisionalCreditNote,
} from '@/src/lib/paymentOrders';

/**
 * NC provisorias ya usadas para cerrar una orden de pago, esperando que
 * llegue la nota de crédito formal del proveedor. Cuando llega, se vincula
 * acá: la formal queda pre-aplicada del todo (el descuento ya se usó, vía la
 * provisoria) y la provisoria pasa a formalizada.
 */
export function ProvisionalCreditNotes() {
  const { role } = useAuth();
  const [rows, setRows] = React.useState<ProvisionalCreditNote[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [linkingId, setLinkingId] = React.useState<string | null>(null);
  const [candidates, setCandidates] = React.useState<OpenPurchaseDoc[]>([]);
  const [loadingCandidates, setLoadingCandidates] = React.useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = React.useState('');
  const [matching, setMatching] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchProvisionalCreditNotesPendingFormalization());
    } catch (err) {
      setError(describePaymentOrderError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleOpenLink(row: ProvisionalCreditNote) {
    setLinkingId(row.id);
    setSelectedInvoiceId('');
    setError(null);
    setLoadingCandidates(true);
    try {
      const docs = await fetchOpenPurchaseDocs(row.supplierId);
      setCandidates(docs.filter((d) => d.docType === 'NOTA_CREDITO' && d.settledAmount === 0));
    } catch (err) {
      setError(describePaymentOrderError(getErrorMessage(err)));
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function handleConfirmLink(provisionalId: string) {
    if (!selectedInvoiceId) return;
    setMatching(true);
    setError(null);
    try {
      await matchProvisionalCreditNote(provisionalId, selectedInvoiceId);
      setLinkingId(null);
      setRows((current) => current.filter((r) => r.id !== provisionalId));
    } catch (err) {
      setError(describePaymentOrderError(getErrorMessage(err)));
    } finally {
      setMatching(false);
    }
  }

  const groups = React.useMemo(() => {
    const map = new Map<string, { supplierId: string; supplierName: string; rows: ProvisionalCreditNote[] }>();
    for (const row of rows) {
      const g = map.get(row.supplierId) ?? { supplierId: row.supplierId, supplierName: row.supplierName, rows: [] };
      g.rows.push(row);
      map.set(row.supplierId, g);
    }
    return [...map.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName));
  }, [rows]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="NC provisorias"
        subtitle="Descuentos de pronto pago que ya cerraron una orden, esperando la nota de crédito formal del proveedor."
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading && <p className="text-center text-text-soft">Cargando…</p>}

      {!loading && rows.length === 0 && (
        <Panel className="p-8 text-center text-sm text-text-soft">
          No hay NC provisorias esperando formalización.
        </Panel>
      )}

      {!loading && rows.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => (
            <Panel key={group.supplierId} className="p-5">
              <SectionHeader title={group.supplierName} />
              <ul className="space-y-2">
                {group.rows.map((row) => (
                  <li key={row.id} className="border border-line bg-panel-alt px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-text-soft">{row.fullNumber}</span>
                      <span className="text-sm text-text">{row.description}</span>
                      <span className="ml-auto font-mono text-sm font-semibold text-text">
                        $ {formatMoney(row.amount)}
                      </span>
                      {linkingId !== row.id && (
                        <Button type="button" variant="secondary" onClick={() => handleOpenLink(row)} className="px-2 py-1 text-xs">
                          <Link2 size={13} /> Vincular con NC real
                        </Button>
                      )}
                    </div>

                    {linkingId === row.id && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2">
                        {loadingCandidates && <p className="text-xs text-text-soft">Buscando notas de crédito…</p>}
                        {!loadingCandidates && candidates.length === 0 && (
                          <p className="text-xs text-text-soft">
                            {group.supplierName} no tiene notas de crédito sin aplicar todavía. Cargala primero en Compras.
                          </p>
                        )}
                        {!loadingCandidates && candidates.length > 0 && (
                          <>
                            <select
                              value={selectedInvoiceId}
                              onChange={(e) => setSelectedInvoiceId(e.target.value)}
                              className={cn(inputClass, 'mt-0 flex-1')}
                            >
                              <option value="">Elegí la NC real</option>
                              {candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.letter} {c.fullNumber} — {formatDate(c.issueDate)} — $ {formatMoney(c.totalAmount)}
                                </option>
                              ))}
                            </select>
                            <Button
                              type="button"
                              onClick={() => handleConfirmLink(row.id)}
                              disabled={!selectedInvoiceId || matching}
                              className="px-3 text-xs"
                            >
                              {matching ? 'Vinculando…' : 'Confirmar'}
                            </Button>
                          </>
                        )}
                        <Button type="button" variant="ghost" onClick={() => setLinkingId(null)} className="px-3 text-xs">
                          Cancelar
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
