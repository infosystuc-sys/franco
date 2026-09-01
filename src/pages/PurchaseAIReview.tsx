// src/pages/PurchaseAIReview.tsx
import React from 'react';
import { Plus, Save, XCircle, AlertTriangle, Package, Trash2 } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { cn, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { PurchaseArticlePicker } from '@/src/components/PurchaseArticlePicker';
import { PurchaseItemRow } from '@/src/components/purchase/PurchaseItemRow';
import { PurchaseTaxRow } from '@/src/components/purchase/PurchaseTaxRow';
import { PurchaseTotalsSummary } from '@/src/components/purchase/PurchaseTotalsSummary';
import { SupplierModal } from '@/src/components/SupplierModal';
import { formatCuit } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { fetchExpenseConcepts, type ExpenseConcept } from '@/src/lib/expenseConcepts';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchTaxRates, type TaxRate } from '@/src/lib/taxRates';
import {
  computePurchaseTotals,
  describePurchaseError,
  proposeDueDate,
  savePurchaseInvoice,
  suggestedTaxAmount,
  PURCHASE_DOC_TYPE_LABELS,
  PURCHASE_DOC_TYPES,
  type PurchaseDocType,
  type PurchaseFootTax,
  type PurchaseLetter,
  type PurchaseLine,
} from '@/src/lib/purchases';
import {
  confirmExtraction,
  describeExtractionError,
  discardExtraction,
  fetchExtractionById,
  getDraftAttachmentUrl,
  requestExtraction,
  type PurchaseExtraction,
} from '@/src/lib/purchaseExtractions';

const EMPTY_LINE: PurchaseLine = {
  articleId: null, conceptId: null, code: '', description: '',
  quantity: 1, unitPrice: 0, discountPercent: 0, vatRateId: '',
};

