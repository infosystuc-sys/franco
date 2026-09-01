import React from 'react';
import { ArrowRightLeft, Search, XCircle, CheckCircle2 } from 'lucide-react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import {
  describeCheckError,
  endorseCheck,
  fetchChecks,
  type ThirdPartyCheck,
} from '@/src/lib/checks';

/**
 * Endosar un cheque de la cartera a un proveedor: reemplaza el prompt del
 * listado de Cheques por una pantalla propia, accesible desde Tesorería. La
 * lógica es la misma de siempre (endorseCheck / endorse_check) — acá solo se
 * elige de qué cheque se trata y a quién, ya que el comprobante de egreso lo
 * arma la base sola.
 */
export function EndorseCheck() {
  const { role } = useAuth();
  const [searchParams] = useSearchParams();
  const preselectId = searchParams.get('check');

  const [checks, setChecks] = React.useState<ThirdPartyCheck[]>([]);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [target, setTarget] = React.useState<ThirdPartyCheck | null>(null);
  const [notice, setNotice] = React.useState<{ check: string; supplier: string; movement: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, s] = await Promise.all([fetchChecks(), fetchSuppliers(true)]);
      setChecks(c.filter((check) => check.status === 'EN_CARTERA'));
      setSuppliers(s);
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  // Si se llega desde el listado de Cheques con un cheque puntual en mente,
  // el formulario se abre solo apenas la cartera termina de cargar.
  React.useEffect(() => {
    if (!preselectId || loading) return;
    const check = checks.find((c) => c.id === preselectId);
    if (check) setTarget(check);
  }, [preselectId, loading, checks]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return checks;
    return checks.filter((check) =>
      [check.number, check.bankName, check.drawer]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term))
    );
  }, [checks, search]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleConfirm(check: ThirdPartyCheck, supplierId: string, date: string) {
    const supplier = suppliers.find((s) => s.id === supplierId);
    const movement = await endorseCheck(check.id, supplierId, date);
    setTarget(null);
    setNotice({ check: check.number, supplier: supplier?.name ?? '—', movement });
    await load();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Endosar cheque"
        subtitle="Elegí un cheque de la cartera y a qué proveedor se lo entregás. Genera el comprobante de egreso en Tesorería."
        actions={
          <Link to="/tesoreria">
            <Button variant="ghost" type="button">
              <XCircle size={16} /> Volver a Tesorería
            </Button>
          </Link>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-state-done/40 bg-panel-alt px-4 py-3 text-sm text-state-done">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>
            Cheque {notice.check} endosado a {notice.supplier}. Comprobante{' '}
            <Link to="/tesoreria" className="font-semibold underline">{notice.movement}</Link> generado en Tesorería.
          </span>
        </div>
      )}

      <div className="relative w-full sm:w-72">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Número, banco o librador…"
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <Panel className="overflow-x-auto overflow-y-hidden">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1 w-32">Número</th>
              <th className="px-3 py-1">Banco / Librador</th>
              <th className="px-3 py-1 w-28">Cobro</th>
              <th className="px-3 py-1 w-32 text-right">Importe</th>
              <th className="px-3 py-1 w-32" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-text-soft">Cargando cartera…</td></tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-text-soft">
                  {checks.length === 0
                    ? 'No hay cheques en cartera para endosar.'
                    : 'Ningún cheque coincide con el filtro.'}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((check) => (
                <tr key={check.id} className="h-12 border-b border-line last:border-b-0 hover:bg-panel-alt">
                  <td data-primary className="px-4 py-1 font-mono font-semibold text-text">
                    {check.number}
                  </td>
                  <td data-label="Banco" className="px-3 py-1">
                    <span className="block">{check.bankName}</span>
                    {check.drawer && (
                      <span className="block text-[11px] text-text-faint">{check.drawer}</span>
                    )}
                  </td>
                  <td data-label="Cobro" className="px-3 py-1 text-text-soft">{formatDate(check.dueDate)}</td>
                  <td data-label="Importe" className="px-3 py-1 text-right font-semibold">
                    $ {formatMoney(check.amount)}
                  </td>
                  <td className="px-3 py-1 text-right">
                    <Button variant="ghost" type="button" onClick={() => setTarget(check)}>
                      <ArrowRightLeft size={14} /> Endosar
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>

      {target && (
        <EndorseModal
          check={target}
          suppliers={suppliers}
          onConfirm={handleConfirm}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}

function EndorseModal({
  check,
  suppliers,
  onConfirm,
  onClose,
}: {
  check: ThirdPartyCheck;
  suppliers: Supplier[];
  onConfirm: (check: ThirdPartyCheck, supplierId: string, date: string) => Promise<void>;
  onClose: () => void;
}) {
  const [supplierId, setSupplierId] = React.useState('');
  const [date, setDate] = React.useState(todayLocal());
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSend() {
    if (!supplierId) return;
    setSending(true);
    setError(null);
    try {
      await onConfirm(check, supplierId, date);
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Panel className="w-full max-w-sm p-5">
        <h3 className="text-sm font-bold uppercase tracking-wider text-text">Endosar cheque</h3>
        <p className="mt-1 text-xs text-text-soft">
          {check.number} — {check.bankName} · $ {formatMoney(check.amount)}
        </p>

        <label className="mt-4 block text-xs font-bold uppercase tracking-wider text-text-soft">
          Proveedor
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className={cn(
              'mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none',
              supplierId === '' && 'field-required'
            )}
            autoFocus
          >
            <option value="">— elegir —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="mt-3 block text-xs font-bold uppercase tracking-wider text-text-soft">
          Fecha
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
          />
        </label>

        {error && <p className="mt-3 text-xs text-danger">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={sending}>
            Cancelar
          </Button>
          <Button type="button" onClick={handleSend} disabled={sending || !supplierId}>
            {sending ? 'Endosando…' : 'Endosar'}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
