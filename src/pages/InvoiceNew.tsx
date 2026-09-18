import React from 'react';
import { XCircle, Receipt, AlertTriangle, ArrowRight, Banknote } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { formatCuit } from '@/src/lib/fiscal';
import { fetchCustomers, type Customer } from '@/src/lib/customers';
import {
  fetchCompanySettings,
  isReadyToInvoice,
  type CompanySettings,
} from '@/src/lib/companySettings';
import {
  computeTotals,
  CONDICION_VENTA_LABELS,
  describeInvoiceError,
  discriminatesVat,
  fetchInvoiceForWorkOrder,
  formatDate,
  INVOICE_TYPE_LABELS,
  invoiceTypeFor,
  issueInvoice,
  fetchProximoNumero,
  LETRAS_EMISIBLES,
  PAYMENT_TERMS_DAYS,
  toDateString,
  type CondicionVenta,
  type InvoiceType,
  type WorkOrderInvoiceRef,
  reasignarClienteDeOrden,
} from '@/src/lib/invoices';
import {
  fetchWorkOrderByNumber,
  getErrorMessage,
  type WorkOrderDetail,
  type WorkOrderItemInput,
} from '@/src/lib/workOrders';
import { fetchPaymentMethods, type PaymentMethod } from '@/src/lib/paymentMethods';
import { describeReceiptError, saveReceipt } from '@/src/lib/receipts';
import { fetchBanks, type Bank } from '@/src/lib/banks';
import { CheckDraftModal, type CheckDraft } from '@/src/components/CheckDraftModal';
import { CustomerModal } from '@/src/components/CustomerModal';

/**
 * Un dato de la cabecera: rótulo chico arriba, valor abajo. Sin recuadro
 * propio — los datos viven sueltos adentro del bloque que encierran las dos
 * líneas amarillas, y un borde por dato lo volvía una grilla de cuadraditos.
 */
export function FieldBox({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <span className="block text-[11px] font-bold uppercase tracking-wider text-text-faint">
        {label}
      </span>
      <div className="mt-1 text-sm text-text">{children}</div>
    </div>
  );
}

/**
 * Los desplegables de la cabecera, con el mismo formato que el del cliente:
 * caja con borde y flecha. Antes iban sin borde sobre el fondo, y no se leían
 * como algo que se pudiera abrir.
 */
export const selectCabecera =
  'w-full rounded-md border border-line bg-panel px-2 py-1.5 text-sm text-text ' +
  'focus:border-accent-deep focus:outline-none';

/**
 * Sí / No en vez de un tilde. Un checkbox obliga a leer la etiqueta para saber
 * qué pasa si no se toca; con dos botones, cuál está elegido se ve de lejos.
 */
export function SiNo({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border border-line overflow-hidden">
      {[true, false].map((opcion) => (
        <button
          key={String(opcion)}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opcion)}
          className={cn(
            'px-4 py-1 text-[13px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50',
            value === opcion
              ? 'bg-accent text-accent-ink'
              : 'bg-panel text-text-soft hover:bg-panel-alt'
          )}
        >
          {opcion ? 'Sí' : 'No'}
        </button>
      ))}
    </div>
  );
}

/**
 * La barra del comprobante: título y letra a la izquierda, el total bien
 * grande y las acciones a la derecha, todo en una sola línea. Queda fija
 * arriba mientras se scrollea la ficha, como la barra de un sistema de
 * facturación de escritorio — ahí es donde se mira antes de confirmar, no
 * tiene sentido que se pierda de vista con renglones largos.
 */
