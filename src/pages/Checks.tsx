import React from 'react';
import { ordenarFilas, type Orden } from '@/src/lib/ordenar';
import { ThOrdenable } from '@/src/components/ThOrdenable';
import { Plus, Search, AlertTriangle, Landmark, ArrowRightLeft, Check, Ban, Pencil, Trash2 } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal, coincideBusqueda } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { inputClass, labelClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchPaymentMethods, type PaymentMethod } from '@/src/lib/paymentMethods';
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
  eliminarCheque,
  fetchChecks,
  modificarCheque,
  isInWallet,
  rejectCheck,
  type CheckStatus,
  type ThirdPartyCheck,
  tipoDeCheque,
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
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<CheckStatus | ''>('');
  const [tipoFilter, setTipoFilter] = React.useState<'' | 'fisico' | 'electronico'>('');
  const [editando, setEditando] = React.useState<ThirdPartyCheck | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, m] = await Promise.all([
        fetchChecks(),
        fetchPaymentMethods(true),
      ]);
      setChecks(c);
      setBanks(m.filter((method) => method.kind === 'BANCO'));
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
      if (tipoFilter && check.electronico !== (tipoFilter === 'electronico')) return false;
      if (!term) return true;
      return coincideBusqueda(term, [check.number, check.bankName, check.drawer]);
    });
  }, [checks, search, statusFilter, tipoFilter]);

  // Orden por columna: click en el título ordena, otro invierte, otro vuelve
  // al orden original.
  const [orden, setOrden] = React.useState<Orden | null>(null);
  const ordenados = React.useMemo(
    () =>
      ordenarFilas(filtered, orden, (c, columna) => {
        switch (columna) {
      case 'Número': return c.number;
      case 'Tipo': return c.electronico ? 'eCheq' : 'Cheque';
      case 'Banco / Librador': return c.bankName;
      case 'Cobro': return c.dueDate;
      case 'Importe': return c.amount;
      case 'Estado': return c.status;
          default: return null;
        }
      }),
    [filtered, orden]
  );

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

  function handleEliminar(check: ThirdPartyCheck) {
    const ok = window.confirm(
      `¿Eliminar el cheque ${check.number} de ${check.bankName} por $ ${formatMoney(check.amount)}?\n\n` +
        'Se anula el ingreso a la cartera que generó y el cheque desaparece del listado. ' +
        'Si entró con una cobranza, hay que anular esa cobranza.'
    );
    if (!ok) return;
    run(() => eliminarCheque(check.id));
  }

  return (
    <div className="w-full space-y-6">
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
            'rounded border px-3 py-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] transition-colors',
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
              'rounded border px-3 py-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] transition-colors',
              statusFilter === status
                ? 'border-accent bg-accent text-accent-ink'
                : 'border-line-strong bg-panel text-text-soft hover:bg-panel-alt'
            )}
          >
            {CHECK_STATUS_LABELS[status]}
          </button>
        ))}

        <select
          value={tipoFilter}
          onChange={(e) => setTipoFilter(e.target.value as '' | 'fisico' | 'electronico')}
          aria-label="Tipo de cheque"
          className="h-9 rounded-md border border-line bg-panel px-2 text-sm focus:border-accent-deep focus:outline-none"
        >
          <option value="">Físicos y electrónicos</option>
          <option value="fisico">Solo físicos</option>
          <option value="electronico">Solo electrónicos (eCheq)</option>
        </select>
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
        <table className="table-stack w-full text-left text-[15px]">
          <thead className="h-9 bg-panel-head text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <ThOrdenable columna="Número" orden={orden} onOrden={setOrden} className="px-4 py-1 w-32">Número</ThOrdenable>
              <ThOrdenable columna="Tipo" orden={orden} onOrden={setOrden} className="px-3 py-1 w-28">Tipo</ThOrdenable>
              <ThOrdenable columna="Banco / Librador" orden={orden} onOrden={setOrden} className="px-3 py-1">Banco / Librador</ThOrdenable>
              <ThOrdenable columna="Cobro" orden={orden} onOrden={setOrden} className="px-3 py-1 w-28">Cobro</ThOrdenable>
              <ThOrdenable columna="Importe" orden={orden} onOrden={setOrden} className="px-3 py-1 w-32 text-right">Importe</ThOrdenable>
              <ThOrdenable columna="Estado" orden={orden} onOrden={setOrden} className="px-3 py-1 w-32">Estado</ThOrdenable>
              <th className="px-3 py-1 w-52">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-text-soft">Cargando cheques…</td></tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-text-soft">
                  {checks.length === 0
                    ? 'Todavía no hay cheques cargados.'
                    : 'Ningún cheque coincide con el filtro.'}
                </td>
              </tr>
            )}

            {!loading &&
              ordenados.map((check) => {
                const overdue = check.status === 'EN_CARTERA' && check.dueDate <= todayLocal();
                return (
                  <tr key={check.id} className="relative h-12 border-b border-line last:border-b-0 hover:bg-panel-alt">
                    <td data-primary className="relative px-4 py-1">
                      <StateStrip color={CHECK_STATUS_STRIP[check.status]} />
                      <span className="font-mono font-semibold text-text">{check.number}</span>
                    </td>

                    <td data-label="Tipo" className="px-3 py-1">
                      <span
                        className={cn(
                          'rounded-sm px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.04em]',
                          check.electronico ? 'bg-[#2b6cb0]/15 text-[#2b6cb0]' : 'bg-panel-head text-text-soft'
                        )}
                      >
                        {tipoDeCheque(check.electronico)}
                      </span>
                    </td>

                    <td data-label="Banco" className="px-3 py-1">
                      <span className="block">{check.bankName}</span>
                      {check.drawer && (
                        <span className="block text-[13px] text-text-faint">{check.drawer}</span>
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
                          'rounded px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-[0.06em]',
                          CHECK_STATUS_BADGE[check.status]
                        )}
                      >
                        {CHECK_STATUS_LABELS[check.status]}
                      </span>
                      {check.status === 'DEPOSITADO' && check.depositedToName && (
                        <span className="block text-[12px] text-text-faint">en {check.depositedToName}</span>
                      )}
                      {check.status === 'ENDOSADO' && (check.endorsedToSupplierName || check.endorsedToCustomerName) && (
                        <span className="block text-[12px] text-text-faint">
                          a {check.endorsedToSupplierName ?? check.endorsedToCustomerName}
                          {check.endorsedToCustomerName && ' (vuelto)'}
                        </span>
                      )}
                      {check.status === 'RECHAZADO' && check.rejectedReason && (
                        <span className="block text-[12px] text-danger">{check.rejectedReason}</span>
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
                          <Link to={`/tesoreria/endosar-cheque?check=${check.id}`}>
                            <ActionButton disabled={busy} icon={ArrowRightLeft}>
                              Endosar
                            </ActionButton>
                          </Link>
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
                        <ActionButton onClick={() => setEditando(check)} disabled={busy} icon={Pencil}>
                          Modificar
                        </ActionButton>
                        {check.status === 'EN_CARTERA' && (
                          <ActionButton onClick={() => handleEliminar(check)} disabled={busy} icon={Trash2} danger>
                            Eliminar
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

      {editando && (
        <ModificarChequeModal
          check={editando}
          onClose={() => setEditando(null)}
          onSaved={() => {
            setEditando(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Corregir un cheque mal cargado. Los datos del papel se corrigen siempre; el
 * importe, mientras siga en cartera (la base rehace su ingreso de caja). Si
 * entró con una cobranza, el importe se corrige anulando la cobranza.
 */
function ModificarChequeModal({
  check,
  onClose,
  onSaved,
}: {
  check: ThirdPartyCheck;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState({
    electronico: check.electronico,
    number: check.number,
    bankName: check.bankName,
    drawer: check.drawer ?? '',
    issueDate: check.issueDate ?? '',
    dueDate: check.dueDate,
    amount: String(check.amount),
    notes: check.notes ?? '',
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const importeEditable = check.status === 'EN_CARTERA';
  const patch = (cambios: Partial<typeof form>) => setForm((f) => ({ ...f, ...cambios }));

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(form.amount.replace(',', '.'));
    if (!form.number.trim() || !form.bankName.trim() || !form.dueDate) {
      setError('Número, banco y fecha de cobro son obligatorios.');
      return;
    }
    if (!(amount > 0)) {
      setError('El importe tiene que ser mayor a cero.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await modificarCheque(check.id, { ...form, amount });
      onSaved();
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Panel className="max-h-[90vh] w-full max-w-xl overflow-y-auto p-5">
        <form onSubmit={guardar} className="space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-text">Modificar cheque {check.number}</h3>
          {error && <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

          <div className="flex gap-4 text-sm text-text">
            <label className="flex items-center gap-2">
              <input type="radio" checked={!form.electronico} onChange={() => patch({ electronico: false })} className="accent-accent-deep" />
              Físico
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={form.electronico} onChange={() => patch({ electronico: true })} className="accent-accent-deep" />
              Electrónico (eCheq)
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Número
              <input value={form.number} onChange={(e) => patch({ number: e.target.value })} className={inputClass} />
            </label>
            <label className={labelClass}>
              Banco
              <input value={form.bankName} onChange={(e) => patch({ bankName: e.target.value })} className={inputClass} />
            </label>
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Librador
              <input value={form.drawer} onChange={(e) => patch({ drawer: e.target.value })} className={inputClass} />
            </label>
            <label className={labelClass}>
              Fecha de emisión
              <input type="date" value={form.issueDate} onChange={(e) => patch({ issueDate: e.target.value })} className={inputClass} />
            </label>
            <label className={labelClass}>
              Fecha de cobro
              <input type="date" value={form.dueDate} onChange={(e) => patch({ dueDate: e.target.value })} className={inputClass} />
            </label>
            <label className={labelClass}>
              Importe
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.amount}
                onChange={(e) => patch({ amount: e.target.value })}
                disabled={!importeEditable}
                className={cn(inputClass, 'text-right disabled:opacity-60')}
              />
            </label>
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Observaciones
              <input value={form.notes} onChange={(e) => patch({ notes: e.target.value })} className={inputClass} />
            </label>
          </div>

          <p className="text-[12px] text-text-soft">
            {importeEditable
              ? 'Si cambiás el importe se anula el ingreso a la cartera y se registra otro con el importe correcto. ' +
                'Si el cheque entró con una cobranza, el importe se corrige anulando esa cobranza.'
              : 'El cheque ya no está en cartera: se pueden corregir sus datos, pero no el importe.'}
          </p>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </Panel>
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
  onClick?: () => void;
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
        'inline-flex items-center gap-1 border px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.06em] transition-colors disabled:opacity-40',
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
      <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-faint">
        {label}
      </span>
      <span className={cn('block font-display text-2xl font-medium', danger ? 'text-danger' : 'text-text')}>
        {value}
      </span>
      {hint && <span className="mt-0.5 block text-[12px] text-text-faint">{hint}</span>}
    </Panel>
  );
}
