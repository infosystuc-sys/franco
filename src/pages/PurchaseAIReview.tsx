// src/pages/PurchaseAIReview.tsx
import React from 'react';
import { Plus, Save, XCircle, AlertTriangle, CheckCircle2, Package, Trash2 } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { cn, formatMoney, todayLocal } from '@/src/lib/utils';
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
import { fetchArticles, fetchSupplierCodeMap, linkOrCreateSupplierArticle, type Article } from '@/src/lib/articles';
import { createTaxRate, fetchTaxRates, EMPTY_TAX_RATE_FORM, type TaxRate } from '@/src/lib/taxRates';
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

/**
 * Un renglón de la revisión: el renglón que se va a guardar (PurchaseLine,
 * idéntico al de la carga manual) más lo que decía el papel. Cuando el
 * renglón quedó atado a un artículo del catálogo, code/description pasan a
 * ser los del catálogo —que es lo que realmente se va a afectar— y lo
 * impreso se conserva acá para poder cotejar. Los campos extra no molestan a
 * savePurchaseInvoice, que solo lee los de PurchaseLine.
 */
type ReviewLine = PurchaseLine & { printedCode?: string; printedDescription?: string };

/** Confianza 0..1 -> semáforo. Mismo criterio que PH_FAC. */
function ConfidenceChip({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  const color = value >= 0.8 ? 'text-state-done' : value >= 0.5 ? 'text-state-wait' : 'text-danger';
  return <span className={cn('ml-1.5 font-mono text-[10px]', color)}>{Math.round(value * 100)}%</span>;
}

/**
 * Marca del campo. El chip de confianza solo tiene sentido si el valor que se
 * ve en pantalla es el que leyó la IA: cuando la precarga descartó lo que vino
 * (formato de fecha raro, letra fuera de A/B/C/M, tipo desconocido) el campo
 * quedó en su valor por defecto, y mostrar ahí un 95% verde es mentirle al que
 * revisa. En ese caso se avisa que hay que completarlo a mano.
 */
function FieldMark({ applied, confidence }: { applied: boolean; confidence: number | undefined }) {
  if (applied) return <ConfidenceChip value={confidence} />;
  return (
    <span className="ml-1.5 text-[10px] font-normal normal-case text-state-wait">
      no se pudo leer, completalo a mano
    </span>
  );
}

/**
 * El importe viene tal como está impreso: puede traer "." de miles y ","
 * decimal, o al revés, o un solo separador que hay que desambiguar.
 *
 *   "1.234,56"     -> 1234.56    "1.234.567"    -> 1234567
 *   "1,234,567.89" -> 1234567.89 "1.234.567,89" -> 1234567.89
 *   "12.500"       -> 12500      "12,50"        -> 12.5
 */
function parseArgNumber(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;

  const dots = (cleaned.match(/\./g) ?? []).length;
  const commas = (cleaned.match(/,/g) ?? []).length;

  let normalized: string;
  if (dots > 0 && commas > 0) {
    // Aparecen los dos: el ÚLTIMO es el decimal y el otro es el de miles.
    normalized = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(/,/g, '.')
      : cleaned.replace(/,/g, '');
  } else if (dots + commas === 0) {
    normalized = cleaned;
  } else {
    // Un solo tipo de separador. Es de miles si aparece más de una vez
    // ("1.234.567" — antes esta rama devolvía 0) o si separa exactamente tres
    // dígitos al final ("12.500" es el precio redondo argentino sin centavos,
    // y tomarlo como decimal metía el renglón a mil veces menos). Si no,
    // es decimal: "12,50", "123.5".
    const esDeMiles = dots + commas > 1 || /\d[.,]\d{3}$/.test(cleaned);
    normalized = esDeMiles ? cleaned.replace(/[.,]/g, '') : cleaned.replace(',', '.');
  }

  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Fecha del comprobante tal como la imprimió el proveedor -> ISO (yyyy-mm-dd).
 * Gemini manda el texto como está en el papel: lo normal es DD/MM/AAAA
 * (o con guiones), a veces DD/MM/AA con año de dos dígitos, y a veces ya
 * viene en ISO. Ante cualquier otra cosa (formato raro, vacío, fecha
 * imposible) devuelve null: mejor dejar el campo en la fecha de hoy — con el
 * aviso de que no se pudo leer — que fabricar un valor incorrecto.
 */
function parseFechaExtraida(text: string): string | null {
  const cleaned = text.trim();
  if (!cleaned) return null;

  const iso = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso.map(Number);
    return isValidCalendarDate(y, m, d) ? isoDate(y, m, d) : null;
  }

  const dmy = cleaned.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (dmy) {
    const [, d, m, rawYear] = dmy.map(Number);
    const y = dmy[3].length === 2 ? expandTwoDigitYear(rawYear) : rawYear;
    return isValidCalendarDate(y, m, d) ? isoDate(y, m, d) : null;
  }

  return null;
}

/**
 * "26" -> 2026. El siglo se asume 2000; si eso diera una fecha más de un año
 * en el futuro (un "05/08/99" que sería 2099) se resta un siglo. Una factura
 * de compra siempre es del pasado reciente.
 */
function expandTwoDigitYear(twoDigits: number): number {
  const year = 2000 + twoDigits;
  return year > new Date().getFullYear() + 1 ? year - 100 : year;
}

/** Comparación tolerante de nombres: sin tildes, sin mayúsculas, por inclusión
 *  en cualquier sentido. El nombre impreso en la factura casi nunca coincide
 *  exacto con el nombre cargado en Alícuotas ("Percepción IIBB Tucumán" vs.
 *  lo que sea que haya en el sistema). */
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
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
  // Altas y vinculaciones contra el catálogo: son un efecto lateral de la
  // revisión, no parte del comprobante, así que tienen su propio aviso y no
  // usan el banner de error del guardado.
  const [catalogBusy, setCatalogBusy] = React.useState(false);
  const [catalogNote, setCatalogNote] = React.useState<string | null>(null);
  const [rateBusy, setRateBusy] = React.useState(false);
  // Caso raro pero venenoso: la RPC guardó el comprobante y falló el update
  // del borrador. El comprobante existe; hay que decirlo así, no como un
  // error de guardado, o se carga dos veces.
  const [confirmWarning, setConfirmWarning] = React.useState<
    { invoiceId: string; fullNumber: string; detail: string } | null
  >(null);

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
  const [lines, setLines] = React.useState<ReviewLine[]>([]);
  const [generalDiscount, setGeneralDiscount] = React.useState('0');
  const [footTaxes, setFootTaxes] = React.useState<PurchaseFootTax[]>([]);
  const [notes, setNotes] = React.useState('');
  // Total que la IA leyó del papel: control cruzado automático contra el
  // total que dan los renglones que se están por guardar (PurchaseTotalsSummary
  // hace la comparación sola en cuanto este campo tiene un valor).
  const [declaredTotal, setDeclaredTotal] = React.useState('');
  // El total tal como lo leyó la IA, aparte del campo de control: ese el
  // usuario lo puede corregir, y el chip de confianza mide la lectura, no la
  // corrección.
  const [aiTotal, setAiTotal] = React.useState<number | null>(null);
  // Percepciones que la IA leyó pero no coinciden con ninguna alícuota
  // cargada: no se inventan, se avisan para que el usuario decida.
  const [unmatchedPercepciones, setUnmatchedPercepciones] = React.useState<{ nombre: string; importe: string }[]>([]);
  // Qué campos del encabezado quedaron efectivamente con lo que leyó la IA.
  // Lo que no se aplicó no lleva chip de confianza: lleva el aviso de que hay
  // que completarlo a mano.
  const [applied, setApplied] = React.useState<Record<string, boolean>>({});

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
        let catalog: Article[] = [];
        // Los códigos vigentes de este proveedor, para reconocer renglones que
        // la IA no pudo matchear pero cuyo artículo se dio de alta después.
        let codigosDelProveedor = new Map<string, string>();
        if (d.kind === 'ARTICULOS') {
          catalog = await fetchArticles(false);
          setArticles(catalog);
          if (d.supplierId) codigosDelProveedor = await fetchSupplierCodeMap(d.supplierId);
        } else {
          setConcepts(await fetchExpenseConcepts(true));
        }

        setAttachmentUrl(await getDraftAttachmentUrl(d.attachmentStoragePath));

        // Precarga desde lo que leyó la IA. De cada campo se anota si el valor
        // leído se aplicó de verdad: si se descartó, el campo queda en su
        // default y no puede llevar chip de confianza (ver FieldMark).
        const raw = (d.rawExtraction ?? {}) as any;
        const v = raw.valores ?? {};
        const appliedFields: Record<string, boolean> = {};
        if (d.supplierId) setSupplierId(d.supplierId);
        appliedFields.proveedor_cuit = !!d.supplierId;

        const tipoLeido = String(v.tipo_comprobante ?? '');
        if (tipoLeido === 'NOTA_CREDITO' || tipoLeido === 'NOTA_DEBITO') setDocType(tipoLeido);
        appliedFields.tipo_comprobante = tipoLeido === 'FACTURA' || tipoLeido === 'NOTA_CREDITO' || tipoLeido === 'NOTA_DEBITO';

        const letraLeida = String(v.letra ?? '');
        if (['A', 'B', 'C', 'M'].includes(letraLeida)) setLetter(letraLeida as PurchaseLetter);
        appliedFields.letra = ['A', 'B', 'C', 'M'].includes(letraLeida);

        const puntoVenta = v.punto_venta ? String(Number(String(v.punto_venta).replace(/\D/g, '')) || '') : '';
        if (puntoVenta) setSalesPoint(puntoVenta);
        appliedFields.punto_venta = puntoVenta !== '';

        const numeroLeido = v.numero ? String(Number(String(v.numero).replace(/\D/g, '')) || '') : '';
        if (numeroLeido) setNumber(numeroLeido);
        appliedFields.numero = numeroLeido !== '';

        const parsedIssueDate = parseFechaExtraida(String(v.fecha_comprobante ?? ''));
        if (parsedIssueDate) setIssueDate(parsedIssueDate);
        appliedFields.fecha_comprobante = parsedIssueDate !== null;

        setApplied(appliedFields);
        setNotes(v.condicion_pago ? `Condición de pago (IA): ${v.condicion_pago}` : '');
        const parsedDeclaredTotal = parseArgNumber(String(v.total ?? ''));
        setDeclaredTotal(parsedDeclaredTotal > 0 ? String(parsedDeclaredTotal) : '');
        setAiTotal(parsedDeclaredTotal > 0 ? parsedDeclaredTotal : null);

        // Percepciones leídas del pie: se matchean por nombre contra las
        // alícuotas de percepción/impuesto interno ya cargadas. Lo que no
        // matchea no se inventa: queda afuera de footTaxes y se avisa.
        const footCandidates = r.filter((rate) => rate.kind === 'PERCEPCION' || rate.kind === 'IMPUESTO_INTERNO');
        const matchedFootTaxes: PurchaseFootTax[] = [];
        const unmatched: { nombre: string; importe: string }[] = [];
        for (const p of (raw.percepciones ?? []) as any[]) {
          const nombre = String(p?.nombre ?? '').trim();
          if (!nombre) continue;
          const normalizedName = normalizeForMatch(nombre);
          const match = footCandidates.find((rate) => {
            const normalizedRateName = normalizeForMatch(rate.name);
            return normalizedRateName.includes(normalizedName) || normalizedName.includes(normalizedRateName);
          });
          if (match) {
            matchedFootTaxes.push({ taxRateId: match.id, amount: parseArgNumber(String(p?.importe ?? '0')) });
          } else {
            unmatched.push({ nombre, importe: String(p?.importe ?? '') });
          }
        }
        setFootTaxes(matchedFootTaxes);
        setUnmatchedPercepciones(unmatched);

        const rateByPercent = new Map(r.filter((rate) => rate.kind === 'IVA').map((rate) => [rate.rate, rate]));
        const articleById = new Map(catalog.map((a) => [a.id, a]));
        const draftLines: ReviewLine[] = (raw.renglones ?? []).map((row: any) => {
          // "No se pudo leer" no es lo mismo que "es cero". Con `|| 0`, una
          // alícuota ilegible matcheaba la de 0% y el renglón entraba sin IVA
          // pero con vatRateId seteado, así que missingVat tampoco lo agarraba:
          // IVA subdeclarado y crédito fiscal perdido, sin una señal en
          // pantalla. Ahora lo ilegible queda sin alícuota elegida —el cartel
          // de renglones incompletos lo pide— y un "0" explícito sí matchea
          // la alícuota de 0%.
          const alicuotaTexto = String(row.alicuota_iva ?? '').trim().replace(',', '.');
          const alicuota = alicuotaTexto === '' ? Number.NaN : Number(alicuotaTexto);
          const vatRate = Number.isFinite(alicuota) ? rateByPercent.get(alicuota) : undefined;
          const printedCode = String(row.codigo ?? '');
          const printedDescription = String(row.descripcion ?? '');
          // Si el renglón quedó atado a un artículo, lo que manda es el
          // artículo: es su stock y su precio de compra lo que se va a tocar.
          // El código y la descripción del papel se guardan aparte y se
          // muestran debajo, para poder cotejar que el match sea el correcto.
          // El matcheo guardado manda; si no hay, se reintenta contra el
          // catálogo de hoy, que puede haber crecido desde que se leyó.
          const matchId = row.article_id
            ? String(row.article_id)
            : codigosDelProveedor.get(printedCode.trim().toUpperCase());
          const article = matchId ? articleById.get(matchId) : undefined;
          return {
            articleId: article?.id ?? null,
            conceptId: null,
            code: article ? article.code : printedCode,
            description: article ? article.description : printedDescription,
            printedCode,
            printedDescription,
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

  // Mismo mecanismo que la carga manual: el vencimiento se recalcula cada vez
  // que cambia la fecha del comprobante o el proveedor, salvo que el revisor
  // ya lo haya escrito a mano. Antes solo se escribía si estaba vacío, así que
  // corregir una fecha mal leída dejaba el vencimiento viejo.
  React.useEffect(() => {
    if (dueDateTouched || !supplier || !issueDate) return;
    setDueDate(proposeDueDate(issueDate, supplier.paymentTermsDays));
  }, [supplier, issueDate, dueDateTouched]);

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

  // ── Guardas por estado. Solo un borrador EXTRAIDO y con lectura encima se
  // puede revisar. Sin esto, volver con Atrás después de guardar mostraba el
  // formulario editable otra vez sobre un borrador ya CONFIRMADO: confirmar de
  // nuevo rebota contra el unique de purchase_invoices, y si además se corrige
  // el número se genera un segundo comprobante y el borrador queda apuntando
  // al nuevo, perdiendo el vínculo con el primero.
  if (draft.status === 'CONFIRMADO') {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <CheckCircle2 size={28} className="mx-auto mb-3 text-state-done" />
        <p className="mb-1 text-sm font-semibold text-text">Esta lectura ya se confirmó.</p>
        <p className="mb-4 text-sm text-text-soft">
          El comprobante ya está cargado: no hace falta volver a guardarlo.
        </p>
        <div className="flex justify-center gap-2">
          <Link to="/compras-ia"><Button variant="ghost" type="button">Volver</Button></Link>
          {draft.purchaseInvoiceId && (
            <Link to={`/compra/${draft.purchaseInvoiceId}`}>
              <Button type="button">Ver el comprobante</Button>
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (confirmWarning) {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <AlertTriangle size={28} className="mx-auto mb-3 text-state-wait" />
        <p className="mb-1 text-sm font-semibold text-text">
          El comprobante se guardó; no se pudo marcar el borrador como confirmado.
        </p>
        <p className="mb-4 text-sm text-text-soft">
          La compra {confirmWarning.fullNumber} quedó registrada — no la vuelvas a cargar. Lo único
          que falló fue cerrar el borrador, así que va a seguir apareciendo en la lista de pendientes:
          descartalo desde ahí. Detalle: {confirmWarning.detail}
        </p>
        <div className="flex justify-center gap-2">
          <Link to="/compras-ia"><Button variant="ghost" type="button">Ir al listado</Button></Link>
          <Link to={`/compra/${confirmWarning.invoiceId}`}>
            <Button type="button">Ver el comprobante</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (draft.status === 'DESCARTADO') {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <XCircle size={28} className="mx-auto mb-3 text-text-soft" />
        <p className="mb-1 text-sm font-semibold text-text">Esta lectura está descartada.</p>
        <p className="mb-4 text-sm text-text-soft">
          Si la factura sigue sin cargarse, subila de nuevo desde Compras con IA.
        </p>
        <Link to="/compras-ia"><Button type="button">Volver al listado</Button></Link>
      </div>
    );
  }

  // Un EXTRAIDO sin raw_extraction es una lectura que nunca ocurrió: se trata
  // igual que un ERROR, con su botón de reintentar, en vez de mostrar un
  // formulario vacío que parece normal.
  const lecturaFallida = draft.status === 'ERROR' || !draft.rawExtraction;

  if (lecturaFallida) {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <AlertTriangle size={28} className="mx-auto mb-3 text-danger" />
        <p className="mb-4 text-sm text-danger">
          {draft.errorMessage ?? 'No se pudo leer esta factura: la lectura quedó vacía.'}
        </p>
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

  function patchLine(index: number, patch: Partial<ReviewLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  /** Mismo default que la carga manual: en la mayoría de las facturas todos los renglones van al 21%. */
  function defaultVatRateId(): string {
    return (vatRates.find((r) => r.rate === 21) ?? vatRates[0])?.id ?? '';
  }

  function addConceptLine() {
    setLines((current) => [...current, { ...EMPTY_LINE, vatRateId: defaultVatRateId() }]);
  }

  function addArticle(article: Article) {
    if (pickerTargetIndex !== null) {
      // Completa el renglón que la IA ya había leído (cantidad, precio,
      // bonificación, alícuota): solo falta el artículo del catálogo. El
      // código y la descripción pasan a ser los del catálogo; lo impreso
      // queda a la vista debajo del renglón.
      const objetivo = pickerTargetIndex;
      patchLine(objetivo, { articleId: article.id, code: article.code, description: article.description });
      // Y se guarda con qué código lo llama el proveedor, que es lo que hace
      // que la próxima factura reconozca ese renglón sola en vez de volver a
      // pedir que lo elijan a mano.
      void recordarCodigo(objetivo, article.id);
    } else {
      setLines((current) => [
        ...current,
        {
          ...EMPTY_LINE,
          articleId: article.id,
          code: article.code,
          description: article.description,
          unitPrice: article.purchasePrice ?? 0,
          vatRateId: defaultVatRateId(),
        },
      ]);
    }
    setShowPicker(false);
    setPickerTargetIndex(null);
  }

  /**
   * Deja registrado con qué código llama el proveedor a este artículo. Es
   * informativo para el renglón que ya quedó resuelto en pantalla, así que si
   * falla no se corta la carga: se avisa y el usuario sigue. Lo único que se
   * pierde es que la próxima factura vuelva a no reconocerlo.
   */
  async function recordarCodigo(index: number, articleId: string) {
    const line = lines[index];
    const codigo = (line?.printedCode ?? '').trim();
    if (!supplierId || !codigo) return;
    try {
      await linkOrCreateSupplierArticle({
        supplierId,
        supplierCode: codigo,
        description: line.printedDescription || line.description,
        purchasePrice: line.unitPrice,
        articleId,
      });
      setCatalogNote(`Código ${codigo} guardado: la próxima factura de este proveedor va a reconocer ese renglón sola.`);
    } catch (err) {
      setCatalogNote(`El renglón quedó vinculado, pero no se pudo guardar el código ${codigo}: ${getErrorMessage(err)}`);
    }
  }

  /** Da de alta el artículo del renglón y lo engancha, con el código del proveedor. */
  async function altaDesdeRenglon(index: number) {
    const line = lines[index];
    const codigo = (line?.printedCode ?? '').trim();
    if (!supplierId || !codigo) return;
    setCatalogBusy(true);
    setCatalogNote(null);
    try {
      const creado = await linkOrCreateSupplierArticle({
        supplierId,
        supplierCode: codigo,
        description: line.printedDescription || line.description,
        purchasePrice: line.unitPrice,
      });
      patchLine(index, { articleId: creado.articleId, code: creado.code, description: creado.description });
      setArticles(await fetchArticles(false));
      setCatalogNote(`${creado.code} dado de alta en el catálogo.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCatalogBusy(false);
    }
  }

  /** Lo mismo para todos los renglones sin artículo, que es el caso de una factura entera nueva. */
  async function altaDeTodosLosFaltantes() {
    if (!supplierId) return;
    setCatalogBusy(true);
    setCatalogNote(null);
    let altas = 0;
    try {
      // Secuencial a propósito: el código interno sale de una secuencia y los
      // errores tienen que poder atribuirse a un renglón concreto.
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const codigo = (line.printedCode ?? '').trim();
        if (line.articleId || !codigo) continue;
        const creado = await linkOrCreateSupplierArticle({
          supplierId,
          supplierCode: codigo,
          description: line.printedDescription || line.description,
          purchasePrice: line.unitPrice,
        });
        patchLine(i, { articleId: creado.articleId, code: creado.code, description: creado.description });
        altas += 1;
      }
      setArticles(await fetchArticles(false));
      setCatalogNote(`${altas} artículo(s) dados de alta en el catálogo.`);
    } catch (err) {
      setArticles(await fetchArticles(false));
      setError(`Se dieron de alta ${altas} artículo(s) y después falló: ${getErrorMessage(err)}`);
    } finally {
      setCatalogBusy(false);
    }
  }

  /**
   * Da de alta la percepción que la IA leyó y la suma al pie.
   *
   * Sin esto el importe se descarta en silencio y el comprobante cierra por
   * debajo del total impreso — que es exactamente lo que pasaba con las
   * percepciones de IIBB, porque el sistema no traía ninguna alícuota de ese
   * tipo cargada de fábrica.
   *
   * El porcentaje sale de dividir el importe impreso por el neto gravado: es
   * el mismo número que usó el proveedor, y así la alícuota queda bien para
   * las próximas facturas en vez de guardarse en cero.
   */
  async function cargarPercepcionLeida(p: { nombre: string; importe: string }) {
    const importe = parseArgNumber(p.importe);
    setRateBusy(true);
    setError(null);
    try {
      const base = totals.netTaxed;
      const porcentaje = base > 0 ? Math.round((importe / base) * 10000) / 100 : 0;
      const creada = await createTaxRate({
        ...EMPTY_TAX_RATE_FORM,
        kind: 'PERCEPCION',
        name: p.nombre.trim(),
        rate: String(porcentaje),
        base: 'NETO',
      });
      setRates(await fetchTaxRates(true));
      // Se agrega con el importe que dice el papel, no con el recalculado: si
      // el proveedor redondeó distinto, manda el papel.
      setFootTaxes((current) => [...current, { taxRateId: creada.id, amount: importe }]);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRateBusy(false);
    }
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
  // Solo los que tienen código impreso se pueden dar de alta solos: sin código
  // no hay con qué reconocerlos la próxima vez, y la RPC los rechaza.
  const unmatchedWithCode = isArticles
    ? lines.filter((line) => !line.articleId && (line.printedCode ?? '').trim() !== '').length
    : 0;

  // Alerta de precio, igual que en la carga manual. Acá importa más todavía:
  // el precio unitario lo tipeó un modelo leyendo un papel, no una persona.
  // No bloquea nada, solo avisa.
  const priceAlerts = isArticles
    ? lines
        .map((line) => {
          if (!line.articleId || line.unitPrice <= 0) return null;
          const article = articles.find((a) => a.id === line.articleId);
          if (!article) return null;
          const lastCost = article.purchasePrice;
          if (lastCost && lastCost > 0 && line.unitPrice > lastCost * 1.1) {
            const pct = Math.round(((line.unitPrice - lastCost) / lastCost) * 100);
            return `${line.code}: ${pct}% más caro que la última compra ($ ${formatMoney(lastCost)})`;
          }
          if (line.unitPrice > article.unitPrice) {
            return `${line.code}: a este costo, el precio de venta actual ($ ${formatMoney(article.unitPrice)}) queda por debajo — conviene actualizarlo`;
          }
          return null;
        })
        .filter((msg): msg is string => msg !== null)
    : [];

  const canSave =
    !!supplierId && salesPoint.trim() !== '' && Number(salesPoint) >= 0 &&
    Number(number) > 0 && !!issueDate && !!dueDate &&
    lines.length > 0 && !missingVat && !missingDescription && totals.total > 0 &&
    unmatchedArticleLines === 0 && !saving;

  async function handleDiscard() {
    if (!window.confirm('¿Descartar esta lectura? No se puede deshacer.')) return;
    try {
      await discardExtraction(draft!.id);
      navigate('/compras-ia');
    } catch (err) {
      // Sin esto, si el update fallaba el botón no hacía nada y no se sabía por qué.
      setError(describeExtractionError(getErrorMessage(err)));
    }
  }

  async function handleSave() {
    if (!canSave || !supplier || !draft) return;
    setSaving(true);
    setError(null);

    // Los dos pasos van separados a propósito. Si la RPC guarda el
    // comprobante y después falla marcar el borrador, el comprobante EXISTE:
    // decir "no se pudo guardar la compra" haría que se cargue dos veces.
    let saved: { id: string; fullNumber: string };
    try {
      saved = await savePurchaseInvoice(
        {
          kind: draft.kind, docType, letter, salesPoint: Number(salesPoint), number: Number(number),
          supplierId, issueDate, receivedDate, dueDate, paymentTermsDays: supplier.paymentTermsDays,
          generalDiscountPercent: Number(generalDiscount) || 0, movesStock, notes,
        },
        lines,
        footTaxes
      );
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
      setSaving(false);
      return;
    }

    try {
      await confirmExtraction(draft.id, saved.id);
    } catch (err) {
      setConfirmWarning({
        invoiceId: saved.id,
        fullNumber: saved.fullNumber,
        detail: getErrorMessage(err),
      });
      setSaving(false);
      return;
    }

    navigate('/compras');
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
                Proveedor{' '}
                {applied.proveedor_cuit ? (
                  <ConfidenceChip value={confianzas.proveedor_cuit} />
                ) : (
                  <span className="ml-1.5 text-[10px] font-normal normal-case text-state-wait">elegilo a mano</span>
                )}
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
                {!draft.supplierId && ((draft.rawExtraction as any)?.valores?.proveedor_cuit ? (
                  <span className="mt-1 block text-[10px] font-normal normal-case text-state-wait">
                    La IA leyó CUIT {(draft.rawExtraction as any).valores.proveedor_cuit} pero no coincide con ningún proveedor cargado.
                  </span>
                ) : (
                  <span className="mt-1 block text-[10px] font-normal normal-case text-state-wait">
                    La IA no pudo leer el CUIT del emisor.
                  </span>
                ))}
              </label>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className={labelClass}>
                  Comprobante <FieldMark applied={!!applied.tipo_comprobante} confidence={confianzas.tipo_comprobante} />
                  <select value={docType} onChange={(e) => setDocType(e.target.value as PurchaseDocType)} className={cn(inputClass, 'bg-panel')}>
                    {PURCHASE_DOC_TYPES.map((type) => (
                      <option key={type} value={type}>{PURCHASE_DOC_TYPE_LABELS[type]}</option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  Letra <FieldMark applied={!!applied.letra} confidence={confianzas.letra} />
                  <select value={letter} onChange={(e) => setLetter(e.target.value as PurchaseLetter)} className={cn(inputClass, 'bg-panel font-mono')}>
                    {(['A', 'B', 'C', 'M'] as PurchaseLetter[]).map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
                <label className={labelClass}>
                  P. venta <FieldMark applied={!!applied.punto_venta} confidence={confianzas.punto_venta} />
                  <input
                    type="number" min="0" max="99999"
                    value={salesPoint}
                    onChange={(e) => setSalesPoint(e.target.value)}
                    className={cn(inputClass, 'font-mono', salesPoint.trim() === '' && 'field-required')}
                  />
                </label>
                <label className={labelClass}>
                  Número <FieldMark applied={!!applied.numero} confidence={confianzas.numero} />
                  <input
                    type="number" min="1"
                    value={number}
                    onChange={(e) => setNumber(e.target.value)}
                    className={cn(inputClass, 'font-mono', Number(number) <= 0 && 'field-required')}
                  />
                </label>
                <label className={labelClass}>
                  Fecha <FieldMark applied={!!applied.fecha_comprobante} confidence={confianzas.fecha_comprobante} />
                  <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className={inputClass} />
                  {!applied.fecha_comprobante && (
                    <span className="mt-1 block text-[10px] font-normal normal-case text-state-wait">
                      Quedó la fecha de hoy. De ella salen el vencimiento y el período del Libro IVA.
                    </span>
                  )}
                </label>
                <label className={labelClass}>
                  Fecha de recepción
                  <input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className={inputClass} />
                </label>
              </div>

              <label className={labelClass}>
                Vencimiento
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => { setDueDate(e.target.value); setDueDateTouched(true); }}
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
          actions={isArticles ? (
            <Button type="button" onClick={() => { setPickerTargetIndex(null); setShowPicker(true); }} className="px-3">
              <Package size={16} /> Agregar artículo
            </Button>
          ) : (
            // En conceptos también hace falta: si la IA se comió uno de cinco
            // fletes, sin este botón la única salida era descartar y rehacer
            // todo a mano.
            <Button type="button" variant="ghost" onClick={addConceptLine} className="px-3">
              <Plus size={16} /> Agregar renglón
            </Button>
          )}
        />
        {unmatchedArticleLines > 0 && (
          <div className="mb-3 space-y-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs text-danger">
              <AlertTriangle size={14} />
              {unmatchedArticleLines} renglón(es) no están en el catálogo de este proveedor.
            </p>
            <p className="text-[11px] text-text-soft">
              Vinculalos a un artículo que ya exista, o dalos de alta. En los dos casos queda
              guardado el código con que los llama el proveedor, así la próxima factura los
              reconoce sola.
            </p>
            {unmatchedWithCode > 0 && (
              <Button
                type="button"
                variant="ghost"
                className="px-3"
                disabled={catalogBusy || !supplierId}
                onClick={altaDeTodosLosFaltantes}
              >
                <Plus size={16} />
                {catalogBusy ? 'Dando de alta…' : `Dar de alta los ${unmatchedWithCode} que faltan`}
              </Button>
            )}
          </div>
        )}
        {catalogNote && (
          <p className="mb-3 text-xs text-state-done">{catalogNote}</p>
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
              {lines.map((line, idx) => {
                // Lo impreso en el papel solo se muestra si difiere de lo que
                // se va a guardar: en un renglón matcheado, código y
                // descripción son los del catálogo (el artículo cuyo stock y
                // precio de compra se van a tocar), y esta línea de abajo es
                // la que permite ver si el match fue al artículo correcto.
                const printed = [line.printedCode, line.printedDescription].filter(Boolean).join(' — ');
                const showPrinted =
                  isArticles && !!line.articleId && printed !== '' &&
                  (line.printedCode !== line.code || line.printedDescription !== line.description);

                return (
                  <React.Fragment key={idx}>
                    {isArticles && !line.articleId ? (
                      <tr className="h-9 border-b border-line bg-danger-soft">
                        <td colSpan={7} className="px-2 py-1">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <button
                              type="button"
                              onClick={() => { setPickerTargetIndex(idx); setShowPicker(true); }}
                              className="text-left text-danger hover:underline"
                            >
                              {printed || line.description || 'Renglón sin artículo del catálogo asignado'} — vincular a uno existente
                            </button>
                            {(line.printedCode ?? '').trim() !== '' && (
                              <button
                                type="button"
                                disabled={catalogBusy || !supplierId}
                                onClick={() => altaDesdeRenglon(idx)}
                                className="text-[11px] font-semibold uppercase tracking-wider text-accent-deep hover:underline disabled:opacity-50"
                              >
                                Dar de alta
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-1 py-1 text-center">
                          {/* Fuera del botón de "elegir artículo": un <button>
                              adentro de otro <button> es HTML inválido. */}
                          <button
                            type="button"
                            onClick={() => setLines((c) => c.filter((_, i) => i !== idx))}
                            aria-label="Quitar renglón"
                            className="text-danger transition-colors hover:text-text"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ) : (
                      <>
                        <PurchaseItemRow
                          line={line}
                          idx={idx}
                          isArticles={isArticles}
                          concepts={concepts}
                          vatRates={vatRates}
                          onPatch={(patch) => patchLine(idx, patch)}
                          onRemove={() => setLines((current) => current.filter((_, i) => i !== idx))}
                        />
                        {showPrinted && (
                          <tr className={cn('border-b border-line', idx % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
                            <td colSpan={8} className="px-2 pb-1.5 text-[11px] leading-tight text-text-soft">
                              En la factura decía: <span className="font-mono">{printed}</span>
                            </td>
                          </tr>
                        )}
                      </>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Sin este cartel, el botón de guardar se apagaba sin decir por qué. */}
        {(missingVat || missingDescription) && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-danger">
            <AlertTriangle size={14} />
            {missingDescription ? 'Hay renglones sin detalle.' : 'Hay renglones sin alícuota de IVA.'}
          </p>
        )}

        {priceAlerts.length > 0 && (
          <div className="mt-3 rounded-md border border-state-wait/40 bg-state-wait/10 px-3 py-2 text-xs text-text">
            <p className="flex items-center gap-1.5 font-semibold text-state-wait">
              <AlertTriangle size={14} /> Precio distinto al habitual
            </p>
            <ul className="mt-1 space-y-0.5 pl-5 text-text-soft" style={{ listStyleType: 'disc' }}>
              {priceAlerts.map((msg, i) => <li key={i}>{msg}</li>)}
            </ul>
          </div>
        )}
      </Panel>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel className="p-5">
          <SectionHeader title="Impuestos del pie" />
          {unmatchedPercepciones.length > 0 && (
            <div className="mb-3 rounded-md border border-state-wait/40 bg-state-wait/10 px-3 py-2 text-xs text-text">
              <p className="flex items-center gap-1.5 font-semibold text-state-wait">
                <AlertTriangle size={14} /> Percepciones leídas sin alícuota cargada
              </p>
              <ul className="mt-1 space-y-0.5 pl-5 text-text-soft" style={{ listStyleType: 'disc' }}>
                {unmatchedPercepciones.map((p, i) => (
                  <li key={i}>
                    «{p.nombre}» $ {formatMoney(parseArgNumber(p.importe))}.{' '}
                    <button
                      type="button"
                      disabled={rateBusy}
                      onClick={() => cargarPercepcionLeida(p)}
                      className="font-semibold text-accent-deep hover:underline disabled:opacity-50"
                    >
                      Cargar esta alícuota y sumarla
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
          {/* El chip suelto bajo el título era un porcentaje sin campo al que
              referirse: va pegado al total que la IA leyó del papel, que es lo
              que mide. */}
          {aiTotal !== null && (
            <p className="mb-3 text-[11px] text-text-soft">
              Total leído del papel: <span className="font-mono text-text">$ {formatMoney(aiTotal)}</span>
              <ConfidenceChip value={confianzas.total} />
            </p>
          )}
          <PurchaseTotalsSummary
            totals={totals}
            generalDiscount={generalDiscount}
            onGeneralDiscountChange={setGeneralDiscount}
            declaredTotal={declaredTotal}
            onDeclaredTotalChange={setDeclaredTotal}
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
