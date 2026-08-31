import React from 'react';
import { Save, XCircle, AlertTriangle } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchExpenseConcepts, type ExpenseConcept } from '@/src/lib/expenseConcepts';
import { fetchBanks, type Bank } from '@/src/lib/banks';
import { BankCombobox } from '@/src/components/BankCombobox';
import {
  describeCheckError,
  EMPTY_CHECK_FORM,
  receiveCheck,
  type CheckInput,
} from '@/src/lib/checks';

/**
 * Alta de un cheque recibido, en pantalla propia — mismo patrón que el resto
 * de los comprobantes (cobranzas, pagos, compras): el listado de cartera
 * queda solo con la cartera y sus acciones, la carga vive aparte.
 */
export function CheckNew() {
  const { role } = useAuth();
  const navigate = useNavigate();

  const [concepts, setConcepts] = React.useState<ExpenseConcept[]>([]);
  const [checkBanks, setCheckBanks] = React.useState<Bank[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [form, setForm] = React.useState<CheckInput>({
    ...EMPTY_CHECK_FORM,
    receivedDate: todayLocal(),
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;
    Promise.all([fetchExpenseConcepts(true), fetchBanks(true)])
      .then(([ec, cb]) => {
        if (cancelled) return;
        setConcepts(ec);
        setCheckBanks(cb);
      })
      .catch((err) => !cancelled && setLoadError(describeCheckError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [role]);

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) {
    return <div className="mx-auto max-w-3xl p-8 text-center text-text-soft">Cargando…</div>;
  }

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
      navigate('/cheques');
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Recibir cheque"
        subtitle="Entra a la cartera y queda registrado como ingreso en el libro de caja."
        actions={
          <>
            <Link to="/cheques">
              <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
            </Link>
            <Button onClick={handleSubmit} disabled={!canSave}>
              <Save size={16} /> {saving ? 'Guardando…' : 'Recibir'}
            </Button>
          </>
        }
      />

      {(error || loadError) && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          {error ?? loadError}
        </div>
      )}

      <Panel className="p-5">
        <form onSubmit={handleSubmit} className="space-y-4">
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
              <BankCombobox
                value={form.bankName}
                onChange={(name) => patch({ bankName: name })}
                banks={checkBanks}
                onBankCreated={(bank) => setCheckBanks((current) => [...current, bank])}
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
        </form>
      </Panel>
    </div>
  );
}
