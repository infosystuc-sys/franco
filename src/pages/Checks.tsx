import React from 'react';
import { Plus, Search, X, AlertTriangle, Landmark, Send, Check, Ban } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchExpenseConcepts, type ExpenseConcept } from '@/src/lib/expenseConcepts';
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
  EMPTY_CHECK_FORM,
  endorseCheck,
  fetchChecks,
  isInWallet,
  receiveCheck,
  rejectCheck,
  type CheckInput,
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
  const [concepts, setConcepts] = React.useState<ExpenseConcept[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<CheckStatus | ''>('');
  const [receiving, setReceiving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, m, s, ec] = await Promise.all([
        fetchChecks(),
        fetchPaymentMethods(true),
        fetchSuppliers(true),
        fetchExpenseConcepts(true),
      ]);
      setChecks(c);
      setBanks(m.filter((method) => method.kind === 'BANCO'));
      setSuppliers(s);
      setConcepts(ec);
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
          <Button onClick={() => setReceiving(true)}>
            <Plus size={16} /> Recibir cheque
          </Button>
        }
      />

      {error && (
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
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
            'border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
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
              'border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
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
            className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>
      </div>

      <Panel className="overflow-x-auto">
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
                          'px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]',
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

      {receiving && (
        <ReceiveCheckModal
          concepts={concepts}
          onClose={() => setReceiving(false)}
          onSaved={() => {
            setReceiving(false);
            load();
          }}
        />
      )}
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

function ReceiveCheckModal({
  concepts,
  onClose,
  onSaved,
}: {
  concepts: ExpenseConcept[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<CheckInput>({
    ...EMPTY_CHECK_FORM,
    receivedDate: todayLocal(),
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<CheckInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  const amountNumber = Number(form.amount);
  const amountInvalid =
    form.amount.trim() === '' || !Number.isFinite(amountNumber) || amountNumber <= 0;

  const canSave =
    form.number.trim() !== '' &&
    form.bankName.trim() !== '' &&
    form.dueDate !== '' &&
    !amountInvalid &&
    !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await receiveCheck(form);
      onSaved();
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-text">Recibir cheque</h2>
            <p className="mt-0.5 text-[11px] text-text-soft">
              Entra a la cartera y queda registrado como ingreso en el libro de caja.
            </p>
          </div>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Número *
              <input
                value={form.number}
                onChange={(e) => patch({ number: e.target.value })}
                placeholder="00123456"
                className={cn(inputClass, 'font-mono', form.number.trim() === '' && 'field-required')}
              />
            </label>

            <label className={labelClass}>
              Banco *
              <input
                value={form.bankName}
                onChange={(e) => patch({ bankName: e.target.value })}
                placeholder="Banco Galicia"
                className={cn(inputClass, form.bankName.trim() === '' && 'field-required')}
              />
            </label>

            <label className={cn(labelClass, 'sm:col-span-2')}>
              Librador
              <input
                value={form.drawer}
                onChange={(e) => patch({ drawer: e.target.value })}
                placeholder="Transportes G&M"
                className={inputClass}
              />
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Quién firmó el cheque. No siempre es quien te lo entregó.
              </span>
            </label>

            <label className={labelClass}>
              Importe *
              <input
                type="number" step="0.01" min="0"
                value={form.amount}
                onChange={(e) => patch({ amount: e.target.value })}
                className={cn(inputClass, 'font-mono', amountInvalid && 'field-required')}
              />
            </label>

            <label className={labelClass}>
              Fecha de cobro *
              <input
                type="date"
                value={form.dueDate}
                onChange={(e) => patch({ dueDate: e.target.value })}
                className={cn(inputClass, form.dueDate === '' && 'field-required')}
              />
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Un cheque diferido no se puede depositar antes.
              </span>
            </label>

            <label className={labelClass}>
              Fecha de emisión
              <input
                type="date"
                value={form.issueDate}
                onChange={(e) => patch({ issueDate: e.target.value })}
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Recibido el
              <input
                type="date"
                value={form.receivedDate}
                onChange={(e) => patch({ receivedDate: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>

          <label className={labelClass}>
            Concepto
            <select
              value={form.conceptId}
              onChange={(e) => patch({ conceptId: e.target.value })}
              className={cn(inputClass, 'bg-panel')}
            >
              <option value="">— sin concepto —</option>
              {concepts.map((concept) => (
                <option key={concept.id} value={concept.id}>{concept.name}</option>
              ))}
            </select>
          </label>

          <label className={labelClass}>
            Observaciones
            <textarea
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              rows={2}
              className={cn(inputClass, 'resize-y')}
            />
          </label>

          {form.dueDate !== '' && form.dueDate < todayLocal() && (
            <p className="flex items-start gap-1.5 text-xs text-accent-deep">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              La fecha de cobro ya pasó. Se puede cargar igual, pero revisá que sea la correcta.
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? 'Guardando…' : 'Recibir'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
