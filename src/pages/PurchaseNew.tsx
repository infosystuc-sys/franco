import React from 'react';
import { Plus, Trash2, Save, XCircle, AlertTriangle, Check, Package, Boxes } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { cn, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { PurchaseArticlePicker } from '@/src/components/PurchaseArticlePicker';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { fetchExpenseConcepts, type ExpenseConcept } from '@/src/lib/expenseConcepts';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchTaxRates, type TaxRate } from '@/src/lib/taxRates';
import {
  computePurchaseTotals,
  describePurchaseError,
  proposeDueDate,
  PURCHASE_DOC_TYPE_LABELS,
  PURCHASE_DOC_TYPES,
  PURCHASE_LETTERS,
  savePurchaseInvoice,
  suggestedTaxAmount,
  type PurchaseDocType,
  type PurchaseFootTax,
  type PurchaseKind,
  type PurchaseLetter,
  type PurchaseLine,
} from '@/src/lib/purchases';

const EMPTY_LINE: PurchaseLine = {
  articleId: null,
  conceptId: null,
  code: '',
  description: '',
  quantity: 1,
  unitPrice: 0,
  discountPercent: 0,
  vatRateId: '',
};

/**
 * Carga de un comprobante de compra, en sus dos formas.
 *
 * El comprobante ya existe en papel: acá se transcribe. Por eso el número no
 * se genera y por eso los importes del pie quedan editables — tienen que
 * poder cerrar exacto con lo que el proveedor imprimió, aunque él haya
 * redondeado distinto.
 *
 * La diferencia entre las dos formas es el cuerpo y sus consecuencias: los
 * renglones de artículo mueven stock y actualizan el precio de compra; los de
 * concepto no tocan nada fuera del comprobante.
 */
