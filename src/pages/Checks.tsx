import React from 'react';
import { Plus, Search, AlertTriangle, Landmark, Send, Check, Ban } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchPaymentMethods, type PaymentMethod } from '@/src/lib/paymentMethods';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import {
  canCredit,
  canDeposit,
  canEndorse,
  canReject,
  CHECK_STATUS_BADGE,
  CHECK_STATUS_LABELS,
  CHECK_STATUS_STRIP,
  CHECK_STATUSES,
  creditCheck,
  depositCheck,
  describeCheckError,
  endorseCheck,
  fetchChecks,
  isInWallet,
  rejectCheck,
  type CheckStatus,
  type ThirdPartyCheck,
} from '@/src/lib/checks';

/**
 * Cartera de cheques de terceros.
 *
 * Cada fila ofrece solo las acciones que su estado permite, con las mismas
 * reglas que valida la base: mostrar un botón que después va a fallar es peor
 * que no mostrarlo.
 */
export function Checks() {
  const { role } = useAuth();
  const [checks, setChecks] = React.useState<ThirdPartyCheck[]>([]);
  const [banks, setBanks] = React.useState<PaymentMethod[]>([]);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<CheckStatus | ''>('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, m, s] = await Promise.all([
        fetchChecks(),
        fetchPaymentMethods(true),
        fetchSuppliers(true),
      ]);
      setChecks(c);
      setBanks(m.filter((method) => method.kind === 'BANCO'));
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

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return checks.filter((check) => {
      if (statusFilter && check.status !== statusFilter) return false;
      if (!term) return true;
      return [check.number, check.bankName, check.drawer]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });
  }, [checks, search, statusFilter]);

  const totals = React.useMemo(() => {
    const wallet = checks.filter((c) => isInWallet(c.status));
    const today = todayLocal();
    return {
      enCartera: wallet.reduce((sum, c) => sum + c.amount, 0),
      cantidad: wallet.length,
      // Un cheque cuya fecha de cobro ya pasó y sigue en cartera es plata que
      // se está dejando sobre la mesa: se puede depositar y no se hizo.
      depositables: checks.filter((c) => c.status === 'EN_CARTERA' && c.dueDate <= today).length,
      rechazados: checks.filter((c) => c.status === 'RECHAZADO').reduce((s, c) => s + c.amount, 0),
    };
  }, [checks]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
    } finally {
      setBusy(false);
    }
  }

  function handleDeposit(check: ThirdPartyCheck) {
    if (banks.length === 0) {
      setError('No hay ninguna cuenta bancaria cargada. Creala en Medios de pago con el tipo Banco.');
      return;
    }
    const list = banks.map((b, i) => `${i + 1}. ${b.name}`).join('\n');
    const answer = window.prompt(
      `Depositar el cheque ${check.number} de ${check.bankName} por $ ${formatMoney(check.amount)}.\n\n` +
        `El depósito no mueve plata todavía: el valor sigue en cartera hasta que el banco acredite.\n\n` +
        `¿En qué cuenta?\n${list}\n\nEscribí el número:`
    );
    if (answer === null) return;
    const bank = banks[Number(answer) - 1];
    if (!bank) {
      setError('No elegiste una cuenta válida.');
      return;
    }
    run(() => depositCheck(check.id, bank.id, todayLocal()));
  }

  function handleCredit(check: ThirdPartyCheck) {
    const ok = window.confirm(
      `Acreditar el cheque ${check.number} por $ ${formatMoney(check.amount)}.\n\n` +
        `Acá sí entra la plata: sale de la cartera y entra en ${check.depositedToName ?? 'el banco'}.`
    );
    if (!ok) return;
    run(() => creditCheck(check.id, todayLocal()));
  }

  function handleReject(check: ThirdPartyCheck) {
    const reason = window.prompt(
      `Rechazar el cheque ${check.number} por $ ${formatMoney(check.amount)}.\n\n` +
        (check.status === 'ACREDITADO'
          ? 'Se revierte la acreditación: el banco baja y el valor vuelve a la cartera.\n\n'
          : 'Todavía no se había acreditado, así que no hay plata que devolver.\n\n') +
        'Indicá el motivo:'
    );
    if (reason === null) return;
    if (reason.trim() === '') {
      setError('Indicá el motivo del rechazo.');
      return;
    }
    run(() => rejectCheck(check.id, reason, todayLocal()));
  }

  function handleEndorse(check: ThirdPartyCheck) {
    if (suppliers.length === 0) {
      setError('No hay proveedores activos para endosar.');
      return;
    }
    const list = suppliers.slice(0, 30).map((s, i) => `${i + 1}. ${s.name}`).join('\n');
    const answer = window.prompt(
      `Endosar el cheque ${check.number} por $ ${formatMoney(check.amount)}.\n\n` +
        `Sale de la cartera y se entrega al proveedor.\n\n¿A quién?\n${list}\n\nEscribí el número:`
    );
    if (answer === null) return;
    const supplier = suppliers[Number(answer) - 1];
    if (!supplier) {
      setError('No elegiste un proveedor válido.');
      return;
    }
    run(() => endorseCheck(check.id, supplier.id, todayLocal()));
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Cheques de terceros"
        subtitle="Los valores recibidos, desde que entran a la cartera hasta que se acreditan o se endosan."
        actions={
          <Link to="/cheques/nuevo">
            <Button>
              <Plus size={16} /> Recibir cheque
            </Button>
          </Link>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Kpi label="En cartera" value={`$ ${formatMoney(totals.enCartera)}`} />
        <Kpi label="Cantidad" value={String(totals.cantidad)} />
        <Kpi
          label="Al cobro"
          value={String(totals.depositables)}
          hint="Ya llegó su fecha y siguen sin depositar"
          danger={totals.depositables > 0}
        />
        <Kpi label="Rechazados" value={`$ ${formatMoney(totals.rechazados)}`} danger={totals.rechazados > 0} />
      </div>

      <SectionHeader title="Cartera" />

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setStatusFilter('')}
          className={cn(
            'rounded border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
            statusFilter === ''
              ? 'border-accent bg-accent text-accent-ink'
              : 'border-line-strong bg-panel text-text-soft hover:bg-panel-alt'
          )}
        >
          Todos
        </button>
        {CHECK_STATUSES.map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={cn(
              'rounded border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
              statusFilter === status
                ? 'border-accent bg-accent text-accent-ink'
                : 'border-line-strong bg-panel text-text-soft hover:bg-panel-alt'
            )}
          >
            {CHECK_STATUS_LABELS[status]}
          </button>
        ))}

        <div className="relative ml-auto w-full sm:w-64">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Número, banco o librador…"
            className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>
      </div>

      <Panel className="overflow-x-auto overflow-y-hidden">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1 w-32">Número</th>
              <th className="px-3 py-1">Banco / Librador</th>
              <th className="px-3 py-1 w-28">Cobro</th>
              <th className="px-3 py-1 w-32 text-right">Importe</th>
              <th className="px-3 py-1 w-32">Estado</th>
              <th className="px-3 py-1 w-52">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-soft">Cargando cheques…</td></tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-text-soft">
                  {checks.length === 0
                    ? 'Todavía no hay cheques cargados.'
                    : 'Ningún cheque coincide con el filtro.'}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((check) => {
                const overdue = check.status === 'EN_CARTERA' && check.dueDate <= todayLocal();
                return (
                  <tr key={check.id} className="relative h-12 border-b border-line last:border-b-0 hover:bg-panel-alt">
                    <td data-primary className="relative px-4 py-1">
                      <StateStrip color={CHECK_STATUS_STRIP[check.status]} />
                      <span className="font-mono font-semibold text-text">{check.number}</span>
                    </td>

                    <td data-label="Banco" className="px-3 py-1">
                      <span className="block">{check.bankName}</span>
                      {check.drawer && (
                        <span className="block text-[11px] text-text-faint">{check.drawer}</span>
                      )}
                    </td>

                    <td data-label="Cobro" className="px-3 py-1">
                      <span className={cn(overdue ? 'font-semibold text-accent-deep' : 'text-text-soft')}>
                        {formatDate(check.dueDate)}
                      </span>
                    </td>

                    <td data-label="Importe" className="px-3 py-1 text-right font-semibold">
                      $ {formatMoney(check.amount)}
                    </td>

                    <td data-label="Estado" className="px-3 py-1">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]',
                          CHECK_STATUS_BADGE[check.status]
                        )}
                      >
                        {CHECK_STATUS_LABELS[check.status]}
                      </span>
                      {check.status === 'DEPOSITADO' && check.depositedToName && (
                        <span className="block text-[10px] text-text-faint">en {check.depositedToName}</span>
                      )}
                      {check.status === 'ENDOSADO' && check.endorsedToSupplierName && (
                        <span className="block text-[10px] text-text-faint">a {check.endorsedToSupplierName}</span>
                      )}
                      {check.status === 'RECHAZADO' && check.rejectedReason && (
                        <span className="block text-[10px] text-danger">{check.rejectedReason}</span>
                      )}
                    </td>

                    <td className="px-3 py-1">
                      <div className="flex flex-wrap gap-1">
                        {canDeposit(check.status) && (
                          <ActionButton onClick={() => handleDeposit(check)} disabled={busy} icon={Landmark}>
                            Depositar
                          </ActionButton>
                        )}
                        {canEndorse(check.status) && (
                          <ActionButton onClick={() => handleEndorse(check)} disabled={busy} icon={Send}>
                            Endosar
                          </ActionButton>
                        )}
                        {canCredit(check.status) && (
                          <ActionButton onClick={() => handleCredit(check)} disabled={busy} icon={Check}>
                            Acreditar
                          </ActionButton>
                        )}
                        {canReject(check.status) && (
                          <ActionButton onClick={() => handleReject(check)} disabled={busy} icon={Ban} danger>
                            Rechazar
                          </ActionButton>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Panel>

      <p className="text-xs text-text-soft">
        El depósito no mueve plata: el valor sigue contando en la cartera hasta
        que el banco acredita, que es cuando el riesgo desaparece de verdad.
      </p>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  icon: Icon,
  danger,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: React.ComponentType<{ size?: number }>;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1 border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors disabled:opacity-40',
        danger
          ? 'border-danger/40 text-danger hover:bg-danger-soft'
          : 'border-line-strong text-text-soft hover:bg-panel-alt hover:text-text'
      )}
    >
      <Icon size={12} />
      {children}
    </button>
  );
}

function Kpi({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <Panel className="p-4">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
        {label}
      </span>
      <span className={cn('block font-display text-2xl font-medium', danger ? 'text-danger' : 'text-text')}>
        {value}
      </span>
      {hint && <span className="mt-0.5 block text-[10px] text-text-faint">{hint}</span>}
    </Panel>
  );
}
