import React from 'react';
import { Save, XCircle, Plus, Trash2, AlertTriangle, Check, Wand2 } from 'lucide-react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { fetchPaymentMethods, type PaymentMethod } from '@/src/lib/paymentMethods';
import { fetchTaxRates, type TaxRate } from '@/src/lib/taxRates';
import { fetchBanks, type Bank } from '@/src/lib/banks';
import { fetchChecks, type ThirdPartyCheck } from '@/src/lib/checks';
import { BankCombobox } from '@/src/components/BankCombobox';
import { CheckDraftModal } from '@/src/components/CheckDraftModal';
import {
  autoAllocate,
  CHANGE_KIND_LABELS,
  describeReceiptError,
  fetchCustomerCredit,
  fetchOpenInvoices,
  isCashValue,
  saveReceipt,
  VALUE_KIND_HELP,
  VALUE_KIND_LABELS,
  type ChangeInput,
  type OpenInvoice,
  type ReceiptValueKind,
  type ValueInput,
} from '@/src/lib/receipts';

/** Un valor en edición. Los campos que no aplican a su tipo quedan vacíos. */
interface DraftValue extends ValueInput {
  key: number;
}

/** Un tramo del vuelto en edición. El vuelto puede repartirse en varios. */
interface DraftChange extends ChangeInput {
  key: number;
}

/** Una entrada del desplegable de "Medios de pago": qué kind produce y con qué datos fijos. */
type MedioOption =
  | { optionKey: string; kind: 'MEDIO_PAGO'; label: string; paymentMethodId: string }
  | { optionKey: string; kind: 'CHEQUE'; label: string }
  | { optionKey: string; kind: 'RETENCION'; label: string; taxRateId: string }
  | { optionKey: string; kind: 'SALDO_A_FAVOR'; label: string };

let nextKey = 1;

/** Campo angosto para las filas de un renglón (medios de pago ya agregados). */
const compactFieldClass =
  'rounded border border-line bg-panel px-2 py-1 text-sm focus:border-accent-deep focus:outline-none';

/**
 * Carga de un recibo de cobranza.
 *
 * La pantalla tiene dos mitades que tienen que cerrar entre sí: arriba QUÉ se
 * cancela (las facturas) y abajo CON QUÉ se cobra (los valores). El cartel de
 * abajo dice en todo momento cuánto falta o cuánto sobra, porque es el error
 * que más caro sale: un recibo que no cuadra deja una factura mal cancelada.
 */
