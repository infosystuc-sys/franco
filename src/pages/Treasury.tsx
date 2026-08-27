import React from 'react';
import { Plus, Search, Ban, AlertTriangle, Wallet, ArrowRight } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchExpenseConcepts, type ExpenseConcept } from '@/src/lib/expenseConcepts';
import {
  PAYMENT_METHOD_KIND_LABELS,
  PAYMENT_METHOD_STRIP,
  type PaymentMethodKind,
} from '@/src/lib/paymentMethods';
import {
  buildLegs,
  describeTreasuryError,
  fetchBalances,
  fetchMovements,
  MOVEMENT_TYPE_HELP,
  MOVEMENT_TYPE_LABELS,
  MOVEMENT_TYPE_PREFIX,
  MOVEMENT_TYPE_STRIP,
  MOVEMENT_TYPES,
  saveMovement,
  voidMovement,
  type MethodBalance,
  type TreasuryMovement,
  type TreasuryMovementType,
} from '@/src/lib/treasury';

/**
 * Tesorería: el libro de caja. Arriba los saldos, abajo los movimientos.
 *
 * Los saldos van primero porque son la pregunta con la que se entra acá
 * —cuánto hay en cada caja—; el listado de movimientos es la explicación de
 * cómo se llegó a esos números.
 */
