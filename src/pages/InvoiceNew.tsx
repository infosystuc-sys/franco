import React from 'react';
import { XCircle, Receipt, AlertTriangle, ArrowRight, CalendarClock, Banknote } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import {
  fetchCompanySettings,
  formatAddress,
  isReadyToInvoice,
  type CompanySettings,
} from '@/src/lib/companySettings';
import {
  computeTotals,
  describeInvoiceError,
  discriminatesVat,
  fetchInvoiceForWorkOrder,
  formatDate,
  INVOICE_TYPE_LABELS,
  INVOICE_TYPE_REASON,
  invoiceTypeFor,
  issueInvoice,
  PAYMENT_TERMS_DAYS,
  toDateString,
  type InvoiceType,
  type WorkOrderInvoiceRef,
} from '@/src/lib/invoices';
import {
  fetchWorkOrderByNumber,
  getErrorMessage,
  type WorkOrderDetail,
  type WorkOrderItemInput,
} from '@/src/lib/workOrders';
import { fetchPaymentMethods, type PaymentMethod } from '@/src/lib/paymentMethods';
import { describeReceiptError, saveReceipt } from '@/src/lib/receipts';

/**
 * El proceso de facturación de una orden.
 *
 * El borrador vive en memoria: hasta que se confirma no existe ninguna fila.
 * Así el correlativo no se consume en falso y no quedan comprobantes a medio
 * hacer ensuciando el listado ni la cuenta corriente.
 */
