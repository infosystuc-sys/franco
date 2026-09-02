import React from 'react';
import { Save, XCircle, Plus, Trash2, AlertTriangle, Check, Wand2, FileCheck, FileMinus, X } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { fetchPaymentMethods, type PaymentMethod } from '@/src/lib/paymentMethods';
import { fetchTaxRates, type TaxRate } from '@/src/lib/taxRates';
import { fetchChecks, type ThirdPartyCheck } from '@/src/lib/checks';
import { formatCuit } from '@/src/lib/fiscal';
import {
  autoAllocate,
  describePaymentOrderError,
  fetchAvailableProvisionalCreditNotes,
  fetchOpenPurchaseDocs,
  fetchSupplierCredit,
  isCashValue,
  PAYMENT_VALUE_HELP,
  PAYMENT_VALUE_LABELS,
  PURCHASE_DOC_TYPE_SHORT,
  savePaymentOrder,
  signOfDoc,
  type NewProvisionalCreditNoteInput,
  type OpenPurchaseDoc,
  type PaymentAllocationInput,
  type PaymentValueInput,
  type ProvisionalCreditNote,
} from '@/src/lib/paymentOrders';

interface DraftValue extends PaymentValueInput {
  key: number;
}

/** Una entrada del desplegable de "Medios de pago": qué kind produce y con qué datos fijos. */
type MedioOption =
  | { optionKey: string; kind: 'MEDIO_PAGO'; label: string; paymentMethodId: string }
  | { optionKey: string; kind: 'RETENCION'; label: string; taxRateId: string }
  | { optionKey: string; kind: 'SALDO_A_FAVOR'; label: string }
  | { optionKey: string; kind: 'CHEQUE_ENDOSADO'; label: string };

const CHEQUE_MEDIO_KEY = 'cheque-endosado';

let nextKey = 1;
let nextProvKey = 1;

/** Campo angosto para las filas de un renglón (medios de pago ya agregados). */
const compactFieldClass =
  'rounded border border-line bg-panel px-2 py-1 text-sm focus:border-accent-deep focus:outline-none';

interface DraftProvisional {
  tempKey: string;
  description: string;
  amount: number;
}

