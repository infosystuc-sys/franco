import React from 'react';
import { Plus, X, Pencil, Trash2, Info, Landmark, Wallet, FileCheck } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  createPaymentMethod,
  deletePaymentMethod,
  describePaymentMethodError,
  EMPTY_PAYMENT_METHOD_FORM,
  fetchPaymentMethods,
  PAYMENT_METHOD_KIND_HELP,
  PAYMENT_METHOD_KIND_LABELS,
  PAYMENT_METHOD_KINDS,
  PAYMENT_METHOD_STRIP,
  paymentMethodToForm,
  updatePaymentMethod,
  type PaymentMethod,
  type PaymentMethodInput,
  type PaymentMethodKind,
} from '@/src/lib/paymentMethods';

const KIND_ICON: Record<PaymentMethodKind, React.ComponentType<{ size?: number; className?: string }>> = {
  EFECTIVO: Wallet,
  BANCO: Landmark,
  CARTERA_CHEQUES: FileCheck,
};

/**
 * ABM de medios de pago: las cajas, las cuentas bancarias y la cartera de
 * cheques. Se agrupa por tipo y no en una tabla plana porque cada tipo se
 * comporta distinto, y esa diferencia es justamente lo que hay que entender
 * antes de cargar uno nuevo.
 */
export function PaymentMethods() {
  const { role } = useAuth();
  const [methods, setMethods] = React.useState<PaymentMethod[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<PaymentMethod | null>(null);
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMethods(await fetchPaymentMethods());
    } catch (err) {
      setError(describePaymentMethodError(getErrorMessage(err), ''));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleDelete(method: PaymentMethod) {
    if (!window.confirm(`¿Eliminar el medio de pago "${method.name}"?`)) return;
    setError(null);
    try {
      await deletePaymentMethod(method.id);
      load();
    } catch (err) {
      setError(describePaymentMethodError(getErrorMessage(err), method.name));
    }
  }

  const hasBank = methods.some((m) => m.kind === 'BANCO' && m.active);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Medios de pago"
        subtitle="Las cajas, las cuentas bancarias y la cartera de cheques del taller."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Nuevo medio
          </Button>
        }
      />

      {error && (
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Las transferencias son movimientos sobre una cuenta bancaria, no un
          medio en sí. Sin ninguna cuenta cargada no hay dónde registrarlas. */}
      {!loading && !hasBank && (
        <div className="flex items-start gap-2 border border-accent bg-accent/10 px-4 py-3 text-sm text-text">
          <Info size={16} className="mt-0.5 shrink-0 text-accent-deep" />
          <span>
            No hay ninguna cuenta bancaria cargada. Las transferencias —tanto las
            que recibís como las que hacés— son movimientos sobre una cuenta, así
            que vas a necesitar una: creala con el tipo <strong>Banco</strong>.
          </span>
        </div>
      )}

      {loading && <p className="text-center text-text-soft">Cargando medios de pago…</p>}

      {!loading &&
        PAYMENT_METHOD_KINDS.map((kind) => {
          const ofKind = methods.filter((method) => method.kind === kind);
          const Icon = KIND_ICON[kind];

          return (
            <section key={kind}>
              <SectionHeader title={PAYMENT_METHOD_KIND_LABELS[kind]} />

              <p className="mb-3 flex items-start gap-1.5 text-xs text-text-soft">
                <Info size={13} className="mt-0.5 shrink-0 text-accent-deep" />
                {PAYMENT_METHOD_KIND_HELP[kind]}
              </p>

              <Panel className="overflow-x-auto">
                <table className="table-stack w-full text-left text-[13px]">
                  <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                    <tr>
                      <th className="px-4 py-1">Nombre</th>
                      <th className="px-3 py-1">Datos</th>
                      <th className="px-3 py-1 w-36 text-right">Saldo inicial</th>
                      <th className="px-3 py-1 w-28">Desde</th>
                      <th className="px-3 py-1 w-24"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ofKind.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-text-soft">
                          {kind === 'BANCO'
                            ? 'No hay cuentas bancarias cargadas. Cargá una por cada cuenta que uses.'
                            : `No hay medios de tipo ${PAYMENT_METHOD_KIND_LABELS[kind].toLowerCase()}.`}
                        </td>
                      </tr>
                    )}

                    {ofKind.map((method) => (
                      <tr
                        key={method.id}
                        className={cn(
                          'relative h-11 border-b border-line last:border-b-0 hover:bg-panel-alt',
                          !method.active && 'text-text-faint'
                        )}
                      >
                        <td data-primary className="relative px-4 py-1 font-semibold">
                          <StateStrip color={PAYMENT_METHOD_STRIP[method.kind]} />
                          <span className="inline-flex items-center gap-1.5">
                            <Icon size={14} className="text-text-soft" />
                            {method.name}
                          </span>
                          {!method.active && (
                            <span className="ml-2 bg-panel-head px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                              Inactivo
                            </span>
                          )}
                        </td>

                        <td data-label="Datos" className="px-3 py-1 text-text-soft">
                          {method.kind === 'BANCO'
                            ? [method.bankName, method.accountNumber].filter(Boolean).join(' · ') || '—'
                            : '—'}
                        </td>

                        <td data-label="Saldo inicial" className="px-3 py-1 text-right font-mono">
                          {method.kind === 'CARTERA_CHEQUES' ? (
                            <span className="text-text-faint">sale de los cheques</span>
                          ) : (
                            `$ ${formatMoney(method.openingBalance)}`
                          )}
                        </td>

                        <td data-label="Desde" className="px-3 py-1 text-text-soft">
                          {method.kind === 'CARTERA_CHEQUES' ? '—' : formatDate(method.openingDate)}
                        </td>

                        <td className="px-3 py-1 text-right">
                          <button
                            onClick={() => setEditing(method)}
                            aria-label={`Editar ${method.name}`}
                            className="p-1 text-text-soft transition-colors hover:text-accent-deep"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(method)}
                            aria-label={`Eliminar ${method.name}`}
                            className="ml-1 p-1 text-text-soft transition-colors hover:text-danger"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            </section>
          );
        })}

      <p className="text-xs text-text-soft">
        Los saldos reales aparecen cuando existan movimientos: se calculan como
        el saldo inicial más lo que entró y salió, así que nunca quedan
        desfasados. Eso llega en la etapa siguiente.
      </p>

      {(creating || editing) && (
        <PaymentMethodModal
          method={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PaymentMethodModal({
  method,
  onClose,
  onSaved,
}: {
  method: PaymentMethod | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<PaymentMethodInput>(
    method
      ? paymentMethodToForm(method)
      : { ...EMPTY_PAYMENT_METHOD_FORM, openingDate: todayLocal() }
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<PaymentMethodInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  const isBank = form.kind === 'BANCO';
  const isWallet = form.kind === 'CARTERA_CHEQUES';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre es obligatorio.');
      return;
    }
    if (!form.openingDate) {
      setError('Indicá desde qué fecha vale el saldo inicial.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (method) await updatePaymentMethod(method.id, form);
      else await createPaymentMethod(form);
      onSaved();
    } catch (err) {
      setError(describePaymentMethodError(getErrorMessage(err), form.name));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-bold text-text">
            {method ? 'Editar medio de pago' : 'Nuevo medio de pago'}
          </h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <label className={labelClass}>
            Tipo
            <select
              value={form.kind}
              onChange={(e) => patch({ kind: e.target.value as PaymentMethodKind })}
              className={cn(inputClass, 'bg-panel')}
            >
              {PAYMENT_METHOD_KINDS.map((kind) => (
                <option key={kind} value={kind}>{PAYMENT_METHOD_KIND_LABELS[kind]}</option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
              {PAYMENT_METHOD_KIND_HELP[form.kind]}
            </span>
          </label>

          <label className={labelClass}>
            Nombre *
            <input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={cn(inputClass, form.name.trim() === '' && 'field-required')}
              placeholder={isBank ? 'Banco Nación — cuenta corriente' : 'Caja Chica'}
            />
          </label>

          {isBank && (
            <div className="space-y-3 border-t border-line pt-4">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep">
                Datos de la cuenta
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className={labelClass}>
                  Banco
                  <input
                    value={form.bankName}
                    onChange={(e) => patch({ bankName: e.target.value })}
                    className={inputClass}
                    placeholder="Banco de la Nación Argentina"
                  />
                </label>
                <label className={labelClass}>
                  N° de cuenta
                  <input
                    value={form.accountNumber}
                    onChange={(e) => patch({ accountNumber: e.target.value })}
                    className={cn(inputClass, 'font-mono')}
                    placeholder="0000-12345678"
                  />
                </label>
                <label className={cn(labelClass, 'sm:col-span-2')}>
                  CBU
                  <input
                    value={form.cbu}
                    onChange={(e) => patch({ cbu: e.target.value })}
                    className={cn(inputClass, 'font-mono')}
                    placeholder="0110000000000000000000"
                  />
                </label>
              </div>
            </div>
          )}

          {isWallet ? (
            <p className="border border-line bg-panel-alt p-3 text-xs text-text-soft">
              La cartera de cheques no lleva saldo inicial: su saldo sale de los
              cheques que estén en cartera. Los que ya tengas en mano se cargan
              como cheques, no como un importe.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-2">
              <label className={labelClass}>
                Saldo inicial
                <input
                  type="number" step="0.01"
                  value={form.openingBalance}
                  onChange={(e) => patch({ openingBalance: e.target.value })}
                  className={cn(inputClass, 'font-mono')}
                />
              </label>
              <label className={labelClass}>
                Desde *
                <input
                  type="date"
                  value={form.openingDate}
                  onChange={(e) => patch({ openingDate: e.target.value })}
                  className={cn(inputClass, !form.openingDate && 'field-required')}
                />
                <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                  Fecha a la que ese saldo era el correcto.
                </span>
              </label>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => patch({ active: e.target.checked })}
              className="h-4 w-4 accent-accent-deep"
            />
            Activo (se ofrece al registrar movimientos)
          </label>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