export function InvoiceNew() {
  const { role } = useAuth();
  const { otNumber } = useParams();
  const navigate = useNavigate();

  const [order, setOrder] = React.useState<WorkOrderDetail | null>(null);
  const [company, setCompany] = React.useState<CompanySettings | null>(null);
  const [existing, setExisting] = React.useState<WorkOrderInvoiceRef | null>(null);
  const [items, setItems] = React.useState<WorkOrderItemInput[]>([]);
  const [notes, setNotes] = React.useState('');
  const [emitRemito, setEmitRemito] = React.useState(false);
  const [paymentMethods, setPaymentMethods] = React.useState<PaymentMethod[]>([]);
  const [isCash, setIsCash] = React.useState(false);
  const [paymentMethodId, setPaymentMethodId] = React.useState('');
  const [articles, setArticles] = React.useState<Article[]>([]);

  const [loading, setLoading] = React.useState(true);
  const [issuing, setIssuing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!otNumber || role !== 'admin') return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const workOrder = await fetchWorkOrderByNumber(otNumber!);
        if (cancelled) return;
        setOrder(workOrder);

        if (workOrder) {
          setItems(
            workOrder.items.map((item) => ({
              articleId: item.articleId ?? null,
              code: item.code,
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            }))
          );
          const [settings, invoice] = await Promise.all([
            fetchCompanySettings(),
            fetchInvoiceForWorkOrder(workOrder.id),
          ]);
          if (cancelled) return;
          setCompany(settings);
          setExisting(invoice);
        }
      } catch (err) {
        if (!cancelled) setError(describeInvoiceError(getErrorMessage(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    // El catálogo es opcional: sirve para agregar renglones que no estaban en la OT.
    fetchArticles(false)
      .then((data) => !cancelled && setArticles(data))
      .catch(() => {});
    fetchPaymentMethods(true)
      .then((data) => !cancelled && setPaymentMethods(data))
      .catch(() => {/* si falla, el check de contado queda sin opciones y no se puede tildar */});

    return () => {
      cancelled = true;
    };
  }, [otNumber, role]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">Cargando orden…</div>;
  }

  if (!order) {
    return (
      <Blocked title={`No se encontró la orden ${otNumber}.`}>
        <Link to="/" className="text-accent-deep underline">Volver al panel</Link>
      </Blocked>
    );
  }

  // ── Guardas. Las mismas que valida la base; acá están para explicarlas.
  if (existing) {
    return (
      <Blocked title={`La orden ${order.number} ya está facturada.`}>
        <p className="mb-4 text-sm text-text-soft">
          Para volver a facturarla hay que anular primero el comprobante vigente.
        </p>
        <Link to={`/factura/${existing.id}`}>
          <Button>
            <Receipt size={16} /> Ver {INVOICE_TYPE_LABELS[existing.invoiceType]} {existing.fullNumber}
          </Button>
        </Link>
      </Blocked>
    );
  }

  if (!order.status.isTerminal) {
    return (
      <Blocked title={`La orden ${order.number} todavía no está terminada.`}>
        <p className="mb-4 text-sm text-text-soft">
          Está en <strong>{order.status.label}</strong>. Se factura recién
          cuando el trabajo cierra, para no emitir sobre renglones que todavía
          pueden cambiar.
        </p>
        <Link to={`/orden/${order.number}`}>
          <Button variant="ghost">
            <XCircle size={16} /> Volver a la orden
          </Button>
        </Link>
      </Blocked>
    );
  }

  if (!isReadyToInvoice(company)) {
    return (
      <Blocked title="Faltan los datos fiscales del taller.">
        <p className="mb-4 text-sm text-text-soft">
          La razón social, el CUIT y el punto de venta encabezan cada factura y
          definen la letra del comprobante. Sin ellos no se puede emitir.
        </p>
        <Link to="/configuracion">
          <Button>
            Cargar datos fiscales <ArrowRight size={16} />
          </Button>
        </Link>
      </Blocked>
    );
  }

  const settings = company!;
  const customerCondition = order.customer?.tax_condition ?? 'CONSUMIDOR_FINAL';
  const invoiceType = invoiceTypeFor(settings.taxCondition, customerCondition);
  const totals = computeTotals(items, invoiceType);

  const issueDate = new Date();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + PAYMENT_TERMS_DAYS);

  const emptyLines = items.filter((item) => item.description.trim() === '').length;
  const canIssue =
    items.length > 0 && totals.total > 0 && emptyLines === 0 &&
    (!isCash || !!paymentMethodId) && !issuing;

  async function handleIssue() {
    if (!order || !canIssue || !order.customer) return;
    const confirmed = window.confirm(
      `Emitir ${INVOICE_TYPE_LABELS[invoiceType]} por $ ${formatMoney(totals.total)} ` +
        `a ${order.customer?.name ?? 'el cliente'}${isCash ? ' y cobrarla de contado' : ''}?\n\n` +
        `Una vez emitida no se puede editar: solo anular.`
    );
    if (!confirmed) return;

    setIssuing(true);
    setError(null);
    try {
      const issued = await issueInvoice(order.id, items, notes, emitRemito);
      if (isCash) {
        try {
          await saveReceipt(
            { customerId: order.customer.id, receiptDate: toDateString(new Date()), notes: 'Factura de contado' },
            [{ invoiceId: issued.id, amount: totals.total }],
            [{ kind: 'MEDIO_PAGO', amount: totals.total, paymentMethodId }]
          );
        } catch (receiptErr) {
          window.alert(
            `La factura ${issued.fullNumber} se emitió, pero el cobro automático falló: ` +
              `${describeReceiptError(getErrorMessage(receiptErr))}\n\nRegistrá el cobro a mano desde Cobranzas.`
          );
        }
      }
      navigate(`/factura/${issued.id}`);
    } catch (err) {
      setError(describeInvoiceError(getErrorMessage(err)));
      setIssuing(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Facturar"
        meta={<InvoiceTypeBadge type={invoiceType} />}
        subtitle={
          <Link
            to={`/orden/${order.number}`}
            className="inline-flex items-center gap-1.5 text-accent-deep hover:underline"
          >
            <XCircle size={14} /> Desde la orden {order.number}
            {order.component ? ` · ${order.component}` : ''}
          </Link>
        }
        actions={
          <>
            <Link to={`/orden/${order.number}`}>
              <Button variant="ghost" type="button">Cancelar</Button>
            </Link>
            <Button onClick={handleIssue} disabled={!canIssue}>
              <Receipt size={16} /> {issuing ? 'Emitiendo…' : 'Emitir factura'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Emisor
          </span>
          <span className="block text-sm font-semibold text-text">{settings.legalName}</span>
          <span className="mt-1.5 block text-xs text-text-soft">
            {settings.taxId && <span className="font-mono">{formatCuit(settings.taxId)} · </span>}
            {TAX_CONDITION_LABELS[settings.taxCondition]}
          </span>
          <span className="mt-1 block font-mono text-[11px] text-text-faint">
            Punto de venta {String(settings.salesPoint).padStart(4, '0')}
          </span>
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Cliente
          </span>
          <span className="block text-sm font-semibold text-text">
            {order.customer?.legal_name || order.customer?.name || '—'}
          </span>
          <span className="mt-1.5 block text-xs text-text-soft">
            {order.customer?.tax_id && (
              <span className="font-mono">{formatCuit(order.customer.tax_id)} · </span>
            )}
            {TAX_CONDITION_LABELS[customerCondition]}
          </span>
          {order.customer && (
            <span className="mt-1 block text-[11px] text-text-faint">
              {formatAddress({
                addressStreet: order.customer.address_street,
                addressCity: order.customer.address_city,
                addressState: order.customer.address_state,
                addressZip: order.customer.address_zip,
              }) || 'Sin domicilio cargado'}
            </span>
          )}
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Condición de pago
          </span>
          <span className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <CalendarClock size={15} className="text-accent-deep" /> Cuenta corriente
          </span>
          <span className="mt-1.5 block text-xs text-text-soft">
            Emisión {formatDate(toDateString(issueDate))}
          </span>
          <span className="block text-xs text-text-soft">
            Vence {formatDate(toDateString(dueDate))} ({PAYMENT_TERMS_DAYS} días)
          </span>
        </Panel>
      </div>

      <Panel className="mb-6 p-5">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable
          title="Renglones a facturar"
          totals={<InvoiceTotals type={invoiceType} totals={totals} />}
        />

        {emptyLines > 0 && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-danger">
            <AlertTriangle size={14} />
            {emptyLines === 1
              ? 'Hay un renglón sin descripción.'
              : `Hay ${emptyLines} renglones sin descripción.`}
          </p>
        )}
      </Panel>

      <Panel className="mb-6 p-5">
        <SectionHeader title="Observaciones" />
        <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
          <input
            type="checkbox"
            checked={emitRemito}
            onChange={(e) => setEmitRemito(e.target.checked)}
            className="w-4 h-4 accent-accent-deep"
          />
          Emitir remito junto con la factura
        </label>

        <CashCheckoutFields
          isCash={isCash}
          onIsCashChange={setIsCash}
          paymentMethods={paymentMethods}
          paymentMethodId={paymentMethodId}
          onPaymentMethodIdChange={setPaymentMethodId}
        />

        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Texto que sale impreso en el comprobante. Opcional."
          className="mt-4 w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
        />
      </Panel>

      <div className="mb-10 flex flex-wrap items-center justify-between gap-3 border border-line bg-panel-alt px-5 py-4">
        <p className="max-w-xl text-xs text-text-soft">
          Los renglones vienen de la orden y se pueden ajustar acá. Al emitir, la
          factura queda congelada: para corregirla hay que anularla y volver a
          facturar la orden.
        </p>
        <Button onClick={handleIssue} disabled={!canIssue}>
          <Receipt size={16} /> {issuing ? 'Emitiendo…' : 'Emitir factura'}
        </Button>
      </div>
    </div>
  );
}

/** La letra del comprobante, con el motivo a la vista antes de confirmar. */
export function InvoiceTypeBadge({ type }: { type: InvoiceType }) {
  return (
    <span
      title={INVOICE_TYPE_REASON[type]}
      className="inline-flex items-center gap-2 border border-line-strong bg-panel px-2.5 py-1"
    >
      <span className="font-display text-xl font-medium leading-none text-text">{type}</span>
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-soft">
        {INVOICE_TYPE_LABELS[type]}
      </span>
    </span>
  );
}

/**
 * Totales según la letra. En la A el IVA se discrimina, en la B va incluido y
 * en la C no existe: por eso no sirve el cuadro fijo de ItemsEditor.
 */
export function InvoiceTotals({
  type,
  totals,
}: {
  type: InvoiceType;
  totals: { net: number; vat: number; total: number };
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <p className="max-w-sm text-xs text-text-soft">{INVOICE_TYPE_REASON[type]}</p>

      <div className="w-full space-y-2 border border-line bg-panel-alt p-4 md:w-1/3">
        {discriminatesVat(type) ? (
          <>
            <div className="flex justify-between text-xs text-text-soft">
              <span>Neto gravado</span>
              <span className="text-text">$ {formatMoney(totals.net)}</span>
            </div>
            <div className="flex justify-between text-xs text-text-soft">
              <span>IVA 21%</span>
              <span className="text-text">$ {formatMoney(totals.vat)}</span>
            </div>
          </>
        ) : (
          <div className="flex justify-between text-xs text-text-soft">
            <span>Subtotal</span>
            <span className="text-text">$ {formatMoney(totals.total)}</span>
          </div>
        )}
        <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</span>
          <span className="font-display text-2xl font-medium text-text">
            $ {formatMoney(totals.total)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Check de "factura de contado": genera y aplica el recibo en el mismo paso
 * que la emisión, para no tener que ir después a Cobranzas a buscar la
 * factura recién hecha y cobrarla a mano. Comparte esta pieza InvoiceNew e
 * InvoiceNewFree — mismo comportamiento, con o sin OT de por medio.
 */
export function CashCheckoutFields({
  isCash,
  onIsCashChange,
  paymentMethods,
  paymentMethodId,
  onPaymentMethodIdChange,
}: {
  isCash: boolean;
  onIsCashChange: (value: boolean) => void;
  paymentMethods: PaymentMethod[];
  paymentMethodId: string;
  onPaymentMethodIdChange: (value: string) => void;
}) {
  // La cartera de cheques no es un medio de pago elegible acá: se mueve
  // desde la pantalla de Cheques, no cobrando una factura con ella.
  const selectableMethods = paymentMethods.filter((m) => m.kind !== 'CARTERA_CHEQUES');

  return (
    <div className="mt-3">
      <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
        <input
          type="checkbox"
          checked={isCash}
          onChange={(e) => onIsCashChange(e.target.checked)}
          className="w-4 h-4 accent-accent-deep"
        />
        Factura de contado — cobrarla al emitir
      </label>

      {isCash && (
        <label className="mt-2 block max-w-xs text-xs font-bold uppercase tracking-wider text-text-soft">
          <span className="flex items-center gap-1.5">
            <Banknote size={13} className="text-accent-deep" /> Medio de pago
          </span>
          <select
            value={paymentMethodId}
            onChange={(e) => onPaymentMethodIdChange(e.target.value)}
            className={cn(
              'mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none',
              !paymentMethodId && 'field-required'
            )}
          >
            <option value="">Elegí un medio...</option>
            {selectableMethods.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          {selectableMethods.length === 0 && (
            <span className="mt-1 block text-[10px] font-normal normal-case text-state-wait">
              No hay medios de pago activos. Cargá uno desde Medios de pago.
            </span>
          )}
        </label>
      )}
    </div>
  );
}

/** Pantalla de corte: no se puede facturar, y se explica por qué. */
export function Blocked({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Facturar" />
      <Panel className={cn('p-8 text-center')}>
        <AlertTriangle size={28} className="mx-auto mb-3 text-accent-deep" />
        <h2 className="mb-2 font-display text-xl uppercase tracking-[0.06em] text-text">{title}</h2>
        {children}
      </Panel>
    </div>
  );
}