/** Comprobante real y NC provisoria (nueva o reutilizada) en una sola fila para la tabla. */
interface CancelableRow {
  key: string;
  fullNumber: string;
  description?: string;
  issueDate?: string;
  dueDate?: string;
  isCredit: boolean;
  isProvisional: boolean;
  isDraft: boolean;
  pending: number;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Carga de una orden de pago.
 *
 * Espejo del recibo de cobranza, con una diferencia visible: los comprobantes
 * llevan signo. Las notas de crédito se cargan en negativo y restan de lo que
 * hay que pagar, así que la columna "a imputar" puede tener números de los
 * dos signos y el neto es lo que realmente se transfiere.
 */
export function PaymentOrderNew() {
  const { role } = useAuth();
  const navigate = useNavigate();

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [methods, setMethods] = React.useState<PaymentMethod[]>([]);
  const [retentions, setRetentions] = React.useState<TaxRate[]>([]);
  const [walletChecks, setWalletChecks] = React.useState<ThirdPartyCheck[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [supplierId, setSupplierId] = React.useState('');
  const [paymentDate, setPaymentDate] = React.useState(todayLocal());
  const [notes, setNotes] = React.useState('');

  const [docs, setDocs] = React.useState<OpenPurchaseDoc[]>([]);
  const [credit, setCredit] = React.useState(0);
  const [availableProvisionals, setAvailableProvisionals] = React.useState<ProvisionalCreditNote[]>([]);
  const [draftProvisionals, setDraftProvisionals] = React.useState<DraftProvisional[]>([]);
  const [loadingSupplier, setLoadingSupplier] = React.useState(false);
  const [allocations, setAllocations] = React.useState<Record<string, string>>({});
  const [values, setValues] = React.useState<DraftValue[]>([]);

  const [selectedMedioKey, setSelectedMedioKey] = React.useState('');
  const [draftAmount, setDraftAmount] = React.useState(0);
  const [selectedCheckIds, setSelectedCheckIds] = React.useState<Set<string>>(new Set());
  const [checkPickerOpen, setCheckPickerOpen] = React.useState(false);

  const [addingProvisional, setAddingProvisional] = React.useState(false);
  const [provisionalDescription, setProvisionalDescription] = React.useState('');
  const [provisionalAmount, setProvisionalAmount] = React.useState(0);

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;
    Promise.all([fetchSuppliers(true), fetchPaymentMethods(true), fetchTaxRates(true), fetchChecks()])
      .then(([s, m, r, c]) => {
        if (cancelled) return;
        setSuppliers(s);
        setMethods(m.filter((method) => method.kind !== 'CARTERA_CHEQUES'));
        setRetentions(r.filter((rate) => rate.kind === 'RETENCION'));
        // Solo se endosan los que siguen en mano.
        setWalletChecks(c.filter((check) => check.status === 'EN_CARTERA'));
      })
      .catch((err) => !cancelled && setError(describePaymentOrderError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [role]);

  React.useEffect(() => {
    if (!supplierId) {
      setDocs([]);
      setCredit(0);
      setAvailableProvisionals([]);
      setDraftProvisionals([]);
      setAllocations({});
      return;
    }
    let cancelled = false;
    setLoadingSupplier(true);
    setAllocations({});
    setDraftProvisionals([]);
    Promise.all([
      fetchOpenPurchaseDocs(supplierId),
      fetchSupplierCredit(supplierId),
      fetchAvailableProvisionalCreditNotes(supplierId),
    ])
      .then(([d, cr, pcn]) => {
        if (cancelled) return;
        setDocs(d);
        setCredit(cr);
        setAvailableProvisionals(pcn);
      })
      .catch((err) => !cancelled && setError(describePaymentOrderError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoadingSupplier(false));
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  const totalValues = React.useMemo(
    () => round2(values.reduce((sum, v) => sum + (Number(v.amount) || 0), 0)),
    [values]
  );

  const totalApplied = React.useMemo(
    () => round2(Object.values(allocations).reduce((sum, a) => sum + (Number(a) || 0), 0)),
    [allocations]
  );

  const creditUsed = React.useMemo(
    () =>
      round2(
        values.filter((v) => v.kind === 'SALDO_A_FAVOR').reduce((s, v) => s + (Number(v.amount) || 0), 0)
      ),
    [values]
  );

  const cashTotal = React.useMemo(
    () => round2(values.filter((v) => isCashValue(v.kind)).reduce((s, v) => s + (Number(v.amount) || 0), 0)),
    [values]
  );

  // Cheques en cartera todavía no endosados en esta orden.
  const availableWalletChecks = React.useMemo(
    () => walletChecks.filter((c) => !values.some((v) => v.checkId === c.id)),
    [walletChecks, values]
  );

  // El desplegable de "Medios de pago" junta en una sola lista los medios
  // reales, retención, saldo a favor y — si hay algo en cartera — cheque
  // endosado. Elegir este último no agrega un valor directo: abre el modal
  // de la cartera, porque cada cheque tiene su propio importe fijo y puede
  // ser más de uno a la vez.
  const medioOptions = React.useMemo<MedioOption[]>(() => {
    const options: MedioOption[] = methods.map((m) => ({
      optionKey: `medio:${m.id}`,
      kind: 'MEDIO_PAGO',
      label: m.name,
      paymentMethodId: m.id,
    }));
    retentions.forEach((r) =>
      options.push({ optionKey: `retencion:${r.id}`, kind: 'RETENCION', label: r.name, taxRateId: r.id })
    );
    if (credit > 0) options.push({ optionKey: 'credito', kind: 'SALDO_A_FAVOR', label: 'Saldo a favor' });
    if (availableWalletChecks.length > 0) {
      options.push({ optionKey: CHEQUE_MEDIO_KEY, kind: 'CHEQUE_ENDOSADO', label: 'Cheque endosado (cartera)' });
    }
    return options;
  }, [methods, retentions, credit, availableWalletChecks.length]);

  // NC provisorias por descuento de pronto pago: las que ya existían (de una
  // orden anulada, con saldo libre) y las nuevas cargadas en esta pantalla.
  // Se muestran igual que un comprobante real en "Comprobantes a cancelar".
  const provisionalRows = React.useMemo<CancelableRow[]>(() => {
    const existing: CancelableRow[] = availableProvisionals.map((p) => ({
      key: p.id,
      fullNumber: p.fullNumber,
      description: p.description,
      isCredit: true,
      isProvisional: true,
      isDraft: false,
      pending: round2(p.amount - p.settledAmount),
    }));
    const draft: CancelableRow[] = draftProvisionals.map((p) => ({
      key: `draft:${p.tempKey}`,
      fullNumber: 'NC provisoria (nueva)',
      description: p.description,
      isCredit: true,
      isProvisional: true,
      isDraft: true,
      pending: p.amount,
    }));
    return [...existing, ...draft];
  }, [availableProvisionals, draftProvisionals]);

  // Lo que falta cubrir: lo imputado a comprobantes menos lo ya agregado.
  // Un cheque endosado no lo usa: se entrega por su importe completo.
  const suggestedRemaining = React.useMemo(
    () => Math.max(0, round2(totalApplied - totalValues)),
    [totalApplied, totalValues]
  );

  const selectedChecksSubtotal = React.useMemo(
    () =>
      round2(
        availableWalletChecks
          .filter((c) => selectedCheckIds.has(c.id))
          .reduce((sum, c) => sum + c.amount, 0)
      ),
    [availableWalletChecks, selectedCheckIds]
  );

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) {
    return <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">Cargando padrones…</div>;
  }

  function patchValue(key: number, patch: Partial<DraftValue>) {
    setValues((current) => current.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  }

  function handleSelectMedio(optionKey: string) {
    if (optionKey === CHEQUE_MEDIO_KEY) {
      // No agrega un valor directo: cada cheque trae su propio importe fijo.
      setCheckPickerOpen(true);
      return;
    }
    setSelectedMedioKey(optionKey);
    setDraftAmount(suggestedRemaining);
  }

  function handleAddMedio() {
    const option = medioOptions.find((o) => o.optionKey === selectedMedioKey);
    if (!option) return;

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

  function handleToggleCheck(checkId: string) {
    setSelectedCheckIds((current) => {
      const next = new Set(current);
      if (next.has(checkId)) next.delete(checkId);
      else next.add(checkId);
      return next;
    });
  }

  function handleEndorseSelected() {
    const toAdd = availableWalletChecks.filter((c) => selectedCheckIds.has(c.id));
    if (toAdd.length === 0) return;
    setValues((current) => [
      ...current,
      ...toAdd.map((c) => ({
        key: nextKey++,
        kind: 'CHEQUE_ENDOSADO' as const,
        amount: c.amount,
        checkId: c.id,
      })),
    ]);
    setSelectedCheckIds(new Set());
    setCheckPickerOpen(false);
  }

  function closeCheckPicker() {
    setCheckPickerOpen(false);
    setSelectedCheckIds(new Set());
  }

  function handleAutoAllocate() {
    const auto = autoAllocate(docs, totalValues);
    setAllocations(Object.fromEntries(Object.entries(auto).map(([id, a]) => [id, String(a)])));
    setError(null);
  }

  function handleAddProvisional() {
    if (!provisionalDescription.trim() || provisionalAmount <= 0) return;
    const tempKey = `prov-${nextProvKey++}`;
    setDraftProvisionals((current) => [
      ...current,
      { tempKey, description: provisionalDescription.trim(), amount: round2(provisionalAmount) },
    ]);
    setAllocations((current) => ({ ...current, [`draft:${tempKey}`]: String(-round2(provisionalAmount)) }));
    setAddingProvisional(false);
    setProvisionalDescription('');
    setProvisionalAmount(0);
  }

  function handleRemoveDraftProvisional(tempKey: string) {
    setDraftProvisionals((current) => current.filter((p) => p.tempKey !== tempKey));
    setAllocations((current) => {
      const next = { ...current };
      delete next[`draft:${tempKey}`];
      return next;
    });
  }

  const problems: string[] = [];
  if (!supplierId) problems.push('Elegí un proveedor.');
  if (values.length === 0 && Object.values(allocations).every((a) => !Number(a))) {
    problems.push('Cargá comprobantes o valores.');
  }
  if (totalApplied < 0) {
    problems.push('Las notas de crédito superan a las facturas: no hay nada que pagar.');
  }
  if (totalApplied > totalValues) {
    problems.push(
      `Estás imputando $ ${formatMoney(totalApplied)} y la orden paga $ ${formatMoney(totalValues)}.`
    );
  }
  if (creditUsed > credit) {
    problems.push(
      `Tenés $ ${formatMoney(credit)} a favor y estás usando $ ${formatMoney(creditUsed)}.`
    );
  }
  values.forEach((v) => {
    if (Number(v.amount) <= 0) problems.push('Hay un valor con importe en cero.');
    if (v.kind === 'CHEQUE_ENDOSADO' && !v.checkId) problems.push('Elegí el cheque a endosar.');
  });
  for (const doc of docs) {
    const amount = Number(allocations[doc.id]) || 0;
    if (amount === 0) continue;
    const expected = signOfDoc(doc.docType);
    if (Math.sign(amount) !== expected) {
      problems.push(
        expected < 0
          ? `${doc.fullNumber} es una nota de crédito: va en negativo.`
          : `${doc.fullNumber} va en positivo.`
      );
    }
    if (Math.abs(amount) > doc.pending) {
      problems.push(`${doc.fullNumber} tiene $ ${formatMoney(doc.pending)} pendientes.`);
    }
  }
  for (const row of provisionalRows) {
    const amount = Number(allocations[row.key]) || 0;
    if (amount === 0) continue;
    if (amount > 0) problems.push(`${row.fullNumber} resta: cargala en negativo.`);
    if (Math.abs(amount) > row.pending) {
      problems.push(`${row.fullNumber} tiene $ ${formatMoney(row.pending)} disponibles.`);
    }
  }

  const onAccount = round2(totalValues - totalApplied);
  const canSave = problems.length === 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const invoiceAllocations: PaymentAllocationInput[] = Object.entries(allocations)
        .filter(([key]) => !key.startsWith('draft:') && !availableProvisionals.some((p) => p.id === key))
        .map(([purchaseInvoiceId, amount]) => ({ purchaseInvoiceId, amount: Number(amount) || 0 }))
        .filter((a) => a.amount !== 0);

      const existingProvisionalAllocations: PaymentAllocationInput[] = availableProvisionals
        .map((p) => ({ provisionalCreditNoteId: p.id, amount: Number(allocations[p.id]) || 0 }))
        .filter((a) => a.amount !== 0);

      const usedDrafts = draftProvisionals.filter(
        (p) => (Number(allocations[`draft:${p.tempKey}`]) || 0) !== 0
      );
      const draftAllocations: PaymentAllocationInput[] = usedDrafts.map((p) => ({
        provisionalCreditNoteTempKey: p.tempKey,
        amount: Number(allocations[`draft:${p.tempKey}`]) || 0,
      }));
      const newProvisionalCreditNotes: NewProvisionalCreditNoteInput[] = usedDrafts.map((p) => ({
        tempKey: p.tempKey,
        description: p.description,
        amount: p.amount,
      }));

      const saved = await savePaymentOrder(
        { supplierId, paymentDate, notes },
        [...invoiceAllocations, ...existingProvisionalAllocations, ...draftAllocations],
        values.map(({ key: _key, ...value }) => ({ ...value, amount: Number(value.amount) || 0 })),
        newProvisionalCreditNotes
      );
      navigate('/pagos');
    } catch (err) {
      setError(describePaymentOrderError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Nueva orden de pago"
        subtitle="Qué comprobantes se cancelan y con qué se pagan."
        actions={
          <>
            <Link to="/pagos">
              <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
            </Link>
            <Button onClick={handleSave} disabled={!canSave}>
              <Save size={16} /> {saving ? 'Guardando…' : 'Registrar orden'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="mb-6 p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className={cn(labelClass, 'sm:col-span-2')}>
            Proveedor *
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className={cn(inputClass, 'bg-panel', !supplierId && 'field-required')}
            >
              <option value="">Elegí un proveedor</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.taxId ? ` — ${formatCuit(s.taxId)}` : ''}
                </option>
              ))}
            </select>
            {supplierId && credit > 0 && (
              <span className="mt-1 block text-[10px] font-normal normal-case text-state-done">
                Tenés $ {formatMoney(credit)} a favor con este proveedor.
              </span>
            )}
          </label>

          <label className={labelClass}>
            Fecha *
            <input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      </Panel>

      {/* ── Comprobantes ────────────────────────────────────────────── */}
      <Panel className="mb-6 p-5">
        <SectionHeader
          title="Comprobantes a cancelar"
          actions={
            <>
              {docs.length > 0 && (
                <Button type="button" variant="ghost" onClick={handleAutoAllocate} className="px-3">
                  <Wand2 size={15} /> Repartir automático
                </Button>
              )}
              {supplierId && !addingProvisional && (
                <Button type="button" variant="ghost" onClick={() => setAddingProvisional(true)} className="px-3">
                  <FileMinus size={15} /> NC provisoria
                </Button>
              )}
            </>
          }
        />

        {!supplierId && <p className="text-sm text-text-soft">Elegí un proveedor para ver sus comprobantes pendientes.</p>}
        {supplierId && loadingSupplier && <p className="text-sm text-text-soft">Cargando comprobantes…</p>}
        {supplierId && !loadingSupplier && docs.length === 0 && provisionalRows.length === 0 && !addingProvisional && (
          <p className="text-sm text-text-soft">
            Este proveedor no tiene comprobantes pendientes. Podés pagar igual: queda a cuenta.
          </p>
        )}

        {addingProvisional && (
          <div className="mb-4 flex flex-col gap-2 border border-line bg-panel-alt p-3 sm:flex-row sm:items-end">
            <label className={cn(labelClass, 'sm:flex-1')}>
              Motivo
              <input
                value={provisionalDescription}
                onChange={(e) => setProvisionalDescription(e.target.value)}
                placeholder="Descuento 5% pronto pago FC A 0003-00012345"
                className={cn(inputClass, !provisionalDescription.trim() && 'field-required')}
              />
            </label>
            <label className={cn(labelClass, 'sm:w-40')}>
              Importe
              <input
                type="number" step="0.01" min="0"
                value={provisionalAmount || ''}
                onChange={(e) => setProvisionalAmount(Number(e.target.value))}
                className={cn(inputClass, 'font-mono', provisionalAmount <= 0 && 'field-required')}
              />
            </label>
            <div className="flex gap-2 sm:mb-0">
              <Button
                type="button"
                onClick={handleAddProvisional}
                disabled={!provisionalDescription.trim() || provisionalAmount <= 0}
                className="px-3"
              >
                <Plus size={15} /> Agregar
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAddingProvisional(false)} className="px-3">
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {(docs.length > 0 || provisionalRows.length > 0) && (
          <div className="overflow-x-auto overflow-y-hidden rounded-md border border-line">
            <table className="table-stack w-full text-left text-[13px]">
              <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <tr>
                  <th className="px-3 py-1 w-44">Comprobante</th>
                  <th className="px-3 py-1 w-28">Fecha</th>
                  <th className="px-3 py-1 w-28">Vence</th>
                  <th className="px-3 py-1 w-32 text-right">Pendiente</th>
                  <th className="px-3 py-1 w-36 text-right">A imputar</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc, idx) => {
                  const amount = Number(allocations[doc.id]) || 0;
                  const isCredit = doc.docType === 'NOTA_CREDITO';
                  const wrongSign = amount !== 0 && Math.sign(amount) !== signOfDoc(doc.docType);
                  const excess = Math.abs(amount) > doc.pending;
                  return (
                    <tr key={doc.id} className={cn('h-10 border-b border-line', idx % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
                      <td data-primary className="px-3 py-1">
                        <span className={cn('text-[10px] font-semibold uppercase tracking-[0.06em]', isCredit ? 'text-state-done' : 'text-text-soft')}>
                          {PURCHASE_DOC_TYPE_SHORT[doc.docType]}
                        </span>{' '}
                        <span className="font-mono font-semibold">{doc.letter} {doc.fullNumber}</span>
                      </td>
                      <td data-label="Fecha" className="px-3 py-1 text-text-soft">{formatDate(doc.issueDate)}</td>
                      <td data-label="Vence" className="px-3 py-1">
                        {isCredit ? (
                          <span className="text-text-faint">—</span>
                        ) : (
                          <span className={cn(doc.dueDate < todayLocal() ? 'font-semibold text-danger' : 'text-text-soft')}>
                            {formatDate(doc.dueDate)}
                          </span>
                        )}
                      </td>
                      <td data-label="Pendiente" className="px-3 py-1 text-right font-semibold">
                        {isCredit ? '−' : ''}$ {formatMoney(doc.pending)}
                      </td>
                      <td data-label="A imputar" className="px-1 py-1">
                        <input
                          type="number" step="0.01"
                          value={allocations[doc.id] ?? ''}
                          onChange={(e) => setAllocations((c) => ({ ...c, [doc.id]: e.target.value }))}
                          placeholder={isCredit ? '−0,00' : '0,00'}
                          className={cn(
                            'w-full rounded border border-line bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none',
                            (wrongSign || excess) && 'border-danger bg-danger-soft'
                          )}
                        />
                      </td>
                    </tr>
                  );
                })}
                {provisionalRows.map((row, idx) => {
                  const amount = Number(allocations[row.key]) || 0;
                  const wrongSign = amount !== 0 && amount > 0;
                  const excess = Math.abs(amount) > row.pending;
                  return (
                    <tr
                      key={row.key}
                      className={cn(
                        'h-10 border-b border-line',
                        (docs.length + idx) % 2 === 0 ? 'bg-panel-alt' : 'bg-panel'
                      )}
                    >
                      <td data-primary className="px-3 py-1">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-state-done">NC</span>{' '}
                        <span className="font-mono font-semibold">{row.fullNumber}</span>
                        {row.description && <p className="text-[10px] text-text-soft">{row.description}</p>}
                      </td>
                      <td data-label="Fecha" className="px-3 py-1 text-text-faint">—</td>
                      <td data-label="Vence" className="px-3 py-1 text-text-faint">—</td>
                      <td data-label="Pendiente" className="px-3 py-1 text-right font-semibold">
                        −$ {formatMoney(row.pending)}
                      </td>
                      <td data-label="A imputar" className="px-1 py-1">
                        <div className="flex items-center gap-1">
                          <input
                            type="number" step="0.01"
                            value={allocations[row.key] ?? ''}
                            onChange={(e) => setAllocations((c) => ({ ...c, [row.key]: e.target.value }))}
                            placeholder="−0,00"
                            className={cn(
                              'w-full rounded border border-line bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none',
                              (wrongSign || excess) && 'border-danger bg-danger-soft'
                            )}
                          />
                          {row.isDraft && (
                            <button
                              type="button"
                              onClick={() => handleRemoveDraftProvisional(row.key.replace(/^draft:/, ''))}
                              aria-label="Quitar NC provisoria"
                              className="shrink-0 text-text-soft transition-colors hover:text-danger"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── Cheques en cartera para endosar: modal, solo al elegir el medio ── */}
      {checkPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Panel className="max-h-[85vh] w-full max-w-2xl overflow-y-auto p-5">
          <SectionHeader
            title="Cheques en cartera para endosar"
            actions={
              <button type="button" onClick={closeCheckPicker} className="text-text-soft hover:text-text">
                <X size={18} />
              </button>
            }
          />
          <div className="overflow-x-auto overflow-y-hidden rounded-md border border-line">
            <table className="table-stack w-full text-left text-[13px]">
              <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <tr>
                  <th className="w-8 px-3 py-1"></th>
                  <th className="px-3 py-1">Número</th>
                  <th className="px-3 py-1">Banco</th>
                  <th className="px-3 py-1 w-28">Vence</th>
                  <th className="px-3 py-1 w-32 text-right">Importe</th>
                </tr>
              </thead>
              <tbody>
                {availableWalletChecks.map((c, idx) => (
                  <tr
                    key={c.id}
                    className={cn('h-10 cursor-pointer border-b border-line', idx % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}
                    onClick={() => handleToggleCheck(c.id)}
                  >
                    <td className="px-3 py-1">
                      <input
                        type="checkbox"
                        checked={selectedCheckIds.has(c.id)}
                        onChange={() => handleToggleCheck(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 accent-accent-deep"
                      />
                    </td>
                    <td data-primary className="px-3 py-1 font-mono font-semibold">{c.number}</td>
                    <td data-label="Banco" className="px-3 py-1">{c.bankName}</td>
                    <td data-label="Vence" className="px-3 py-1 text-text-soft">{formatDate(c.dueDate)}</td>
                    <td data-label="Importe" className="px-3 py-1 text-right font-mono">$ {formatMoney(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-text-soft">Subtotal seleccionado</dt>
                <dd className="font-mono font-semibold text-text">$ {formatMoney(selectedChecksSubtotal)}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-text-soft">
                  {selectedChecksSubtotal <= suggestedRemaining ? 'Saldo restante' : 'Cubre de más'}
                </dt>
                <dd className="font-mono font-semibold text-text">
                  $ {formatMoney(Math.abs(round2(suggestedRemaining - selectedChecksSubtotal)))}
                </dd>
              </div>
            </dl>
            <div className="flex gap-2">
              <Button variant="ghost" type="button" onClick={closeCheckPicker} className="px-3">
                Cancelar
              </Button>
              <Button
                type="button"
                onClick={handleEndorseSelected}
                disabled={selectedCheckIds.size === 0}
                className="px-3"
              >
                <FileCheck size={15} /> Endosar {selectedCheckIds.size > 0 ? `${selectedCheckIds.size} ` : ''}
                {selectedCheckIds.size === 1 ? 'cheque' : 'cheques'}
              </Button>
            </div>
          </div>
          </Panel>
        </div>
      )}

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

          {selectedMedioKey && (
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

          <Button type="button" onClick={handleAddMedio} disabled={!selectedMedioKey} className="px-3 sm:mb-0">
            <Plus size={15} /> Agregar
          </Button>
        </div>

        {values.length === 0 && <p className="text-sm text-text-soft">Sin valores cargados.</p>}

        <ul className="space-y-2">
          {values.map((value) => (
            <li
              key={value.key}
              className="flex flex-wrap items-center gap-2 border border-line bg-panel-alt px-3 py-2"
            >
              <span
                title={PAYMENT_VALUE_HELP[value.kind]}
                className="w-32 shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-deep"
              >
                {PAYMENT_VALUE_LABELS[value.kind]}
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

              {value.kind === 'CHEQUE_ENDOSADO' && (
                <select
                  value={value.checkId ?? ''}
                  onChange={(e) => {
                    const check = walletChecks.find((c) => c.id === e.target.value);
                    // El importe lo fija el cheque: se endosa completo.
                    patchValue(value.key, { checkId: e.target.value, amount: check?.amount ?? 0 });
                  }}
                  className={cn(compactFieldClass, 'bg-panel', !value.checkId && 'field-required')}
                >
                  <option value="">Elegí un cheque</option>
                  {walletChecks
                    .filter((c) => c.id === value.checkId || !values.some((v) => v.checkId === c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.number} — {c.bankName} — vence {formatDate(c.dueDate)}
                      </option>
                    ))}
                </select>
              )}

              <input
                type="number" step="0.01" min="0"
                value={value.amount || ''}
                onChange={(e) => patchValue(value.key, { amount: Number(e.target.value) })}
                disabled={value.kind === 'CHEQUE_ENDOSADO'}
                className={cn(
                  compactFieldClass,
                  'ml-auto w-28 text-right font-mono',
                  Number(value.amount) <= 0 && 'field-required',
                  value.kind === 'CHEQUE_ENDOSADO' && 'bg-panel-head text-text-soft'
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

      {/* ── El cuadre ───────────────────────────────────────────────── */}
      <Panel className="mb-10 p-5">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <dl className="space-y-1 text-[13px]">
            <Row label="Total de valores" value={totalValues} />
            <Row label="Imputado (neto)" value={totalApplied} />
            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
                {onAccount >= 0 ? 'Queda a cuenta' : 'Falta pagar'}
              </dt>
              <dd className={cn('font-display text-2xl font-medium', onAccount < 0 ? 'text-danger' : 'text-text')}>
                $ {formatMoney(Math.abs(onAccount))}
              </dd>
            </div>
            {cashTotal !== totalValues && (
              <p className="pt-2 text-[10px] text-text-soft">
                Sale de caja $ {formatMoney(cashTotal)}. El resto son retenciones o saldo a favor,
                que cancelan comprobante pero no son plata que sale.
              </p>
            )}
          </dl>

          <div>
            {problems.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-state-done">
                <Check size={16} /> La orden cierra. Lista para registrar.
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
            <Save size={16} /> {saving ? 'Guardando…' : 'Registrar orden'}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-text-soft">{label}</dt>
      <dd className="font-mono text-text">$ {formatMoney(value)}</dd>
    </div>
  );
}
