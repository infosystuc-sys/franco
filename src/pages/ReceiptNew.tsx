import React from 'react';
import { Save, XCircle, Plus, Trash2, AlertTriangle, Check, Wand2 } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { fetchPaymentMethods, type PaymentMethod } from '@/src/lib/paymentMethods';
import { fetchTaxRates, type TaxRate } from '@/src/lib/taxRates';
import {
  autoAllocate,
  describeReceiptError,
  fetchCustomerCredit,
  fetchOpenInvoices,
  isCashValue,
  saveReceipt,
  VALUE_KIND_HELP,
  VALUE_KIND_LABELS,
  type OpenInvoice,
  type ReceiptValueKind,
  type ValueInput,
} from '@/src/lib/receipts';

/** Un valor en edición. Los campos que no aplican a su tipo quedan vacíos. */
interface DraftValue extends ValueInput {
  key: number;
}

let nextKey = 1;

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

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [methods, setMethods] = React.useState<PaymentMethod[]>([]);
  const [retentions, setRetentions] = React.useState<TaxRate[]>([]);
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

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;
    Promise.all([fetchCustomers(true), fetchPaymentMethods(true), fetchTaxRates(true)])
      .then(([c, m, r]) => {
        if (cancelled) return;
        setCustomers(c);
        // La cartera no se elige como medio: el cheque se carga como cheque.
        setMethods(m.filter((method) => method.kind !== 'CARTERA_CHEQUES'));
        setRetentions(r.filter((rate) => rate.kind === 'RETENCION'));
      })
      .catch((err) => !cancelled && setError(describeReceiptError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [role]);

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

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) {
    return <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">Cargando padrones…</div>;
  }

  function patchValue(key: number, patch: Partial<DraftValue>) {
    setValues((current) => current.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  }

  function addValue(kind: ReceiptValueKind) {
    setValues((current) => [
      ...current,
      {
        key: nextKey++,
        kind,
        amount: 0,
        paymentMethodId: kind === 'MEDIO_PAGO' ? methods[0]?.id : undefined,
        taxRateId: kind === 'RETENCION' ? retentions[0]?.id : undefined,
      },
    ]);
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

  const onAccount = round2(totalValues - totalAllocated);
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
        values.map(({ key: _key, ...value }) => ({ ...value, amount: Number(value.amount) || 0 }))
      );
      navigate(`/recibo/${saved.id}`);
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
        <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
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
          <div className="overflow-x-auto border border-line">
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
                            'w-full border border-line bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none',
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
        <SectionHeader
          title="Con qué se cobra"
          actions={
            <>
              <Button type="button" onClick={() => addValue('MEDIO_PAGO')} className="px-3">
                <Plus size={15} /> Efectivo / banco
              </Button>
              <Button type="button" variant="ghost" onClick={() => addValue('CHEQUE')} className="px-3">
                <Plus size={15} /> Cheque
              </Button>
              {retentions.length > 0 && (
                <Button type="button" variant="ghost" onClick={() => addValue('RETENCION')} className="px-3">
                  <Plus size={15} /> Retención
                </Button>
              )}
              {credit > 0 && (
                <Button type="button" variant="ghost" onClick={() => addValue('SALDO_A_FAVOR')} className="px-3">
                  <Plus size={15} /> Saldo a favor
                </Button>
              )}
            </>
          }
        />

        {values.length === 0 && (
          <p className="text-sm text-text-soft">Sin valores cargados.</p>
        )}

        <ul className="space-y-3">
          {values.map((value) => (
            <li key={value.key} className="border border-line bg-panel-alt p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-deep">
                  {VALUE_KIND_LABELS[value.kind]}
                </span>
                <button
                  type="button"
                  onClick={() => setValues((c) => c.filter((v) => v.key !== value.key))}
                  aria-label="Quitar valor"
                  className="text-text-soft transition-colors hover:text-danger"
                >
                  <Trash2 size={15} />
                </button>
              </div>

              <p className="mb-2 text-[10px] text-text-soft">{VALUE_KIND_HELP[value.kind]}</p>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                <label className={labelClass}>
                  Importe *
                  <input
                    type="number" step="0.01" min="0"
                    value={value.amount || ''}
                    onChange={(e) => patchValue(value.key, { amount: Number(e.target.value) })}
                    className={cn(inputClass, 'font-mono', Number(value.amount) <= 0 && 'field-required')}
                  />
                </label>

                {value.kind === 'MEDIO_PAGO' && (
                  <label className={cn(labelClass, 'sm:col-span-3')}>
                    Medio
                    <select
                      value={value.paymentMethodId ?? ''}
                      onChange={(e) => patchValue(value.key, { paymentMethodId: e.target.value })}
                      className={cn(inputClass, 'bg-panel')}
                    >
                      {methods.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </label>
                )}

                {value.kind === 'RETENCION' && (
                  <>
                    <label className={cn(labelClass, 'sm:col-span-2')}>
                      Alícuota
                      <select
                        value={value.taxRateId ?? ''}
                        onChange={(e) => patchValue(value.key, { taxRateId: e.target.value })}
                        className={cn(inputClass, 'bg-panel')}
                      >
                        {retentions.map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className={labelClass}>
                      N° certificado
                      <input
                        value={value.certificateNumber ?? ''}
                        onChange={(e) => patchValue(value.key, { certificateNumber: e.target.value })}
                        className={cn(inputClass, 'font-mono')}
                      />
                    </label>
                  </>
                )}

                {value.kind === 'CHEQUE' && (
                  <>
                    <label className={labelClass}>
                      Número *
                      <input
                        value={value.checkNumber ?? ''}
                        onChange={(e) => patchValue(value.key, { checkNumber: e.target.value })}
                        className={cn(inputClass, 'font-mono', !value.checkNumber?.trim() && 'field-required')}
                      />
                    </label>
                    <label className={labelClass}>
                      Banco *
                      <input
                        value={value.checkBank ?? ''}
                        onChange={(e) => patchValue(value.key, { checkBank: e.target.value })}
                        className={cn(inputClass, !value.checkBank?.trim() && 'field-required')}
                      />
                    </label>
                    <label className={labelClass}>
                      Fecha de cobro *
                      <input
                        type="date"
                        value={value.checkDueDate ?? ''}
                        onChange={(e) => patchValue(value.key, { checkDueDate: e.target.value })}
                        className={cn(inputClass, !value.checkDueDate && 'field-required')}
                      />
                    </label>
                    <label className={cn(labelClass, 'sm:col-span-4')}>
                      Librador
                      <input
                        value={value.checkDrawer ?? ''}
                        onChange={(e) => patchValue(value.key, { checkDrawer: e.target.value })}
                        placeholder="Quién firmó el cheque"
                        className={inputClass}
                      />
                    </label>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

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