/** Confianza 0..1 -> semáforo. Mismo criterio que PH_FAC. */
function ConfidenceChip({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  const color = value >= 0.8 ? 'text-state-done' : value >= 0.5 ? 'text-state-wait' : 'text-danger';
  return <span className={cn('ml-1.5 font-mono text-[10px]', color)}>{Math.round(value * 100)}%</span>;
}

function parseArgNumber(text: string): number {
  // El importe viene tal como está impreso: puede traer "." de miles y "," decimal, o al revés.
  const cleaned = text.trim();
  if (!cleaned) return 0;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned.replace(/[.,]/g, '');
  }
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

export function PurchaseAIReview() {
  const { role } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();

  const [draft, setDraft] = React.useState<PurchaseExtraction | null>(null);
  const [attachmentUrl, setAttachmentUrl] = React.useState<string | null>(null);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [concepts, setConcepts] = React.useState<ExpenseConcept[]>([]);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [rates, setRates] = React.useState<TaxRate[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showPicker, setShowPicker] = React.useState(false);
  const [pickerTargetIndex, setPickerTargetIndex] = React.useState<number | null>(null);
  const [showNewSupplier, setShowNewSupplier] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);

  const [supplierId, setSupplierId] = React.useState('');
  const [docType, setDocType] = React.useState<PurchaseDocType>('FACTURA');
  const [letter, setLetter] = React.useState<PurchaseLetter>('A');
  const [salesPoint, setSalesPoint] = React.useState('');
  const [number, setNumber] = React.useState('');
  const [issueDate, setIssueDate] = React.useState(todayLocal());
  const [receivedDate, setReceivedDate] = React.useState(todayLocal());
  const [dueDate, setDueDate] = React.useState('');
  // Solo se pregunta en NC y ND: la factura de artículos siempre mueve stock.
  const [movesStock, setMovesStock] = React.useState(false);
  const [lines, setLines] = React.useState<PurchaseLine[]>([]);
  const [generalDiscount, setGeneralDiscount] = React.useState('0');
  const [footTaxes, setFootTaxes] = React.useState<PurchaseFootTax[]>([]);
  const [notes, setNotes] = React.useState('');

  const isArticles = draft?.kind === 'ARTICULOS';

  React.useEffect(() => {
    if (role !== 'admin' || !id) return;
    let cancelled = false;

    Promise.all([fetchExtractionById(id), fetchSuppliers(true), fetchTaxRates(true)])
      .then(async ([d, s, r]) => {
        if (cancelled || !d) return;
        setDraft(d);
        setSuppliers(s);
        setRates(r);
        if (d.kind === 'ARTICULOS') setArticles(await fetchArticles(false));
        else setConcepts(await fetchExpenseConcepts(true));

        setAttachmentUrl(await getDraftAttachmentUrl(d.attachmentStoragePath));

        // Precarga desde lo que leyó la IA.
        const raw = (d.rawExtraction ?? {}) as any;
        const v = raw.valores ?? {};
        if (d.supplierId) setSupplierId(d.supplierId);
        if (v.tipo_comprobante === 'NOTA_CREDITO' || v.tipo_comprobante === 'NOTA_DEBITO') setDocType(v.tipo_comprobante);
        if (['A', 'B', 'C', 'M'].includes(v.letra)) setLetter(v.letra);
        if (v.punto_venta) setSalesPoint(String(Number(v.punto_venta.replace(/\D/g, '')) || ''));
        if (v.numero) setNumber(String(Number(v.numero.replace(/\D/g, '')) || ''));
        setNotes(v.condicion_pago ? `Condición de pago (IA): ${v.condicion_pago}` : '');

        const rateByPercent = new Map(r.filter((rate) => rate.kind === 'IVA').map((rate) => [rate.rate, rate]));
        const draftLines: PurchaseLine[] = (raw.renglones ?? []).map((row: any) => {
          const alicuota = Number(String(row.alicuota_iva ?? '').replace(',', '.')) || 0;
          const vatRate = rateByPercent.get(alicuota);
          return {
            articleId: row.article_id ?? null,
            conceptId: null,
            code: String(row.codigo ?? ''),
            description: String(row.descripcion ?? ''),
            quantity: parseArgNumber(String(row.cantidad ?? '1')) || 1,
            unitPrice: parseArgNumber(String(row.precio_unitario ?? '0')),
            discountPercent: parseArgNumber(String(row.bonificacion_porcentaje ?? '0')),
            vatRateId: vatRate?.id ?? '',
          };
        });
        setLines(draftLines.length > 0 ? draftLines : [{ ...EMPTY_LINE }]);
      })
      .catch((err) => !cancelled && setError(describeExtractionError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [role, id]);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
  const vatRates = React.useMemo(() => rates.filter((r) => r.kind === 'IVA'), [rates]);
  const footRates = React.useMemo(
    () => rates.filter((r) => r.kind === 'PERCEPCION' || r.kind === 'IMPUESTO_INTERNO'),
    [rates]
  );

  React.useEffect(() => {
    if (!supplier || !issueDate) return;
    setDueDate((current) => current || proposeDueDate(issueDate, supplier.paymentTermsDays));
  }, [supplier, issueDate]);

  // La NC suele ser devolución, así que arranca marcada; la ND casi nunca
  // trae mercadería, así que arranca desmarcada. La factura no pregunta.
  React.useEffect(() => {
    if (!isArticles) return;
    setMovesStock(docType === 'NOTA_CREDITO');
  }, [docType, isArticles]);

  const totals = React.useMemo(
    () => computePurchaseTotals(lines, footTaxes, Number(generalDiscount) || 0, vatRates),
    [lines, footTaxes, generalDiscount, vatRates]
  );

  const confianzas = ((draft?.rawExtraction as any)?.confianzas ?? {}) as Record<string, number>;

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) return <div className="mx-auto max-w-6xl p-8 text-center text-text-soft">Leyendo el borrador…</div>;
  if (!draft) return <div className="mx-auto max-w-6xl p-8 text-center text-danger">No se encontró esa lectura.</div>;

  if (draft.status === 'ERROR') {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <AlertTriangle size={28} className="mx-auto mb-3 text-danger" />
        <p className="mb-4 text-sm text-danger">{draft.errorMessage ?? 'No se pudo leer esta factura.'}</p>
        {error && <p className="mb-4 text-xs text-danger">{error}</p>}
        <div className="flex justify-center gap-2">
          <Link to="/compras-ia"><Button variant="ghost" type="button">Volver</Button></Link>
          <Button
            type="button"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              setError(null);
              try {
                // Mismo archivo ya subido, sin pedir que se vuelva a subir.
                const { id: newId } = await requestExtraction({
                  storagePath: draft.attachmentStoragePath,
                  mimeType: draft.attachmentMimeType,
                  kind: draft.kind,
                });
                await discardExtraction(draft.id);
                navigate(`/compras-ia/revisar/${newId}`);
              } catch (err) {
                setError(describeExtractionError(getErrorMessage(err)));
                setRetrying(false);
              }
            }}
          >
            {retrying ? 'Reintentando…' : 'Reintentar lectura'}
          </Button>
        </div>
      </div>
    );
  }

  function patchLine(index: number, patch: Partial<PurchaseLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addArticle(article: Article) {
    if (pickerTargetIndex !== null) {
      // Completa el renglón que la IA ya había leído (cantidad, precio,
      // bonificación, alícuota): solo falta el artículo del catálogo.
      patchLine(pickerTargetIndex, { articleId: article.id, code: article.code, description: article.description });
    } else {
      setLines((current) => [
        ...current,
        { ...EMPTY_LINE, articleId: article.id, code: article.code, description: article.description, unitPrice: article.purchasePrice ?? 0 },
      ]);
    }
    setShowPicker(false);
    setPickerTargetIndex(null);
  }

  function addFootTax(taxRateId: string) {
    if (!taxRateId || footTaxes.some((tax) => tax.taxRateId === taxRateId)) return;
    const rate = footRates.find((r) => r.id === taxRateId);
    if (!rate) return;
    setFootTaxes((current) => [...current, { taxRateId, amount: suggestedTaxAmount(rate, totals) }]);
  }

  const missingVat = lines.some((line) => !line.vatRateId);
  const missingDescription = lines.some((line) => line.description.trim() === '');
  const unmatchedArticleLines = isArticles ? lines.filter((line) => !line.articleId).length : 0;

  const canSave =
    !!supplierId && salesPoint.trim() !== '' && Number(number) > 0 && !!issueDate && !!dueDate &&
    lines.length > 0 && !missingVat && !missingDescription && totals.total > 0 &&
    unmatchedArticleLines === 0 && !saving;

  async function handleDiscard() {
    if (!window.confirm('¿Descartar esta lectura? No se puede deshacer.')) return;
    await discardExtraction(draft!.id);
    navigate('/compras-ia');
  }

  async function handleSave() {
    if (!canSave || !supplier || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await savePurchaseInvoice(
        {
          kind: draft.kind, docType, letter, salesPoint: Number(salesPoint), number: Number(number),
          supplierId, issueDate, receivedDate, dueDate, paymentTermsDays: supplier.paymentTermsDays,
          generalDiscountPercent: Number(generalDiscount) || 0, movesStock, notes,
        },
        lines,
        footTaxes
      );
      await confirmExtraction(draft.id, saved.id);
      navigate(`/compra/${saved.id}`);
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={isArticles ? 'Revisar factura de artículos (IA)' : 'Revisar factura de conceptos (IA)'}
        subtitle="Cotejá contra el original. Los campos con chip de confianza los completó Gemini."
        actions={
          <>
            <Button variant="ghost" type="button" onClick={handleDiscard}><XCircle size={16} /> Descartar</Button>
            <Button onClick={handleSave} disabled={!canSave}>
              <Save size={16} /> {saving ? 'Guardando…' : 'Confirmar y guardar'}
            </Button>
          </>
        }
      />

      {error && <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel className="p-2">
          {attachmentUrl && draft.attachmentMimeType === 'application/pdf' ? (
            <embed src={attachmentUrl} type="application/pdf" className="h-[70vh] w-full" />
          ) : attachmentUrl ? (
            <img src={attachmentUrl} alt="Factura original" className="max-h-[70vh] w-full object-contain" />
          ) : null}
        </Panel>

        <div>
          <Panel className="mb-4 p-5">
            <SectionHeader title="Encabezado" />
            <div className="grid grid-cols-1 gap-3">
              <label className={labelClass}>
                Proveedor <ConfidenceChip value={confianzas.proveedor_cuit} />
                <div className="flex gap-2">
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className={cn(inputClass, 'bg-panel', !supplierId && 'field-required')}
                  >
                    <option value="">Elegí un proveedor</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}{s.taxId ? ` — ${formatCuit(s.taxId)}` : ''}</option>
                    ))}
                  </select>
                  <Button type="button" variant="ghost" className="shrink-0 px-3" onClick={() => setShowNewSupplier(true)}>
                    <Plus size={14} /> Nuevo
                  </Button>
                </div>
                {!draft.supplierId && (draft.rawExtraction as any)?.valores?.proveedor_cuit && (
                  <span className="mt-1 block text-[10px] font-normal normal-case text-state-wait">
                    La IA leyó CUIT {(draft.rawExtraction as any).valores.proveedor_cuit} pero no coincide con ningún proveedor cargado.
                  </span>
                )}
              </label>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className={labelClass}>
                  Comprobante <ConfidenceChip value={confianzas.tipo_comprobante} />
                  <select value={docType} onChange={(e) => setDocType(e.target.value as PurchaseDocType)} className={cn(inputClass, 'bg-panel')}>
                    {PURCHASE_DOC_TYPES.map((type) => (
                      <option key={type} value={type}>{PURCHASE_DOC_TYPE_LABELS[type]}</option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  Letra <ConfidenceChip value={confianzas.letra} />
                  <select value={letter} onChange={(e) => setLetter(e.target.value as PurchaseLetter)} className={cn(inputClass, 'bg-panel font-mono')}>
                    {(['A', 'B', 'C', 'M'] as PurchaseLetter[]).map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
                <label className={labelClass}>
                  P. venta <ConfidenceChip value={confianzas.punto_venta} />
                  <input type="number" min="0" value={salesPoint} onChange={(e) => setSalesPoint(e.target.value)} className={cn(inputClass, 'font-mono')} />
                </label>
                <label className={labelClass}>
                  Número <ConfidenceChip value={confianzas.numero} />
                  <input type="number" min="1" value={number} onChange={(e) => setNumber(e.target.value)} className={cn(inputClass, 'font-mono')} />
                </label>
                <label className={labelClass}>
                  Fecha <ConfidenceChip value={confianzas.fecha_comprobante} />
                  <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className={inputClass} />
                </label>
                <label className={labelClass}>
                  Fecha de recepción
                  <input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className={inputClass} />
                </label>
              </div>

              <label className={labelClass}>
                Vencimiento
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
              </label>

              {isArticles && docType !== 'FACTURA' && (
                <label className="flex cursor-pointer items-start gap-2 border border-line bg-panel-alt p-3 text-sm">
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
            </div>
          </Panel>
        </div>
      </div>

      <Panel className="mb-6 p-5">
        <SectionHeader
          title={isArticles ? 'Artículos' : 'Conceptos'}
          actions={isArticles && (
            <Button type="button" onClick={() => { setPickerTargetIndex(null); setShowPicker(true); }} className="px-3">
              <Package size={16} /> Agregar artículo
            </Button>
          )}
        />
        {unmatchedArticleLines > 0 && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-danger">
            <AlertTriangle size={14} /> {unmatchedArticleLines} renglón(es) sin artículo asignado — elegilo antes de confirmar.
          </p>
        )}
        <div className="overflow-x-auto overflow-y-hidden rounded-md border border-line">
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
              {lines.map((line, idx) => (
                <React.Fragment key={idx}>
                  {isArticles && !line.articleId ? (
                    <tr className="h-9 border-b border-line bg-danger-soft">
                      <td colSpan={8} className="px-2 py-1">
                        <button
                          type="button"
                          onClick={() => { setPickerTargetIndex(idx); setShowPicker(true); }}
                          className="flex w-full items-center justify-between text-left text-danger hover:underline"
                        >
                          <span>{line.description || 'Renglón sin artículo del catálogo asignado'} — elegir artículo</span>
                          <button type="button" onClick={(e) => { e.stopPropagation(); setLines((c) => c.filter((_, i) => i !== idx)); }} aria-label="Quitar renglón">
                            <Trash2 size={15} />
                          </button>
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <PurchaseItemRow
                      line={line}
                      idx={idx}
                      isArticles={isArticles}
                      concepts={concepts}
                      vatRates={vatRates}
                      onPatch={(patch) => patchLine(idx, patch)}
                      onRemove={() => setLines((current) => current.filter((_, i) => i !== idx))}
                    />
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel className="p-5">
          <SectionHeader title="Impuestos del pie" />
          {footRates.length > 0 && (
            <select value="" onChange={(e) => addFootTax(e.target.value)} className={cn(inputClass, 'mt-0 bg-panel')}>
              <option value="">Agregar percepción o impuesto…</option>
              {footRates.filter((rate) => !footTaxes.some((tax) => tax.taxRateId === rate.id)).map((rate) => (
                <option key={rate.id} value={rate.id}>{rate.name} ({rate.rate}%)</option>
              ))}
            </select>
          )}
          <ul className="mt-3 space-y-2">
            {footTaxes.map((tax, idx) => (
              <PurchaseTaxRow
                key={tax.taxRateId}
                tax={tax}
                rate={footRates.find((r) => r.id === tax.taxRateId)}
                suggested={(() => {
                  const rate = footRates.find((r) => r.id === tax.taxRateId);
                  return rate ? suggestedTaxAmount(rate, totals) : 0;
                })()}
                onAmountChange={(amount) => setFootTaxes((current) => current.map((t, i) => (i === idx ? { ...t, amount } : t)))}
                onRemove={() => setFootTaxes((current) => current.filter((_, i) => i !== idx))}
              />
            ))}
          </ul>
        </Panel>

        <Panel className="p-5">
          <SectionHeader title="Totales" />
          <ConfidenceChip value={confianzas.total} />
          <PurchaseTotalsSummary
            totals={totals}
            generalDiscount={generalDiscount}
            onGeneralDiscountChange={setGeneralDiscount}
            declaredTotal=""
            onDeclaredTotalChange={() => {}}
          />
        </Panel>
      </div>

      <Panel className="mb-6 p-5">
        <SectionHeader title="Observaciones" />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Notas internas sobre este comprobante. Opcional."
          className="w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
        />
      </Panel>

      {showPicker && (
        <PurchaseArticlePicker
          articles={articles}
          onPick={addArticle}
          onClose={() => { setShowPicker(false); setPickerTargetIndex(null); }}
        />
      )}
      {showNewSupplier && (
        <SupplierModal
          supplier={null}
          onClose={() => setShowNewSupplier(false)}
          onSaved={(created) => {
            setSuppliers((current) => [...current, created]);
            setSupplierId(created.id);
            setShowNewSupplier(false);
          }}
        />
      )}
    </div>
  );
}