export function ReceiptNew() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [methods, setMethods] = React.useState<PaymentMethod[]>([]);
  const [retentions, setRetentions] = React.useState<TaxRate[]>([]);
  const [banks, setBanks] = React.useState<Bank[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [customerId, setCustomerId] = React.useState('');
  const [receiptDate, setReceiptDate] = React.useState(todayLocal());
  const [notes, setNotes] = React.useState('');

  const [invoices, setInvoices] = React.useState<OpenInvoice[]>([]);
  const [credit, setCredit] = React.useState(0);
  const [loadingCustomer, setLoadingCustomer] = React.useState(false);
  const [allocations, setAllocations] = React.useState<Record<string, string>>({});
  const [values, setValues] = React.useState<DraftValue[]>([]);

  const [selectedMedioKey, setSelectedMedioKey] = React.useState('');
  const [draftAmount, setDraftAmount] = React.useState(0);
  const [checkModalOpen, setCheckModalOpen] = React.useState(false);

  const [walletChecks, setWalletChecks] = React.useState<ThirdPartyCheck[]>([]);
  const [changes, setChanges] = React.useState<DraftChange[]>([]);
  const [changeKind, setChangeKind] = React.useState<ChangeInput['kind']>('MEDIO_PAGO');
  const [changePaymentMethodId, setChangePaymentMethodId] = React.useState('');
  const [changeNote, setChangeNote] = React.useState('');
  const [changeAmount, setChangeAmount] = React.useState(0);
  const [checkPickerOpen, setCheckPickerOpen] = React.useState(false);

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;
    Promise.all([
      fetchCustomers(true),
      fetchPaymentMethods(true),
      fetchTaxRates(true),
      fetchBanks(true),
      fetchChecks(),
    ])
      .then(([c, m, r, b, checks]) => {
        if (cancelled) return;
        setCustomers(c);
        // La cartera no se elige como medio: el cheque se carga como cheque.
        setMethods(m.filter((method) => method.kind !== 'CARTERA_CHEQUES'));
        setRetentions(r.filter((rate) => rate.kind === 'RETENCION'));
        setBanks(b);
        // Solo los que siguen en cartera se pueden entregar de vuelto.
        setWalletChecks(checks.filter((check) => check.status === 'EN_CARTERA'));
      })
      .catch((err) => !cancelled && setError(describeReceiptError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [role]);

  // Doble click en "Cuenta corriente" (Cobranzas) manda para acá con el
  // cliente ya elegido.
  React.useEffect(() => {
    const fromQuery = searchParams.get('cliente');
    if (fromQuery) setCustomerId(fromQuery);
  }, [searchParams]);

  // Al cambiar de cliente se recarga todo lo suyo y se limpia lo cargado: las
  // imputaciones de un cliente no tienen sentido para otro.
  React.useEffect(() => {
    if (!customerId) {
      setInvoices([]);
      setCredit(0);
      setAllocations({});
      return;
    }
    let cancelled = false;
    setLoadingCustomer(true);
    setAllocations({});
    Promise.all([fetchOpenInvoices(customerId), fetchCustomerCredit(customerId)])
      .then(([inv, cr]) => {
        if (cancelled) return;
        setInvoices(inv);
        setCredit(cr);
      })
      .catch((err) => !cancelled && setError(describeReceiptError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoadingCustomer(false));
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const totalValues = React.useMemo(
    () => round2(values.reduce((sum, v) => sum + (Number(v.amount) || 0), 0)),
    [values]
  );

  const totalAllocated = React.useMemo(
    () => round2(Object.values(allocations).reduce((sum, a) => sum + (Number(a) || 0), 0)),
    [allocations]
  );

  const creditUsed = React.useMemo(
    () =>
      round2(
        values
          .filter((v) => v.kind === 'SALDO_A_FAVOR')
          .reduce((sum, v) => sum + (Number(v.amount) || 0), 0)
      ),
    [values]
  );

  const cashTotal = React.useMemo(
    () => round2(values.filter((v) => isCashValue(v.kind)).reduce((s, v) => s + (Number(v.amount) || 0), 0)),
    [values]
  );

  // El desplegable de "Medios de pago" junta en una sola lista los medios
  // reales (efectivo/banco), el cheque y —si aplican— retención y saldo a
  // favor, así el usuario elige de un solo lugar en vez de cuatro botones.
  const medioOptions = React.useMemo<MedioOption[]>(() => {
    const options: MedioOption[] = methods.map((m) => ({
      optionKey: `medio:${m.id}`,
      kind: 'MEDIO_PAGO',
      label: m.name,
      paymentMethodId: m.id,
    }));
    options.push({ optionKey: 'cheque', kind: 'CHEQUE', label: 'Cheque' });
    retentions.forEach((r) =>
      options.push({ optionKey: `retencion:${r.id}`, kind: 'RETENCION', label: r.name, taxRateId: r.id })
    );
    if (credit > 0) options.push({ optionKey: 'credito', kind: 'SALDO_A_FAVOR', label: 'Saldo a favor' });
    return options;
  }, [methods, retentions, credit]);

  // Lo que falta cubrir: lo imputado a las facturas menos lo ya agregado acá
  // abajo. Es el número que se sugiere cada vez que se elige un medio nuevo.
  const suggestedRemaining = React.useMemo(
    () => Math.max(0, round2(totalAllocated - totalValues)),
    [totalAllocated, totalValues]
  );

  // Lo que sobra después de imputar a facturas. Por default queda a cuenta
  // (saldo a favor automático); el vuelto se puede repartir en varios tramos.
  const onAccount = round2(totalValues - totalAllocated);

  const changesTotal = React.useMemo(
    () => round2(changes.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)),
    [changes]
  );

  // Cuánto queda del sobrante sin asignar a ningún tramo del vuelto — es lo
  // que se sugiere cada vez que se agrega un tramo nuevo.
  const remainingForChange = Math.max(0, round2(onAccount - changesTotal));

  // Cheques de cartera que todavía se pueden ofrecer: en cartera, no
  // elegidos ya en otro tramo de este mismo vuelto, y que entran completos
  // en lo que falta repartir (un cheque no se parte).
  const availableWalletChecks = React.useMemo(
    () =>
      walletChecks.filter(
        (check) =>
          !changes.some((c) => c.checkId === check.id) && check.amount <= remainingForChange + 0.005
      ),
    [walletChecks, changes, remainingForChange]
  );

  // Si el sobrante baja de lo que ya se había marcado como vuelto (se sacó
  // una factura, se bajó un valor), el vuelto cargado deja de tener sentido.
  React.useEffect(() => {
    if (changes.length > 0 && (onAccount <= 0 || changesTotal > onAccount)) setChanges([]);
  }, [onAccount, changesTotal, changes.length]);

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) {
    return <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">Cargando padrones…</div>;
  }

  function patchValue(key: number, patch: Partial<DraftValue>) {
    setValues((current) => current.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  }

  function handleSelectMedio(optionKey: string) {
    setSelectedMedioKey(optionKey);
    setDraftAmount(suggestedRemaining);
  }

  function handleAddMedio() {
    const option = medioOptions.find((o) => o.optionKey === selectedMedioKey);
    if (!option) return;

    if (option.kind === 'CHEQUE') {
      setCheckModalOpen(true);
      return;
    }

    setValues((current) => [
      ...current,
      {
        key: nextKey++,
        kind: option.kind,
        amount: draftAmount,
        paymentMethodId: option.kind === 'MEDIO_PAGO' ? option.paymentMethodId : undefined,
        taxRateId: option.kind === 'RETENCION' ? option.taxRateId : undefined,
      },
    ]);
    setSelectedMedioKey('');
    setDraftAmount(0);
  }

  function handleAddChecks(checks: Omit<DraftValue, 'key' | 'kind'>[]) {
    setValues((current) => [
      ...current,
      ...checks.map((check) => ({ key: nextKey++, kind: 'CHEQUE' as ReceiptValueKind, ...check })),
    ]);
    setCheckModalOpen(false);
    setSelectedMedioKey('');
    setDraftAmount(0);
  }

  function handleChangeKindChange(kind: ChangeInput['kind']) {
    setChangeKind(kind);
    setChangeAmount(remainingForChange);
    setChangePaymentMethodId(kind === 'MEDIO_PAGO' ? methods[0]?.id ?? '' : '');
    setChangeNote('');
  }

  function handleAddChange() {
    if (changeKind === 'CHEQUE_ENDOSADO') {
      setCheckPickerOpen(true);
      return;
    }
    setChanges((current) => [
      ...current,
      {
        key: nextKey++,
        kind: changeKind,
        amount: changeAmount,
        paymentMethodId: changeKind === 'MEDIO_PAGO' ? changePaymentMethodId : undefined,
        note: changeKind === 'CHEQUE_PROPIO' ? changeNote : undefined,
      },
    ]);
    setChangeAmount(0);
    setChangeNote('');
  }

  function handlePickChangeCheck(check: ThirdPartyCheck) {
    setChanges((current) => [
      ...current,
      { key: nextKey++, kind: 'CHEQUE_ENDOSADO', amount: check.amount, checkId: check.id },
    ]);
    setCheckPickerOpen(false);
  }

  function handleAutoAllocate() {
    if (totalValues <= 0) {
      setError('Cargá primero con qué se cobra: el reparto usa ese importe.');
      return;
    }
    const auto = autoAllocate(invoices, totalValues);
    setAllocations(
      Object.fromEntries(Object.entries(auto).map(([id, amount]) => [id, String(amount)]))
    );
    setError(null);
  }

  // Un problema por vez y en orden de gravedad: el primero que aparezca es el
  // que hay que resolver, y los demás pueden desaparecer al arreglarlo.
  const problems: string[] = [];
  if (!customerId) problems.push('Elegí un cliente.');
  if (totalValues <= 0) problems.push('Cargá con qué se cobra.');
  if (totalAllocated > totalValues) {
    problems.push(
      `Estás imputando $ ${formatMoney(totalAllocated)} y el recibo cobra $ ${formatMoney(totalValues)}.`
    );
  }
  if (creditUsed > credit) {
    problems.push(
      `El cliente tiene $ ${formatMoney(credit)} a favor y estás usando $ ${formatMoney(creditUsed)}.`
    );
  }
  values.forEach((v) => {
    if (Number(v.amount) <= 0) problems.push('Hay un valor con importe en cero.');
    if (v.kind === 'CHEQUE' && (!v.checkNumber?.trim() || !v.checkBank?.trim() || !v.checkDueDate)) {
      problems.push('Falta completar número, banco o fecha de cobro de un cheque.');
    }
  });
  for (const invoice of invoices) {
    const amount = Number(allocations[invoice.id]) || 0;
    if (amount > invoice.balance) {
      problems.push(`${invoice.fullNumber} debe $ ${formatMoney(invoice.balance)}.`);
    }
  }
  changes.forEach((c) => {
    if (Number(c.amount) <= 0) problems.push('Hay un tramo del vuelto con importe en cero.');
    if (c.kind === 'MEDIO_PAGO' && !c.paymentMethodId) problems.push('Elegí con qué se da un tramo del vuelto.');
    if (c.kind === 'CHEQUE_PROPIO' && !c.note?.trim()) problems.push('Indicá una referencia para el cheque propio del vuelto.');
    if (c.kind === 'CHEQUE_ENDOSADO' && !c.checkId) problems.push('Falta elegir qué cheque se entrega de vuelto.');
  });
  if (changes.length > 0 && changesTotal > onAccount) {
    problems.push(
      `El vuelto ($ ${formatMoney(changesTotal)}) no puede ser mayor a lo que queda a cuenta ($ ${formatMoney(onAccount)}).`
    );
  }

  const canSave = problems.length === 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveReceipt(
        { customerId, receiptDate, notes },
        Object.entries(allocations)
          .map(([invoiceId, amount]) => ({ invoiceId, amount: Number(amount) || 0 }))
          .filter((a) => a.amount > 0),
        values.map(({ key: _key, ...value }) => ({ ...value, amount: Number(value.amount) || 0 })),
        changes.length > 0
          ? changes.map(({ key: _key, ...c }) => ({ ...c, amount: Number(c.amount) || 0 }))
          : undefined
      );
      navigate('/cobranzas');
    } catch (err) {
      setError(describeReceiptError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  const customer = customers.find((c) => c.id === customerId) ?? null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Nueva cobranza"
        subtitle="Qué facturas se cancelan y con qué se cobran."
        actions={
          <>
            <Link to="/cobranzas">
              <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
            </Link>
            <Button onClick={handleSave} disabled={!canSave}>
              <Save size={16} /> {saving ? 'Guardando…' : 'Registrar recibo'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* ── Cliente ─────────────────────────────────────────────────── */}
      <Panel className="mb-6 p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className={cn(labelClass, 'sm:col-span-2')}>
            Cliente *
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className={cn(inputClass, 'bg-panel', !customerId && 'field-required')}
            >
              <option value="">Elegí un cliente</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.taxId ? ` — ${formatCuit(c.taxId)}` : ''}
                </option>
              ))}
            </select>
            {customer && credit > 0 && (
              <span className="mt-1 block text-[10px] font-normal normal-case text-state-done">
                Tiene $ {formatMoney(credit)} a favor de cobros anteriores.
              </span>
            )}
          </label>

          <label className={labelClass}>
            Fecha *
            <input
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      </Panel>

      {/* ── Facturas ────────────────────────────────────────────────── */}
      <Panel className="mb-6 p-5">
        <SectionHeader
          title="Facturas a cancelar"
          actions={
            invoices.length > 0 && (
              <Button type="button" variant="ghost" onClick={handleAutoAllocate} className="px-3">
                <Wand2 size={15} /> Repartir automático
              </Button>
            )
          }
        />

        {!customerId && <p className="text-sm text-text-soft">Elegí un cliente para ver sus facturas impagas.</p>}
        {customerId && loadingCustomer && <p className="text-sm text-text-soft">Cargando facturas…</p>}
        {customerId && !loadingCustomer && invoices.length === 0 && (
          <p className="text-sm text-text-soft">
            Este cliente no tiene facturas con saldo. Podés cobrar igual: el importe queda a cuenta.
          </p>
        )}

        {invoices.length > 0 && (
          <div className="overflow-x-auto overflow-y-hidden rounded-md border border-line">
            <table className="table-stack w-full text-left text-[13px]">
              <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <tr>
                  <th className="px-3 py-1 w-40">Comprobante</th>
                  <th className="px-3 py-1 w-28">Emisión</th>
                  <th className="px-3 py-1 w-28">Vence</th>
                  <th className="px-3 py-1 w-32 text-right">Saldo</th>
                  <th className="px-3 py-1 w-36 text-right">A imputar</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice, idx) => {
                  const amount = Number(allocations[invoice.id]) || 0;
                  const excess = amount > invoice.balance;
                  const overdue = invoice.dueDate < todayLocal();
                  return (
                    <tr key={invoice.id} className={cn('h-10 border-b border-line', idx % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
                      <td data-primary className="px-3 py-1 font-mono font-semibold">
                        {invoice.invoiceType} {invoice.fullNumber}
                      </td>
                      <td data-label="Emisión" className="px-3 py-1 text-text-soft">
                        {formatDate(invoice.issueDate)}
                      </td>
                      <td data-label="Vence" className="px-3 py-1">
                        <span className={cn(overdue ? 'font-semibold text-danger' : 'text-text-soft')}>
                          {formatDate(invoice.dueDate)}
                        </span>
                      </td>
                      <td data-label="Saldo" className="px-3 py-1 text-right font-semibold">
                        $ {formatMoney(invoice.balance)}
                      </td>
                      <td data-label="A imputar" className="px-1 py-1">
                        <input
                          type="number" step="0.01" min="0"
                          value={allocations[invoice.id] ?? ''}
                          onChange={(e) =>
                            setAllocations((current) => ({ ...current, [invoice.id]: e.target.value }))
                          }
                          placeholder="0,00"
                          className={cn(
                            'w-full rounded border border-line bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none',
                            excess && 'border-danger bg-danger-soft'
                          )}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── Valores ─────────────────────────────────────────────────── */}
      <Panel className="mb-6 p-5">
        <SectionHeader title="Medios de pago" />

        <div className="mb-4 flex flex-col gap-2 border border-line bg-panel-alt p-3 sm:flex-row sm:items-end">
          <label className={cn(labelClass, 'sm:flex-1')}>
            Medio
            <select
              value={selectedMedioKey}
              onChange={(e) => handleSelectMedio(e.target.value)}
              className={cn(inputClass, 'bg-panel')}
            >
              <option value="">Elegí un medio…</option>
              {medioOptions.map((o) => (
                <option key={o.optionKey} value={o.optionKey}>{o.label}</option>
              ))}
            </select>
          </label>

          {selectedMedioKey && selectedMedioKey !== 'cheque' && (
            <label className={cn(labelClass, 'sm:w-40')}>
              Importe
              <input
                type="number" step="0.01" min="0"
                value={draftAmount || ''}
                onChange={(e) => setDraftAmount(Number(e.target.value))}
                className={cn(inputClass, 'font-mono')}
              />
            </label>
          )}

          <Button
            type="button"
            onClick={handleAddMedio}
            disabled={!selectedMedioKey}
            className="px-3 sm:mb-0"
          >
            <Plus size={15} /> {selectedMedioKey === 'cheque' ? 'Cargar cheques' : 'Agregar'}
          </Button>
        </div>

        {values.length === 0 && (
          <p className="text-sm text-text-soft">Sin valores cargados.</p>
        )}

        <ul className="space-y-2">
          {values.map((value) => (
            <li
              key={value.key}
              className="flex flex-wrap items-center gap-2 border border-line bg-panel-alt px-3 py-2"
            >
              <span
                title={VALUE_KIND_HELP[value.kind]}
                className="w-32 shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-deep"
              >
                {VALUE_KIND_LABELS[value.kind]}
              </span>

              {value.kind === 'MEDIO_PAGO' && (
                <select
                  value={value.paymentMethodId ?? ''}
                  onChange={(e) => patchValue(value.key, { paymentMethodId: e.target.value })}
                  className={cn(compactFieldClass, 'bg-panel')}
                >
                  {methods.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              )}

              {value.kind === 'RETENCION' && (
                <>
                  <select
                    value={value.taxRateId ?? ''}
                    onChange={(e) => patchValue(value.key, { taxRateId: e.target.value })}
                    className={cn(compactFieldClass, 'bg-panel')}
                  >
                    {retentions.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <input
                    value={value.certificateNumber ?? ''}
                    onChange={(e) => patchValue(value.key, { certificateNumber: e.target.value })}
                    placeholder="N° certificado"
                    className={cn(compactFieldClass, 'w-32 font-mono')}
                  />
                </>
              )}

              {value.kind === 'CHEQUE' && (
                <>
                  <input
                    value={value.checkNumber ?? ''}
                    onChange={(e) => patchValue(value.key, { checkNumber: e.target.value })}
                    placeholder="Número"
                    className={cn(compactFieldClass, 'w-24 font-mono', !value.checkNumber?.trim() && 'field-required')}
                  />
                  <BankCombobox
                    value={value.checkBank ?? ''}
                    onChange={(name) => patchValue(value.key, { checkBank: name })}
                    banks={banks}
                    onBankCreated={(bank) => setBanks((current) => [...current, bank])}
                    placeholder="Banco"
                    className={cn(compactFieldClass, 'w-28', !value.checkBank?.trim() && 'field-required')}
                  />
                  <input
                    type="date"
                    value={value.checkDueDate ?? ''}
                    onChange={(e) => patchValue(value.key, { checkDueDate: e.target.value })}
                    className={cn(compactFieldClass, 'w-36', !value.checkDueDate && 'field-required')}
                  />
                </>
              )}

              <input
                type="number" step="0.01" min="0"
                value={value.amount || ''}
                onChange={(e) => patchValue(value.key, { amount: Number(e.target.value) })}
                className={cn(
                  compactFieldClass,
                  'ml-auto w-28 text-right font-mono',
                  Number(value.amount) <= 0 && 'field-required'
                )}
              />

              <button
                type="button"
                onClick={() => setValues((c) => c.filter((v) => v.key !== value.key))}
                aria-label="Quitar valor"
                className="shrink-0 text-text-soft transition-colors hover:text-danger"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      {checkModalOpen && (
        <CheckDraftModal
          remainingBase={suggestedRemaining}
          banks={banks}
          onBankCreated={(bank) => setBanks((current) => [...current, bank])}
          onConfirm={handleAddChecks}
          onClose={() => setCheckModalOpen(false)}
        />
      )}

      {checkPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Panel className="max-h-[80vh] w-full max-w-lg overflow-y-auto p-5">
            <div className="mb-3 flex items-center justify-between">
              <SectionHeader title="Cheque de cartera para el vuelto" />
              <button
                type="button"
                onClick={() => setCheckPickerOpen(false)}
                aria-label="Cerrar"
                className="text-text-soft transition-colors hover:text-danger"
              >
                <XCircle size={18} />
              </button>
            </div>
            {availableWalletChecks.length === 0 ? (
              <p className="text-sm text-text-soft">
                No hay cheques en cartera que entren completos en lo que falta devolver.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {availableWalletChecks.map((check) => (
                  <li key={check.id}>
                    <button
                      type="button"
                      onClick={() => handlePickChangeCheck(check)}
                      className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:text-accent-deep"
                    >
                      <span>
                        <span className="block text-sm font-medium">
                          {check.number} · {check.bankName}
                        </span>
                        <span className="block text-xs text-text-soft">Vence {formatDate(check.dueDate)}</span>
                      </span>
                      <span className="font-mono text-sm">$ {formatMoney(check.amount)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {/* ── El cuadre ───────────────────────────────────────────────── */}
      <Panel className="mb-10 p-5">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <dl className="space-y-1 text-[13px]">
            <Row label="Cobrado" value={totalValues} />
            <Row label="Imputado a facturas" value={totalAllocated} />
            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                {onAccount >= 0 ? 'Queda a cuenta' : 'Falta cobrar'}
              </dt>
              <dd className={cn('font-display text-2xl font-medium', onAccount < 0 ? 'text-danger' : 'text-text')}>
                $ {formatMoney(Math.abs(onAccount))}
              </dd>
            </div>
            {cashTotal !== totalValues && (
              <p className="pt-2 text-[10px] text-text-soft">
                Entra a caja $ {formatMoney(cashTotal)}. El resto son retenciones o saldo a favor,
                que cancelan factura pero no son plata.
              </p>
            )}

            {onAccount > 0 && (
              <div className="mt-1 space-y-2 border-t border-line pt-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-deep">
                  Vuelto
                </span>

                {changes.length > 0 && (
                  <ul className="space-y-1">
                    {changes.map((c) => (
                      <li key={c.key} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-text">
                          {CHANGE_KIND_LABELS[c.kind]}
                          {c.kind === 'MEDIO_PAGO' && ` — ${methods.find((m) => m.id === c.paymentMethodId)?.name ?? '?'}`}
                          {c.kind === 'CHEQUE_PROPIO' && c.note ? ` — ${c.note}` : ''}
                          {c.kind === 'CHEQUE_ENDOSADO' &&
                            (() => {
                              const check = walletChecks.find((wc) => wc.id === c.checkId);
                              return check ? ` — ${check.number} · ${check.bankName}` : '';
                            })()}
                        </span>
                        <span className="flex items-center gap-2 font-mono">
                          $ {formatMoney(Number(c.amount) || 0)}
                          <button
                            type="button"
                            onClick={() => setChanges((current) => current.filter((x) => x.key !== c.key))}
                            aria-label="Quitar tramo del vuelto"
                            className="text-text-soft transition-colors hover:text-danger"
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {remainingForChange > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={changeKind}
                      onChange={(e) => handleChangeKindChange(e.target.value as ChangeInput['kind'])}
                      className={cn(compactFieldClass, 'bg-panel')}
                    >
                      <option value="MEDIO_PAGO">{CHANGE_KIND_LABELS.MEDIO_PAGO}</option>
                      <option value="CHEQUE_PROPIO">{CHANGE_KIND_LABELS.CHEQUE_PROPIO}</option>
                      {availableWalletChecks.length > 0 && (
                        <option value="CHEQUE_ENDOSADO">{CHANGE_KIND_LABELS.CHEQUE_ENDOSADO}</option>
                      )}
                    </select>

                    {changeKind === 'MEDIO_PAGO' && (
                      <select
                        value={changePaymentMethodId}
                        onChange={(e) => setChangePaymentMethodId(e.target.value)}
                        className={cn(compactFieldClass, 'bg-panel', !changePaymentMethodId && 'field-required')}
                      >
                        <option value="">Elegí un medio</option>
                        {methods.map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    )}

                    {changeKind === 'CHEQUE_PROPIO' && (
                      <input
                        value={changeNote}
                        onChange={(e) => setChangeNote(e.target.value)}
                        placeholder="Referencia (banco, número, fecha)"
                        className={cn(compactFieldClass, 'min-w-40 flex-1', !changeNote.trim() && 'field-required')}
                      />
                    )}

                    {changeKind !== 'CHEQUE_ENDOSADO' && (
                      <input
                        type="number" step="0.01" min="0" max={remainingForChange}
                        value={changeAmount || ''}
                        onChange={(e) => setChangeAmount(Number(e.target.value))}
                        className={cn(
                          compactFieldClass,
                          'w-28 text-right font-mono',
                          (changeAmount <= 0 || changeAmount > remainingForChange) && 'field-required'
                        )}
                      />
                    )}

                    <Button variant="ghost" type="button" onClick={handleAddChange}>
                      <Plus size={14} /> {changeKind === 'CHEQUE_ENDOSADO' ? 'Elegir cheque' : 'Agregar'}
                    </Button>
                  </div>
                )}

                <p className="text-[10px] text-text-soft">
                  Lo que no se devuelve (${' '}
                  {formatMoney(Math.max(0, round2(onAccount - changesTotal)))}) queda como saldo a favor.
                </p>
              </div>
            )}
          </dl>

          <div>
            {problems.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-state-done">
                <Check size={16} /> El recibo cierra. Listo para registrar.
              </p>
            ) : (
              <ul className="space-y-1">
                {[...new Set(problems)].map((problem) => (
                  <li key={problem} className="flex items-start gap-1.5 text-xs text-danger">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    {problem}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <label className={cn(labelClass, 'mt-5 block border-t border-line pt-4')}>
          Observaciones
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className={cn(inputClass, 'resize-y')}
          />
        </label>

        <div className="mt-4 flex justify-end">
          <Button onClick={handleSave} disabled={!canSave}>
            <Save size={16} /> {saving ? 'Guardando…' : 'Registrar recibo'}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-text-soft">{label}</dt>
      <dd className="font-mono text-text">$ {formatMoney(value)}</dd>
    </div>
  );
}