export function PurchaseNew() {
  const { role } = useAuth();
  const { kind: kindParam } = useParams();
  const navigate = useNavigate();

  const kind: PurchaseKind = kindParam === 'articulos' ? 'ARTICULOS' : 'CONCEPTOS';
  const isArticles = kind === 'ARTICULOS';

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [concepts, setConcepts] = React.useState<ExpenseConcept[]>([]);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [rates, setRates] = React.useState<TaxRate[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showPicker, setShowPicker] = React.useState(false);

  // ── Encabezado
  const [supplierId, setSupplierId] = React.useState('');
  const [docType, setDocType] = React.useState<PurchaseDocType>('FACTURA');
  const [letter, setLetter] = React.useState<PurchaseLetter>('A');
  const [salesPoint, setSalesPoint] = React.useState('');
  const [number, setNumber] = React.useState('');
  const [issueDate, setIssueDate] = React.useState(todayLocal());
  const [receivedDate, setReceivedDate] = React.useState(todayLocal());
  const [dueDate, setDueDate] = React.useState('');
  const [dueDateTouched, setDueDateTouched] = React.useState(false);
  // Solo se pregunta en NC y ND: la factura de artículos siempre mueve stock.
  const [movesStock, setMovesStock] = React.useState(false);

  // ── Cuerpo y pie
  const [lines, setLines] = React.useState<PurchaseLine[]>([]);
  const [generalDiscount, setGeneralDiscount] = React.useState('0');
  const [footTaxes, setFootTaxes] = React.useState<PurchaseFootTax[]>([]);
  const [notes, setNotes] = React.useState('');
  const [declaredTotal, setDeclaredTotal] = React.useState('');

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;

    Promise.all([
      fetchSuppliers(true),
      fetchTaxRates(true),
      isArticles ? fetchArticles(false) : Promise.resolve([] as Article[]),
      isArticles ? Promise.resolve([] as ExpenseConcept[]) : fetchExpenseConcepts(true),
    ])
      .then(([s, r, a, c]) => {
        if (cancelled) return;
        setSuppliers(s);
        setRates(r);
        setArticles(a);
        setConcepts(c);
        // El IVA más común arranca preseleccionado: en la mayoría de las
        // facturas todos los renglones van al 21%.
        const general = r.find((rate) => rate.kind === 'IVA' && rate.rate === 21);
        // En conceptos se arranca con un renglón en blanco listo para tipear.
        // En artículos no: el renglón nace de elegir uno del catálogo.
        if (!isArticles) setLines([{ ...EMPTY_LINE, vatRateId: general?.id ?? '' }]);
      })
      .catch((err) => !cancelled && setError(describePurchaseError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [role, isArticles]);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
  const vatRates = React.useMemo(() => rates.filter((r) => r.kind === 'IVA'), [rates]);
  const footRates = React.useMemo(
    () => rates.filter((r) => r.kind === 'PERCEPCION' || r.kind === 'IMPUESTO_INTERNO'),
    [rates]
  );

  // La NC suele ser devolución, así que arranca marcada; la ND casi nunca
  // trae mercadería, así que arranca desmarcada. La factura no pregunta.
  React.useEffect(() => {
    if (!isArticles) return;
    setMovesStock(docType === 'NOTA_CREDITO');
  }, [docType, isArticles]);

  React.useEffect(() => {
    if (dueDateTouched || !supplier || !issueDate) return;
    setDueDate(proposeDueDate(issueDate, supplier.paymentTermsDays));
  }, [supplier, issueDate, dueDateTouched]);

  const totals = React.useMemo(
    () => computePurchaseTotals(lines, footTaxes, Number(generalDiscount) || 0, vatRates),
    [lines, footTaxes, generalDiscount, vatRates]
  );

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (kindParam !== 'articulos' && kindParam !== 'conceptos') {
    return <Navigate to="/compras" replace />;
  }

  if (loading) {
    return <div className="mx-auto max-w-6xl p-8 text-center text-text-soft">Cargando padrones…</div>;
  }

  function patchLine(index: number, patch: Partial<PurchaseLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function defaultVatRateId(): string {
    return (vatRates.find((r) => r.rate === 21) ?? vatRates[0])?.id ?? '';
  }

  function addConceptLine() {
    setLines((current) => [...current, { ...EMPTY_LINE, vatRateId: defaultVatRateId() }]);
  }

  function addArticle(article: Article) {
    setLines((current) => [
      ...current,
      {
        ...EMPTY_LINE,
        articleId: article.id,
        code: article.code,
        description: article.description,
        // Se propone lo que se venía pagando; el precio real sale del papel.
        unitPrice: article.purchasePrice ?? 0,
        vatRateId: defaultVatRateId(),
      },
    ]);
    setShowPicker(false);
  }

  function addFootTax(taxRateId: string) {
    if (!taxRateId || footTaxes.some((tax) => tax.taxRateId === taxRateId)) return;
    const rate = footRates.find((r) => r.id === taxRateId);
    if (!rate) return;
    setFootTaxes((current) => [...current, { taxRateId, amount: suggestedTaxAmount(rate, totals) }]);
  }

  const declared = Number(declaredTotal);
  const declaredDiff =
    declaredTotal.trim() === '' || !Number.isFinite(declared)
      ? null
      : Math.round((declared - totals.total) * 100) / 100;

  const missingVat = lines.some((line) => !line.vatRateId);
  const missingDescription = lines.some((line) => line.description.trim() === '');
  const canSave =
    !!supplierId &&
    salesPoint.trim() !== '' &&
    Number(salesPoint) >= 0 &&
    Number(number) > 0 &&
    !!issueDate &&
    !!dueDate &&
    lines.length > 0 &&
    !missingVat &&
    !missingDescription &&
    totals.total > 0 &&
    !saving;

  const stockMoves = isArticles && (docType === 'FACTURA' || movesStock);

  async function handleSave() {
    if (!canSave || !supplier) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await savePurchaseInvoice(
        {
          kind,
          docType,
          letter,
          salesPoint: Number(salesPoint),
          number: Number(number),
          supplierId,
          issueDate,
          receivedDate,
          dueDate,
          paymentTermsDays: supplier.paymentTermsDays,
          generalDiscountPercent: Number(generalDiscount) || 0,
          movesStock,
          notes,
        },
        lines,
        footTaxes
      );
      navigate(`/compra/${saved.id}`);
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={isArticles ? 'Compra de artículos' : 'Compra de conceptos'}
        meta={
          <span className="inline-flex items-center gap-1.5 border border-line-strong bg-panel px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
            {isArticles ? <Boxes size={14} /> : <Package size={14} />}
            {isArticles ? 'Mueve stock' : 'Sin stock'}
          </span>
        }
        subtitle={
          isArticles
            ? 'Repuestos del catálogo. Repone stock y actualiza el precio de compra.'
            : 'Gastos sin artículos ni stock asociado: fletes, servicios, honorarios.'
        }
        actions={
          <>
            <Link to="/compras">
              <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
            </Link>
            <Button onClick={handleSave} disabled={!canSave}>
              <Save size={16} /> {saving ? 'Guardando…' : 'Guardar comprobante'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* ── ENCABEZADO ─────────────────────────────────────────────── */}
      <Panel className="mb-6 p-5">
        <SectionHeader title="Encabezado" />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
          <label className={cn(labelClass, 'sm:col-span-3')}>
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
            {supplier && (
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                {TAX_CONDITION_LABELS[supplier.taxCondition]} · plazo {supplier.paymentTermsDays} días
              </span>
            )}
            {suppliers.length === 0 && (
              <span className="mt-1 block text-[10px] font-normal normal-case text-danger">
                No hay proveedores activos. Cargá uno en Proveedores.
              </span>
            )}
          </label>

          <label className={cn(labelClass, 'sm:col-span-2')}>
            Comprobante
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as PurchaseDocType)}
              className={cn(inputClass, 'bg-panel')}
            >
              {PURCHASE_DOC_TYPES.map((type) => (
                <option key={type} value={type}>{PURCHASE_DOC_TYPE_LABELS[type]}</option>
              ))}
            </select>
          </label>

          <label className={labelClass}>
            Letra
            <select
              value={letter}
              onChange={(e) => setLetter(e.target.value as PurchaseLetter)}
              className={cn(inputClass, 'bg-panel font-mono')}
            >
              {PURCHASE_LETTERS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>

          <label className={cn(labelClass, 'sm:col-span-2')}>
            Punto de venta *
            <input
              type="number" min="0" max="99999"
              value={salesPoint}
              onChange={(e) => setSalesPoint(e.target.value)}
              placeholder="3"
              className={cn(inputClass, 'font-mono', salesPoint.trim() === '' && 'field-required')}
            />
          </label>

          <label className={cn(labelClass, 'sm:col-span-2')}>
            Número *
            <input
              type="number" min="1"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="12345"
              className={cn(inputClass, 'font-mono', Number(number) <= 0 && 'field-required')}
            />
          </label>

          <div className={cn(labelClass, 'sm:col-span-2 flex flex-col justify-end')}>
            <span className="text-text-faint">Quedará como</span>
            <span className="mt-1 border border-line bg-panel-alt px-3 py-2 font-mono text-sm normal-case text-text">
              {letter} {String(Number(salesPoint) || 0).padStart(4, '0')}-
              {String(Number(number) || 0).padStart(8, '0')}
            </span>
          </div>

          <label className={cn(labelClass, 'sm:col-span-2')}>
            Fecha del comprobante *
            <input
              type="date" value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              className={cn(inputClass, !issueDate && 'field-required')}
            />
          </label>

          <label className={cn(labelClass, 'sm:col-span-2')}>
            Fecha de recepción
            <input
              type="date" value={receivedDate}
              onChange={(e) => setReceivedDate(e.target.value)}
              className={inputClass}
            />
          </label>

          <label className={cn(labelClass, 'sm:col-span-2')}>
            Vencimiento *
            <input
              type="date" value={dueDate}
              onChange={(e) => {
                setDueDate(e.target.value);
                setDueDateTouched(true);
              }}
              className={cn(inputClass, !dueDate && 'field-required')}
            />
            <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
              {dueDateTouched
                ? 'Cargado a mano.'
                : supplier
                  ? `Propuesto por el plazo del proveedor (${supplier.paymentTermsDays} días).`
                  : 'Se propone al elegir el proveedor.'}
            </span>
          </label>
        </div>

        {/* El tilde de stock solo aparece donde hay una decisión real que
            tomar: en la factura no la hay, la mercadería entró. */}
        {isArticles && docType !== 'FACTURA' && (
          <label className="mt-4 flex cursor-pointer items-start gap-2 border border-line bg-panel-alt p-3 text-sm">
            <input
              type="checkbox"
              checked={movesStock}
              onChange={(e) => setMovesStock(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-accent-deep"
            />
            <span>
              <span className="font-semibold text-text">
                {docType === 'NOTA_CREDITO' ? 'Devuelve mercadería' : 'Ingresa mercadería'}
              </span>
              <span className="mt-0.5 block text-xs text-text-soft">
                {docType === 'NOTA_CREDITO'
                  ? 'Marcado, el stock se descuenta. Sin marcar, la nota de crédito es solo un ajuste de precio y no toca el inventario.'
                  : 'Marcado, el stock se suma. Una nota de débito suele ser un cargo posterior sin mercadería, por eso arranca sin marcar.'}
              </span>
            </span>
          </label>
        )}
      </Panel>

      {/* ── CUERPO ─────────────────────────────────────────────────── */}
      <Panel className="mb-6 p-5">
        <SectionHeader
          title={isArticles ? 'Artículos' : 'Conceptos'}
          actions={
            isArticles ? (
              <Button type="button" onClick={() => setShowPicker(true)} className="px-3">
                <Package size={16} /> Agregar artículo
              </Button>
            ) : (
              <Button type="button" variant="ghost" onClick={addConceptLine} className="px-3">
                <Plus size={16} /> Agregar renglón
              </Button>
            )
          }
        />

        <div className="overflow-x-auto border border-line">
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="px-2 py-1 w-44">{isArticles ? 'Código' : 'Concepto'}</th>
                <th className="px-2 py-1">{isArticles ? 'Descripción' : 'Detalle'}</th>
                <th className="px-2 py-1 w-20 text-right">Cant.</th>
                <th className="px-2 py-1 w-28 text-right">P. unitario</th>
                <th className="px-2 py-1 w-20 text-right">Bonif. %</th>
                <th className="px-2 py-1 w-32">IVA</th>
                <th className="px-2 py-1 w-28 text-right">Neto</th>
                <th className="px-2 py-1 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-text-soft">
                    {isArticles
                      ? 'Sin artículos. Agregalos desde el catálogo con el botón de arriba.'
                      : 'Sin renglones cargados.'}
                  </td>
                </tr>
              )}

              {lines.map((line, idx) => {
                const net = line.quantity * line.unitPrice * (1 - (line.discountPercent || 0) / 100);
                return (
                  <tr key={idx} className={cn('h-9 border-b border-line', idx % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
                    {isArticles ? (
                      <>
                        <td data-primary className="px-2 py-1 font-mono font-semibold text-text-soft">
                          <span className="inline-flex items-center gap-1.5">
                            <Package size={12} className="text-accent-deep" />
                            {line.code}
                          </span>
                        </td>
                        <td data-label="Descripción" className="px-2 py-1">{line.description}</td>
                      </>
                    ) : (
                      <>
                        <td data-label="Concepto" className="px-1 py-1">
                          <select
                            value={line.conceptId ?? ''}
                            onChange={(e) => patchLine(idx, { conceptId: e.target.value || null })}
                            className="w-full bg-transparent px-1 py-1 text-[12px] focus:outline-none"
                          >
                            <option value="">— texto libre —</option>
                            {concepts.map((concept) => (
                              <option key={concept.id} value={concept.id}>{concept.name}</option>
                            ))}
                          </select>
                        </td>
                        <td data-label="Detalle" className="px-1 py-1">
                          <input
                            value={line.description}
                            onChange={(e) => patchLine(idx, { description: e.target.value })}
                            placeholder="Detalle del gasto"
                            className={cn(
                              'w-full bg-transparent px-2 py-1',
                              line.description.trim() === '' && 'bg-danger-soft'
                            )}
                          />
                        </td>
                      </>
                    )}

                    <td data-label="Cant." className="px-1 py-1">
                      <input
                        type="number" step="0.01" min="0"
                        value={line.quantity}
                        onChange={(e) => patchLine(idx, { quantity: Number(e.target.value) })}
                        className="w-full bg-transparent px-2 py-1 text-right"
                      />
                    </td>
                    <td data-label="P. unitario" className="px-1 py-1">
                      <input
                        type="number" step="0.01" min="0"
                        value={line.unitPrice}
                        onChange={(e) => patchLine(idx, { unitPrice: Number(e.target.value) })}
                        className="w-full bg-transparent px-2 py-1 text-right"
                      />
                    </td>
                    <td data-label="Bonif. %" className="px-1 py-1">
                      <input
                        type="number" step="0.01" min="0" max="100"
                        value={line.discountPercent}
                        onChange={(e) => patchLine(idx, { discountPercent: Number(e.target.value) })}
                        className="w-full bg-transparent px-2 py-1 text-right"
                      />
                    </td>
                    <td data-label="IVA" className="px-1 py-1">
                      <select
                        value={line.vatRateId}
                        onChange={(e) => patchLine(idx, { vatRateId: e.target.value })}
                        className={cn(
                          'w-full bg-transparent px-1 py-1 text-[12px] focus:outline-none',
                          !line.vatRateId && 'bg-danger-soft'
                        )}
                      >
                        <option value="">— elegir —</option>
                        {vatRates.map((rate) => (
                          <option key={rate.id} value={rate.id}>{rate.name}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Neto" className="px-2 py-1 text-right font-semibold">
                      $ {formatMoney(net)}
                    </td>
                    <td className="px-1 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => setLines((current) => current.filter((_, i) => i !== idx))}
                        aria-label="Quitar renglón"
                        className="text-text-soft transition-colors hover:text-danger"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {(missingVat || missingDescription) && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-danger">
            <AlertTriangle size={14} />
            {missingDescription ? 'Hay renglones sin detalle.' : 'Hay renglones sin alícuota de IVA.'}
          </p>
        )}

        {stockMoves && lines.length > 0 && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-text-soft">
            <Boxes size={14} className="mt-0.5 shrink-0 text-accent-deep" />
            Al guardar, el stock de estos artículos va a{' '}
            {docType === 'NOTA_CREDITO' ? 'descontarse' : 'reponerse'}
            {docType === 'FACTURA' &&
              ', y el precio de compra del proveedor se va a actualizar con el neto de cada renglón'}
            .
          </p>
        )}
      </Panel>

      {/* ── PIE ────────────────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel className="p-5">
          <SectionHeader title="Impuestos del pie" />

          {footRates.length === 0 ? (
            <p className="text-xs text-text-soft">
              No hay percepciones cargadas todavía.{' '}
              <Link to="/alicuotas" className="text-accent-deep underline">Cargalas en Alícuotas</Link>{' '}
              copiándolas de una factura que ya hayas recibido.
            </p>
          ) : (
            <>
              <select
                value=""
                onChange={(e) => addFootTax(e.target.value)}
                className={cn(inputClass, 'mt-0 bg-panel')}
              >
                <option value="">Agregar percepción o impuesto…</option>
                {footRates
                  .filter((rate) => !footTaxes.some((tax) => tax.taxRateId === rate.id))
                  .map((rate) => (
                    <option key={rate.id} value={rate.id}>
                      {rate.name} ({rate.rate}% s/ {rate.base === 'TOTAL' ? 'total' : 'neto'})
                    </option>
                  ))}
              </select>

              <ul className="mt-3 space-y-2">
                {footTaxes.length === 0 && (
                  <li className="text-xs text-text-soft">Sin impuestos agregados.</li>
                )}
                {footTaxes.map((tax, idx) => {
                  const rate = footRates.find((r) => r.id === tax.taxRateId);
                  const suggested = rate ? suggestedTaxAmount(rate, totals) : 0;
                  const edited = Math.abs(tax.amount - suggested) > 0.009;
                  return (
                    <li key={tax.taxRateId} className="flex items-center gap-2 border border-line bg-panel-alt px-3 py-2">
                      <span className="min-w-0 flex-1 text-xs">
                        <span className="block truncate font-semibold text-text">{rate?.name}</span>
                        <span className="text-[10px] text-text-soft">
                          {rate?.rate}% s/ {rate?.base === 'TOTAL' ? 'total' : 'neto'}
                          {edited && ` · calculado $ ${formatMoney(suggested)}`}
                        </span>
                      </span>
                      <input
                        type="number" step="0.01" min="0"
                        value={tax.amount}
                        onChange={(e) =>
                          setFootTaxes((current) =>
                            current.map((t, i) => (i === idx ? { ...t, amount: Number(e.target.value) } : t))
                          )
                        }
                        className="w-28 border border-line bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setFootTaxes((current) => current.filter((_, i) => i !== idx))}
                        aria-label="Quitar impuesto"
                        className="text-text-soft transition-colors hover:text-danger"
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>

              <p className="mt-3 text-[10px] text-text-soft">
                El importe arranca calculado y se puede corregir para que cierre
                exacto con el papel. Las retenciones no van acá: se aplican al pagar.
              </p>
            </>
          )}
        </Panel>

        <Panel className="p-5">
          <SectionHeader title="Totales" />

          <label className={cn(labelClass, 'mb-4 block sm:w-1/2')}>
            Bonificación general %
            <input
              type="number" step="0.01" min="0" max="100"
              value={generalDiscount}
              onChange={(e) => setGeneralDiscount(e.target.value)}
              className={cn(inputClass, 'font-mono')}
            />
          </label>

          <dl className="space-y-1 text-[13px]">
            <Row label="Bruto" value={totals.gross} />
            {totals.lineDiscount > 0 && (
              <Row label="Bonificación por renglón" value={-totals.lineDiscount} muted />
            )}
            {totals.generalDiscount > 0 && (
              <Row label={`Bonificación general ${generalDiscount}%`} value={-totals.generalDiscount} muted />
            )}

            <div className="my-2 border-t border-line" />

            {totals.vatByRate.map((entry) => (
              <Row key={entry.rate} label={`Neto gravado ${entry.rate}%`} value={entry.net} />
            ))}
            {totals.netExempt > 0 && <Row label="Neto exento" value={totals.netExempt} />}
            {totals.netUntaxed > 0 && <Row label="Neto no gravado" value={totals.netUntaxed} />}
            {totals.vatByRate.map((entry) => (
              <Row key={`iva-${entry.rate}`} label={`IVA ${entry.rate}%`} value={entry.vat} />
            ))}
            {totals.otherTaxes > 0 && <Row label="Percepciones e impuestos" value={totals.otherTaxes} />}

            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</dt>
              <dd className="font-display text-2xl font-medium text-text">$ {formatMoney(totals.total)}</dd>
            </div>
          </dl>

          {/* Control cruzado contra el papel: es la forma más barata de
              detectar un precio mal tipeado antes de guardar. */}
          <div className="mt-4 border-t border-line pt-3">
            <label className={labelClass}>
              Total del comprobante (control)
              <input
                type="number" step="0.01" min="0"
                value={declaredTotal}
                onChange={(e) => setDeclaredTotal(e.target.value)}
                placeholder="Tipeá el total que figura en el papel"
                className={cn(
                  inputClass, 'font-mono',
                  declaredDiff !== null && declaredDiff !== 0 && 'border-danger bg-danger-soft'
                )}
              />
            </label>
            {declaredDiff !== null && (
              <p
                className={cn(
                  'mt-1.5 flex items-center gap-1.5 text-xs',
                  declaredDiff === 0 ? 'text-state-done' : 'text-danger'
                )}
              >
                {declaredDiff === 0 ? <Check size={14} /> : <AlertTriangle size={14} />}
                {declaredDiff === 0
                  ? 'Coincide con el comprobante.'
                  : `Difiere en $ ${formatMoney(Math.abs(declaredDiff))}. Revisá los renglones o el pie.`}
              </p>
            )}
          </div>
        </Panel>
      </div>

      <Panel className="mb-10 p-5">
        <SectionHeader title="Observaciones" />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Notas internas sobre este comprobante. Opcional."
          className="w-full resize-y border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
        />

        <div className="mt-4 flex justify-end border-t border-line pt-4">
          <Button onClick={handleSave} disabled={!canSave}>
            <Save size={16} /> {saving ? 'Guardando…' : 'Guardar comprobante'}
          </Button>
        </div>
      </Panel>

      {showPicker && (
        <PurchaseArticlePicker
          articles={articles}
          onPick={addArticle}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-text-faint' : 'text-text-soft'}>{label}</dt>
      <dd className={cn('font-mono', muted ? 'text-text-faint' : 'text-text')}>
        {value < 0 ? '−' : ''}$ {formatMoney(Math.abs(value))}
      </dd>
    </div>
  );
}