export function InvoiceTopBar({
  title,
  cancelHref,
  onIssue,
  issuing,
  canIssue,
}: {
  title: string;
  cancelHref: string;
  onIssue: () => void;
  issuing: boolean;
  canIssue: boolean;
}) {
  return (
    <div
      className="sticky z-20 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b-[3px] border-accent bg-panel px-4 py-3 sm:px-5"
      style={{ top: 'calc(3.5rem + var(--safe-top))' }}
    >
      {/* Solo el título: la letra, el número y el total viven abajo, cada uno
          al lado del campo que los define. Arriba quedan las dos decisiones
          que cierran la pantalla. */}
      <h1 className="font-display text-xl uppercase tracking-[0.04em] text-text leading-none">{title}</h1>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Link to={cancelHref}>
            <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
          </Link>
          <Button onClick={onIssue} disabled={!canIssue}>
            <Receipt size={16} /> {issuing ? 'Emitiendo…' : 'Emitir factura'}
          </Button>
        </div>
      </div>
    </div>
  );
}

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
  const [invoiceType, setInvoiceType] = React.useState<InvoiceType>('X');
  // Sin valor inicial: elegirla es parte de emitir, y un default se confirma
  // sin mirarlo. La base también la exige.
  const [condicion, setCondicion] = React.useState<CondicionVenta | ''>('');
  const [proximo, setProximo] = React.useState<string | null>(null);
  const [altaCliente, setAltaCliente] = React.useState(false);
  // Vacío = el plazo por defecto. Solo se usa en cuenta corriente.
  const [vencimiento, setVencimiento] = React.useState('');
  const [paymentMethods, setPaymentMethods] = React.useState<PaymentMethod[]>([]);
  const [paymentMethodId, setPaymentMethodId] = React.useState('');
  const [banks, setBanks] = React.useState<Bank[]>([]);
  const [checkDrafts, setCheckDrafts] = React.useState<CheckDraft[] | null>(null);
  const [checkModalOpen, setCheckModalOpen] = React.useState(false);
  const [articles, setArticles] = React.useState<Article[]>([]);

  const [loading, setLoading] = React.useState(true);
  const [issuing, setIssuing] = React.useState(false);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [cambiandoCliente, setCambiandoCliente] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // El número que va a llevar la factura, para mostrarlo antes de emitir. Se
  // vuelve a pedir con cada cambio de letra porque cada una tiene su propia
  // numeración y su propio punto de venta.
  React.useEffect(() => {
    let cancelado = false;
    fetchProximoNumero(invoiceType)
      .then((p) => !cancelado && setProximo(p?.fullNumber ?? null))
      .catch(() => !cancelado && setProximo(null));
    return () => { cancelado = true; };
  }, [invoiceType]);

  // La recarga vive en un ref porque la arma el efecto, con sus propias
  // variables de cancelación, y hace falta desde afuera al cambiar el cliente.
  const recargarRef = React.useRef<null | (() => Promise<void>)>(null);
  const recargar = React.useCallback(async () => {
    await recargarRef.current?.();
  }, []);

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
    recargarRef.current = load;
    // Para poder cambiar a quién se factura sin salir de la pantalla.
    fetchCustomers(true)
      .then((data) => !cancelled && setCustomers(data))
      .catch(() => {/* si falla, no se puede cambiar el cliente pero se factura igual */});
    // El catálogo es opcional: sirve para agregar renglones que no estaban en la OT.
    fetchArticles(false)
      .then((data) => !cancelled && setArticles(data))
      .catch(() => {});
    fetchPaymentMethods(true)
      .then((data) => !cancelled && setPaymentMethods(data))
      .catch(() => {/* si falla, el check de contado queda sin opciones y no se puede tildar */});
    fetchBanks(true)
      .then((data) => !cancelled && setBanks(data))
      .catch(() => {/* si falla, el combobox de banco del cheque arranca vacío pero se puede cargar uno nuevo igual */});

    return () => {
      cancelled = true;
    };
  }, [otNumber, role]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="w-full p-8 text-center text-text-soft">Cargando orden…</div>;
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
  // La letra la elige quien emite. Para el IVA manda la que le correspondería
  // al cliente, también en la X, para que el total dé lo mismo en las dos
  // numeraciones; lo que cambia es que la X no lo discrimina al imprimirse.
  const letraFiscal = invoiceTypeFor(settings.taxCondition, customerCondition);
  const totals = computeTotals(items, invoiceType === 'X' ? letraFiscal : invoiceType);

  // Contado es exactamente lo que antes era el check de "factura de contado":
  // se cobra en el mismo acto de emitir.
  const isCash = condicion === 'CONTADO';

  const issueDate = new Date();
  const dueDate = new Date();
  if (!isCash) dueDate.setDate(dueDate.getDate() + PAYMENT_TERMS_DAYS);

  const emptyLines = items.filter((item) => item.description.trim() === '').length;
  const canIssue =
    items.length > 0 && totals.total > 0 && emptyLines === 0 && condicion !== '' &&
    (!isCash || !!paymentMethodId || !!checkDrafts?.length) && !issuing;

  /**
   * Cambiar el cliente antes de emitir. Se recarga la orden después: el tipo
   * de factura (A/B) depende de la condición frente al IVA del cliente, así
   * que con el cliente cambia también qué comprobante corresponde.
   */
  async function handleCambiarCliente(customerId: string) {
    if (!order || !customerId || customerId === order.customer?.id) return;
    const elegido = customers.find((c) => c.id === customerId);
    if (!window.confirm(
      `¿Facturar esta orden a ${elegido?.name ?? 'ese cliente'}?\n\n` +
      'Se reasignan también la orden y su presupuesto. El vehículo sigue siendo de su dueño.'
    )) return;

    setCambiandoCliente(true);
    setError(null);
    try {
      await reasignarClienteDeOrden(order.id, customerId);
      await recargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCambiandoCliente(false);
    }
  }

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
      const issued = await issueInvoice(
        order.id, items, notes, emitRemito, invoiceType, condicion as CondicionVenta,
        isCash ? null : (vencimiento || null)
      );
      if (isCash) {
        try {
          const values = checkDrafts?.length
            ? checkDrafts.map((c) => ({
                kind: 'CHEQUE' as const,
                amount: c.amount,
                checkNumber: c.checkNumber,
                checkBank: c.checkBank,
                checkDueDate: c.checkDueDate,
              }))
            : [{ kind: 'MEDIO_PAGO' as const, amount: totals.total, paymentMethodId }];
          await saveReceipt(
            { customerId: order.customer.id, receiptDate: toDateString(new Date()), notes: 'Factura de contado' },
            [{ invoiceId: issued.id, amount: totals.total }],
            values
          );
        } catch (receiptErr) {
          window.alert(
            `La factura ${issued.fullNumber} se emitió, pero el cobro automático falló: ` +
              `${describeReceiptError(getErrorMessage(receiptErr))}\n\nRegistrá el cobro a mano desde Cobranzas.`
          );
        }
      }
      navigate('/facturas');
    } catch (err) {
      setError(describeInvoiceError(getErrorMessage(err)));
      setIssuing(false);
    }
  }

  return (
    <div className="w-full">
      <InvoiceTopBar
        title="Factura de venta"
        cancelHref={`/orden/${order.number}`}
        onIssue={handleIssue}
        issuing={issuing}
        canIssue={canIssue}
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Los datos del comprobante, entre las dos líneas amarillas: la de
          arriba la pone la barra, la de abajo cierra este bloque. Sin recuadro
          por dato — son dos filas corridas. */}
      <div className="mb-6 grid grid-cols-2 gap-x-6 gap-y-4 border-b-2 border-accent px-4 py-4 sm:grid-cols-3 sm:px-5">
        <FieldBox label="Cliente" className="col-span-2">
          <span className="block truncate font-semibold text-text">
            {order.customer?.legal_name || order.customer?.name || '—'}
          </span>
          {/* A quién se le factura puede no ser quien trajo el vehículo: la
              empresa del titular, el seguro, la contratista. Se cambia acá,
              antes de emitir, porque después la factura ya salió con un
              nombre. */}
          <select
            value={order.customer?.id ?? ''}
            disabled={cambiandoCliente || customers.length === 0}
            onChange={(e) => handleCambiarCliente(e.target.value)}
            className={cn(selectCabecera, 'mt-1.5 disabled:opacity-50')}
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.taxId ? ` — ${formatCuit(c.taxId)}` : ''}
              </option>
            ))}
          </select>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-[11px] normal-case text-text-soft">
              {cambiandoCliente ? 'Cambiando…' : 'Cambiar acá reasigna también la orden y su presupuesto.'}
            </span>
            {/* El cliente nuevo aparece acá y no en la pantalla de Clientes:
                si el que trajo el vehículo no está cargado, facturar no puede
                obligar a salir, darlo de alta y volver a empezar. */}
            <button
              type="button"
              onClick={() => setAltaCliente(true)}
              className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
            >
              + Nuevo
            </button>
          </div>
        </FieldBox>

        <FieldBox label="Tipo de factura">
          <select
            value={invoiceType}
            onChange={(e) => setInvoiceType(e.target.value as InvoiceType)}
            className={selectCabecera}
          >
            {LETRAS_EMISIBLES.map((l) => (
              <option key={l} value={l}>{INVOICE_TYPE_LABELS[l]}</option>
            ))}
          </select>
          {/* El número va acá y no en el encabezado: es lo que define esta
              letra, y cambia con ella. Todavía no está emitido, así que es el
              que le va a tocar. */}
          <span className="mt-1 block font-mono text-[12px] normal-case text-text-soft">
            {proximo ?? (invoiceType === 'X' ? 'Sin validez fiscal' : 'Numeración fiscal')}
          </span>
        </FieldBox>

        <FieldBox label="Condición de venta">
          <select
            value={condicion}
            onChange={(e) => setCondicion(e.target.value as CondicionVenta)}
            className={cn(selectCabecera, condicion === '' && 'border-danger text-danger')}
          >
            <option value="">Elegí una…</option>
            <option value="CUENTA_CORRIENTE">{CONDICION_VENTA_LABELS.CUENTA_CORRIENTE}</option>
            <option value="CONTADO">{CONDICION_VENTA_LABELS.CONTADO}</option>
          </select>
          <span className="mt-1 block text-[11px] normal-case text-text-soft">
            {condicion === ''
              ? 'Obligatoria para emitir'
              : isCash
                ? 'Se cobra al emitir'
                : `Vence a ${PAYMENT_TERMS_DAYS} días`}
          </span>
        </FieldBox>

        <FieldBox label="Emisión">
          <span className="block">{formatDate(toDateString(issueDate))}</span>
          <span className="block text-[11px] normal-case text-text-soft">Hoy</span>
        </FieldBox>

        <FieldBox label="Vencimiento">
          {condicion === 'CUENTA_CORRIENTE' ? (
            <>
              <input
                type="date"
                value={vencimiento || toDateString(dueDate)}
                min={toDateString(issueDate)}
                onChange={(e) => setVencimiento(e.target.value)}
                className="w-full border-0 bg-transparent p-0 font-mono text-[13px] font-semibold text-text focus:outline-none"
              />
              <span className="mt-1 block text-[11px] normal-case text-text-soft">
                Se puede corregir después desde la factura.
              </span>
            </>
          ) : (
            <>
              <span className="block">
                {condicion === '' ? '—' : formatDate(toDateString(issueDate))}
              </span>
              <span className="mt-1 block text-[11px] normal-case text-text-soft">
                {condicion === '' ? 'Según la condición de venta' : 'Contado: vence el mismo día'}
              </span>
            </>
          )}
        </FieldBox>

        <FieldBox label="Remito">
          <SiNo value={emitRemito} onChange={setEmitRemito} />
          <span className="mt-1 block text-[11px] normal-case text-text-soft">
            Emitir junto con la factura
          </span>
        </FieldBox>
      </div>

      <Panel className="mb-4 rounded-lg p-4">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable
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

      {/* Cómo se cobra y las observaciones, en la misma franja: son las dos
          últimas decisiones antes de emitir, y ninguna de las dos necesita
          el espacio de un panel entero. */}
      <div className="mb-10 grid grid-cols-1 gap-2 md:grid-cols-2">
        <Panel className="rounded-lg p-4">
          <SectionHeader title="Cómo se cobra" className="mb-3" />
          <CashCheckoutFields
            isCash={isCash}
            paymentMethods={paymentMethods}
            paymentMethodId={paymentMethodId}
            onPaymentMethodIdChange={setPaymentMethodId}
            checkDrafts={checkDrafts}
            onOpenCheckModal={() => setCheckModalOpen(true)}
            onClearChecks={() => setCheckDrafts(null)}
          />
        </Panel>

        <Panel className="rounded-lg p-4">
          <SectionHeader title="Observaciones" className="mb-3" />
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Texto que sale impreso en el comprobante. Opcional."
            className="w-full resize-y border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
          />
        </Panel>
      </div>

      {altaCliente && (
        <CustomerModal
          customer={null}
          onClose={() => setAltaCliente(false)}
          onSaved={async (nuevo) => {
            setAltaCliente(false);
            setCustomers((actuales) => [...actuales, nuevo].sort((a, b) => a.name.localeCompare(b.name)));
            // Se le factura al que se acaba de cargar: es para eso que se lo
            // dio de alta acá y no en la pantalla de Clientes.
            await handleCambiarCliente(nuevo.id);
          }}
        />
      )}

      {checkModalOpen && (
        <CheckDraftModal
          remainingBase={totals.total}
          banks={banks}
          onBankCreated={(bank) => setBanks((current) => [...current, bank])}
          onConfirm={(checks) => {
            setCheckDrafts(checks);
            setCheckModalOpen(false);
          }}
          onClose={() => setCheckModalOpen(false)}
        />
      )}
    </div>
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
  // Solo los totales: la explicación de por qué salió esa letra se fue con el
  // resto del texto estático — la letra se elige a mano y está a la vista en
  // la cabecera.
  return (
    <div className="flex justify-end">
      <div className="w-full space-y-2 rounded-lg border border-line bg-panel-alt p-4 md:w-1/3">
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
          <span className="text-[13px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</span>
          <span className="font-display text-2xl font-medium text-text">
            $ {formatMoney(totals.total)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Con qué se cobra una factura de contado: genera y aplica el recibo en el
 * mismo paso que la emisión, para no tener que ir después a Cobranzas a buscar
 * la factura recién hecha y cobrarla a mano. Comparte esta pieza InvoiceNew e
 * InvoiceNewFree — mismo comportamiento, con o sin OT de por medio.
 *
 * Que la factura sea de contado ya no se decide acá: lo dice la condición de
 * venta del encabezado, y este bloque solo aparece cuando es contado.
 */
/** Valor centinela del select: elegirlo abre el modal de carga en vez de fijar un medio. */
const CHEQUE_OPTION_VALUE = '__cheque__';

export function CashCheckoutFields({
  isCash,
  paymentMethods,
  paymentMethodId,
  onPaymentMethodIdChange,
  checkDrafts,
  onOpenCheckModal,
  onClearChecks,
}: {
  isCash: boolean;
  paymentMethods: PaymentMethod[];
  paymentMethodId: string;
  onPaymentMethodIdChange: (value: string) => void;
  checkDrafts: CheckDraft[] | null;
  onOpenCheckModal: () => void;
  onClearChecks: () => void;
}) {
  // La cartera de cheques no es un medio de pago elegible acá: se mueve
  // desde la pantalla de Cheques, no cobrando una factura con ella. Pagar
  // con un cheque NUEVO (que el cliente entrega en el momento) es distinto:
  // esa opción abre el modal de carga en vez de salir de esta lista.
  const selectableMethods = paymentMethods.filter((m) => m.kind !== 'CARTERA_CHEQUES');
  const payingWithChecks = checkDrafts !== null;

  if (!isCash) {
    return (
      <p className="mt-1 text-sm text-text-soft">
        Cuenta corriente: queda impaga y se cobra después desde Cobranzas.
      </p>
    );
  }

  return (
    <div className="mt-1">
      {(
        <div className="max-w-xs">
          <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-text-soft">
            <Banknote size={13} className="text-accent-deep" /> Cobrado con
          </span>

          {payingWithChecks ? (
            <div className="mt-1 rounded-md border border-line bg-panel-alt px-3 py-2 text-xs">
              <span className="block font-semibold uppercase tracking-wider text-text-soft">
                {checkDrafts!.length === 1 ? 'Cheque cargado' : `${checkDrafts!.length} cheques cargados`}
              </span>
              {checkDrafts!.map((c, i) => (
                <span key={i} className="mt-1 block normal-case text-text">
                  {c.checkNumber} — {c.checkBank} — $ {formatMoney(c.amount)}
                </span>
              ))}
              <button
                type="button"
                onClick={onClearChecks}
                className="mt-2 text-[13px] font-semibold uppercase tracking-wider text-accent-deep hover:underline"
              >
                Cambiar
              </button>
            </div>
          ) : (
            <>
              <select
                value={paymentMethodId}
                onChange={(e) => {
                  if (e.target.value === CHEQUE_OPTION_VALUE) onOpenCheckModal();
                  else onPaymentMethodIdChange(e.target.value);
                }}
                className={cn(
                  'mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none',
                  !paymentMethodId && 'field-required'
                )}
              >
                <option value="">Elegí un medio...</option>
                {selectableMethods.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
                <option value={CHEQUE_OPTION_VALUE}>Cheque</option>
              </select>
              {selectableMethods.length === 0 && (
                <span className="mt-1 block text-[12px] font-normal normal-case text-state-wait">
                  No hay medios de pago activos. Cargá uno desde Medios de pago.
                </span>
              )}
            </>
          )}
        </div>
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