export function Treasury() {
  const { role, canViewHistory } = useAuth();
  const [balances, setBalances] = React.useState<MethodBalance[]>([]);
  const [movements, setMovements] = React.useState<TreasuryMovement[]>([]);
  const [concepts, setConcepts] = React.useState<ExpenseConcept[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState<TreasuryMovementType | ''>('');
  const [creating, setCreating] = React.useState<TreasuryMovementType | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, m, c] = await Promise.all([
        fetchBalances(),
        fetchMovements(),
        fetchExpenseConcepts(true),
      ]);
      setBalances(b);
      setMovements(m);
      setConcepts(c);
    } catch (err) {
      setError(describeTreasuryError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return movements.filter((mv) => {
      if (typeFilter && mv.movementType !== typeFilter) return false;
      if (!term) return true;
      return [mv.fullNumber, mv.description, mv.payee, mv.conceptName]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });
  }, [movements, search, typeFilter]);

  // La cartera queda fuera del total a propósito: un cheque en cartera es un
  // valor a cobrar, no plata disponible. Mezclarlos daría un número que
  // parece caja y no lo es.
  const totalCash = React.useMemo(
    () =>
      balances
        .filter((b) => b.active && b.kind !== 'CARTERA_CHEQUES')
        .reduce((sum, b) => sum + b.balance, 0),
    [balances]
  );

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleVoid(movement: TreasuryMovement) {
    const reason = window.prompt(
      `Anular ${movement.fullNumber} — ${movement.description}\n\n` +
        `Deja de contar en los saldos. El movimiento queda registrado como anulado.\n` +
        `Indicá el motivo:`
    );
    if (reason === null) return;
    if (reason.trim() === '') {
      setError('Indicá el motivo de la anulación.');
      return;
    }
    setError(null);
    try {
      await voidMovement(movement.id, reason);
      await load();
    } catch (err) {
      setError(describeTreasuryError(getErrorMessage(err)));
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Tesorería"
        subtitle="El libro de caja: gastos sin factura, ingresos y movimientos entre medios."
        actions={
          <>
            <Button variant="ghost" onClick={() => setCreating('TRANSFERENCIA')}>
              <ArrowRight size={16} /> Transferencia
            </Button>
            <Button variant="secondary" onClick={() => setCreating('INGRESO')}>
              <Plus size={16} /> Ingreso
            </Button>
            <Button onClick={() => setCreating('EGRESO')}>
              <Plus size={16} /> Gasto
            </Button>
          </>
        }
      />

      {error && (
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* ── Saldos ──────────────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Saldos" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {loading && <p className="text-text-soft">Cargando saldos…</p>}

          {!loading &&
            balances
              .filter((b) => b.active)
              .map((balance) => (
                <Panel key={balance.paymentMethodId} className="relative p-4 pl-5">
                  <StateStrip color={PAYMENT_METHOD_STRIP[balance.kind]} />
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                    {balance.name}
                  </span>
                  <span
                    className={cn(
                      'block font-display text-2xl font-medium',
                      balance.balance < 0 ? 'text-danger' : 'text-text'
                    )}
                  >
                    $ {formatMoney(balance.balance)}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-text-faint">
                    {PAYMENT_METHOD_KIND_LABELS[balance.kind as PaymentMethodKind]}
                    {balance.kind === 'CARTERA_CHEQUES' && ' · valores a cobrar'}
                  </span>
                </Panel>
              ))}
        </div>

        {!loading && (
          <p className="mt-3 text-xs text-text-soft">
            Total en cajas y bancos:{' '}
            <strong className="font-mono text-text">$ {formatMoney(totalCash)}</strong>. La cartera de
            cheques queda fuera: un cheque es un valor a cobrar, no plata disponible. Se mueve desde
            la pantalla de Cheques.
          </p>
        )}
      </section>

      {/* ── Movimientos ─────────────────────────────────────────────── */}
      {canViewHistory && (
      <>
      <SectionHeader title="Movimientos" />

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setTypeFilter('')}
          className={cn(
            'border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
            typeFilter === ''
              ? 'border-accent bg-accent text-accent-ink'
              : 'border-line-strong bg-panel text-text-soft hover:bg-panel-alt'
          )}
        >
          Todos
        </button>
        {MOVEMENT_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => setTypeFilter(type)}
            className={cn(
              'border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors',
              typeFilter === type
                ? 'border-accent bg-accent text-accent-ink'
                : 'border-line-strong bg-panel text-text-soft hover:bg-panel-alt'
            )}
          >
            {MOVEMENT_TYPE_LABELS[type]}
          </button>
        ))}

        <div className="relative ml-auto w-full sm:w-64">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Número, detalle o beneficiario…"
            className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>
      </div>

      <Panel className="overflow-x-auto">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1 w-32">Comprobante</th>
              <th className="px-3 py-1 w-28">Fecha</th>
              <th className="px-3 py-1">Detalle</th>
              <th className="px-3 py-1 w-40">Concepto</th>
              <th className="px-3 py-1 w-56">Medios</th>
              <th className="px-3 py-1 w-32 text-right">Importe</th>
              <th className="px-3 py-1 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-text-soft">Cargando movimientos…</td></tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-text-soft">
                  {movements.length === 0 ? (
                    <span className="flex flex-col items-center gap-2">
                      <Wallet size={24} className="text-text-faint" />
                      Todavía no hay movimientos.
                    </span>
                  ) : (
                    'Ningún movimiento coincide con el filtro.'
                  )}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((mv) => {
                const voided = mv.status === 'ANULADO';
                return (
                  <tr key={mv.id} className="relative h-11 border-b border-line last:border-b-0 hover:bg-panel-alt">
                    <td data-primary className="relative px-4 py-1">
                      <StateStrip color={voided ? '#9a9a9a' : MOVEMENT_TYPE_STRIP[mv.movementType]} />
                      <span className={cn('font-mono font-semibold', voided ? 'text-text-faint line-through' : 'text-text')}>
                        {mv.fullNumber}
                      </span>
                      {voided && (
                        <span className="ml-2 bg-panel-head px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                          Anulado
                        </span>
                      )}
                    </td>

                    <td data-label="Fecha" className="px-3 py-1 text-text-soft">
                      {formatDate(mv.movementDate)}
                    </td>

                    <td data-label="Detalle" className="px-3 py-1">
                      <span className={cn(voided && 'text-text-faint')}>{mv.description}</span>
                      {mv.payee && (
                        <span className="block text-[11px] text-text-faint">a {mv.payee}</span>
                      )}
                    </td>

                    <td data-label="Concepto" className="px-3 py-1 text-text-soft">
                      {mv.conceptName ?? '—'}
                    </td>

                    <td data-label="Medios" className="px-3 py-1 text-[11px] text-text-soft">
                      {mv.legs.map((leg, i) => (
                        <span key={i} className="block">
                          <span className={leg.amount < 0 ? 'text-danger' : 'text-state-done'}>
                            {leg.amount < 0 ? '−' : '+'}
                          </span>{' '}
                          {leg.paymentMethodName}
                        </span>
                      ))}
                    </td>

                    <td data-label="Importe" className="px-3 py-1 text-right font-semibold">
                      <span className={cn(voided && 'text-text-faint line-through')}>
                        $ {formatMoney(mv.amount)}
                      </span>
                    </td>

                    <td className="px-3 py-1 text-center">
                      {!voided && (
                        <button
                          onClick={() => handleVoid(mv)}
                          aria-label={`Anular ${mv.fullNumber}`}
                          title="Anular"
                          className="text-text-soft transition-colors hover:text-danger"
                        >
                          <Ban size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Panel>
      </>
      )}

      {creating && (
        <MovementModal
          type={creating}
          balances={balances.filter((b) => b.active)}
          concepts={concepts}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function MovementModal({
  type,
  balances,
  concepts,
  onClose,
  onSaved,
}: {
  type: TreasuryMovementType;
  balances: MethodBalance[];
  concepts: ExpenseConcept[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [movementDate, setMovementDate] = React.useState(todayLocal());
  const [conceptId, setConceptId] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [payee, setPayee] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [fromId, setFromId] = React.useState('');
  const [toId, setToId] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // La cartera no se ofrece: sus movimientos salen del módulo de cheques.
  const selectable = balances.filter((b) => b.kind !== 'CARTERA_CHEQUES');

  const isTransfer = type === 'TRANSFERENCIA';
  const needsFrom = type === 'EGRESO' || isTransfer;
  const needsTo = type === 'INGRESO' || isTransfer;

  const amountNumber = Number(amount);
  const amountInvalid = amount.trim() === '' || !Number.isFinite(amountNumber) || amountNumber <= 0;
  const sameMethod = isTransfer && fromId !== '' && fromId === toId;

  const canSave =
    !amountInvalid &&
    description.trim() !== '' &&
    (!needsFrom || fromId !== '') &&
    (!needsTo || toId !== '') &&
    !sameMethod &&
    !saving;

  const fromBalance = balances.find((b) => b.paymentMethodId === fromId);
  const resulting = fromBalance && !amountInvalid ? fromBalance.balance - amountNumber : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await saveMovement(
        {
          movementType: type,
          movementDate,
          conceptId: conceptId || null,
          description,
          payee,
          amount: amountNumber,
          notes,
        },
        buildLegs(type, amountNumber, fromId, toId)
      );
      onSaved();
    } catch (err) {
      setError(describeTreasuryError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-text">
              {type === 'EGRESO' ? 'Gasto sin factura' : MOVEMENT_TYPE_LABELS[type]}
            </h2>
            <p className="mt-0.5 text-[11px] text-text-soft">{MOVEMENT_TYPE_HELP[type]}</p>
          </div>
          <span className="font-mono text-xs text-text-faint">{MOVEMENT_TYPE_PREFIX[type]}-…</span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Fecha *
              <input
                type="date"
                value={movementDate}
                onChange={(e) => setMovementDate(e.target.value)}
                className={cn(inputClass, !movementDate && 'field-required')}
              />
            </label>

            <label className={labelClass}>
              Importe *
              <input
                type="number" step="0.01" min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
                className={cn(inputClass, 'font-mono', amountInvalid && 'field-required')}
              />
            </label>
          </div>

          <label className={labelClass}>
            Detalle *
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={type === 'EGRESO' ? 'Resmas y biromes' : 'Aporte de socio'}
              className={cn(inputClass, description.trim() === '' && 'field-required')}
            />
          </label>

          {/* Una transferencia no es un gasto: no se clasifica con un concepto. */}
          {!isTransfer && (
            <label className={labelClass}>
              Concepto
              <select
                value={conceptId}
                onChange={(e) => setConceptId(e.target.value)}
                className={cn(inputClass, 'bg-panel')}
              >
                <option value="">— sin concepto —</option>
                {concepts.map((concept) => (
                  <option key={concept.id} value={concept.id}>{concept.name}</option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                El mismo padrón que clasifica las facturas de compra de conceptos.
              </span>
            </label>
          )}

          {type === 'EGRESO' && (
            <label className={labelClass}>
              Beneficiario
              <input
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                placeholder="Remisería del centro"
                className={inputClass}
              />
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Texto libre: el gasto sin factura suele ser de alguien que no está en el padrón.
              </span>
            </label>
          )}

          <div className="grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-2">
            {needsFrom && (
              <label className={labelClass}>
                {isTransfer ? 'Sale de *' : 'Medio de pago *'}
                <select
                  value={fromId}
                  onChange={(e) => setFromId(e.target.value)}
                  className={cn(inputClass, 'bg-panel', fromId === '' && 'field-required')}
                >
                  <option value="">Elegí un medio</option>
                  {selectable.map((b) => (
                    <option key={b.paymentMethodId} value={b.paymentMethodId}>
                      {b.name} — $ {formatMoney(b.balance)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {needsTo && (
              <label className={labelClass}>
                {isTransfer ? 'Entra en *' : 'Medio de pago *'}
                <select
                  value={toId}
                  onChange={(e) => setToId(e.target.value)}
                  className={cn(inputClass, 'bg-panel', toId === '' && 'field-required')}
                >
                  <option value="">Elegí un medio</option>
                  {selectable.map((b) => (
                    <option key={b.paymentMethodId} value={b.paymentMethodId}>
                      {b.name} — $ {formatMoney(b.balance)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {sameMethod && (
            <p className="flex items-center gap-1.5 text-xs text-danger">
              <AlertTriangle size={14} /> El origen y el destino no pueden ser el mismo medio.
            </p>
          )}

          {/* Avisa, no bloquea: puede haber un saldo mal cargado y no es la app
              quien tiene que decidir si el gasto ocurrió o no. */}
          {resulting !== null && resulting < 0 && (
            <p className="flex items-start gap-1.5 text-xs text-accent-deep">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {fromBalance?.name} queda en $ {formatMoney(resulting)}. Se puede guardar igual, pero
              revisá el saldo inicial o si falta cargar un ingreso.
            </p>
          )}

          <label className={labelClass}>
            Observaciones
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={cn(inputClass, 'resize-y')}
            />
          </label>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? 'Guardando…' : 'Registrar'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
