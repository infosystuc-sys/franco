import { CobroContado, ajustarUnicoMedio, cobroCompleto, valoresDelCobro, type PagoContado } from '@/src/components/CobroContado';
import React from 'react';
import { XCircle, Receipt, AlertTriangle, ArrowRight } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { AccionesDeCampo, Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
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
  asignarSectorAFactura,
  type Descuento,
  fetchProximoNumero,
  LETRAS_EMISIBLES,
  PAYMENT_TERMS_DAYS,
  toDateString,
  type CondicionVenta,
  type InvoiceType,
  type WorkOrderInvoiceRef,
  reasignarClienteDeOrden,
} from '@/src/lib/invoices';
import { pedirCaeAlEmitir } from '@/src/lib/arcaFacturacion';
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
import { ClienteCombobox } from '@/src/components/ClienteCombobox';
import { SelectorDeSector, sectorPorDefecto } from '@/src/components/SelectorDeSector';
import { descuentoDe } from '@/src/components/DescuentoEditor';
import { ActualizarClienteArca } from '@/src/components/ActualizarClienteArca';

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
 *
 * Sin ancho: lo pone cada uno. Casi todos van a todo el ancho de su celda,
 * pero el de la letra se achica a su contenido para dejarle lugar al número.
 */
export const selectCabecera =
  'rounded-md border border-line bg-panel px-2 py-1.5 text-sm text-text ' +
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
  numero,
  cancelHref,
  onIssue,
  issuing,
  canIssue,
}: {
  title: string;
  /** El número que va a llevar. Null mientras se está leyendo. */
  numero?: string | null;
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
      {/* El título y el número: con qué comprobante se está trabajando. Todavía
          no está emitido, así que es el que le va a tocar —si alguien emite
          primero, será el siguiente—. Abajo se repite al lado de la letra, que
          es lo que lo define y lo cambia. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-display text-xl uppercase tracking-[0.04em] text-text leading-none">{title}</h1>
        {numero && (
          <span className="font-mono text-lg font-semibold leading-none text-text-soft">{numero}</span>
        )}
      </div>

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
  // Sin valor inicial: elegir el talonario es parte de emitir. Un X puesto de
  // entrada se confirma sin mirarlo, y es la diferencia entre un comprobante
  // interno y uno fiscal.
  const [invoiceType, setInvoiceType] = React.useState<InvoiceType | ''>('');
  // Sin valor inicial: elegirla es parte de emitir, y un default se confirma
  // sin mirarlo. La base también la exige.
  const [condicion, setCondicion] = React.useState<CondicionVenta | ''>('');
  // Sector del cliente al que va la factura: arranca en el de la OT.
  const [sectorId, setSectorId] = React.useState('');
  // Descuento de la factura: arranca en el pactado en la OT.
  const [descuento, setDescuento] = React.useState<Descuento | null>(null);
  const [proximo, setProximo] = React.useState<string | null>(null);
  // La ficha del cliente abierta en el modal: null = cerrado, { customer: null }
  // = alta, { customer } = modificación del que ya está elegido.
  const [fichaCliente, setFichaCliente] = React.useState<{ customer: Customer | null } | null>(null);
  // Vacío = el plazo por defecto. Solo se usa en cuenta corriente.
  const [vencimiento, setVencimiento] = React.useState('');
  const [paymentMethods, setPaymentMethods] = React.useState<PaymentMethod[]>([]);
  // El cobro de contado: uno o varios medios, más los cheques de checkDrafts.
  const [pagos, setPagos] = React.useState<PagoContado[]>([{ paymentMethodId: '', amount: 0 }]);
  const [banks, setBanks] = React.useState<Bank[]>([]);
  const [checkDrafts, setCheckDrafts] = React.useState<CheckDraft[] | null>(null);
  const [checkModalOpen, setCheckModalOpen] = React.useState(false);
  const [chequeElectronico, setChequeElectronico] = React.useState(false);
  const [articles, setArticles] = React.useState<Article[]>([]);

  const [loading, setLoading] = React.useState(true);
  const [issuing, setIssuing] = React.useState(false);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [arcaCliente, setArcaCliente] = React.useState<Customer | null>(null);
  const [cambiandoCliente, setCambiandoCliente] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // El número que va a llevar la factura, para mostrarlo antes de emitir. Se
  // vuelve a pedir con cada cambio de letra porque cada una tiene su propia
  // numeración y su propio punto de venta.
  React.useEffect(() => {
    if (!invoiceType) { setProximo(null); return; }
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

  /**
   * La condición de venta habitual del cliente, propuesta una sola vez por
   * cliente. Después manda lo que haya elegido quien factura: si la cambió a
   * mano, volver a pisarla sería discutirle.
   *
   * Se vuelve a proponer si se cambia el cliente de la orden, porque entonces
   * la propuesta anterior era la del otro.
   */
  const propuestaPara = React.useRef<string | null>(null);
  React.useEffect(() => {
    const cliente = customers.find((c) => c.id === order?.customer?.id);
    if (!cliente || propuestaPara.current === cliente.id) return;
    propuestaPara.current = cliente.id;
    if (cliente.condicionVenta) setCondicion(cliente.condicionVenta);
  }, [customers, order]);

  /**
   * El talonario no tiene valor por defecto, pero para un cliente Responsable
   * Inscripto la A no es una elección real: es la única que corresponde. Se
   * sugiere una sola vez por cliente, igual que la condición de venta; para
   * cualquier otra condición, factura quien emite.
   */
  // El sector arranca en el de la orden; si se cambia el cliente, en el
  // único sector del nuevo (o en el contacto general).
  const sectoresDelCliente = order?.customer?.sectors ?? [];
  React.useEffect(() => {
    const sectores = order?.customer?.sectors ?? [];
    const delaOrden = order?.customerSectorId ?? '';
    setSectorId(sectores.some((s) => s.id === delaOrden) ? delaOrden : sectorPorDefecto(sectores));
  }, [order?.id, order?.customer?.id, order?.customerSectorId]);

  const propuestaTipoPara = React.useRef<string | null>(null);
  React.useEffect(() => {
    const cliente = customers.find((c) => c.id === order?.customer?.id);
    if (!cliente || propuestaTipoPara.current === cliente.id) return;
    propuestaTipoPara.current = cliente.id;
    if (cliente.taxCondition === 'RESPONSABLE_INSCRIPTO') setInvoiceType('A');
  }, [customers, order]);

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
        setDescuento(workOrder ? descuentoDe(workOrder.discountPercent, workOrder.discountFixed) : null);

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

  // Un error al leer no es "no existe la orden" ni "faltan los datos fiscales":
  // se dice lo que pasó y se deja reintentar.
  if (error && (!order || !company)) {
    return (
      <Blocked title="No se pudo abrir la pantalla de facturar.">
        <p className="mb-4 text-sm text-text-soft">{error}</p>
        <Button onClick={() => window.location.reload()}>Reintentar</Button>
      </Blocked>
    );
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
  // La ficha completa del que está elegido. La orden trae sus datos fiscales,
  // pero el modal necesita el Customer entero —vehículos incluidos—, y eso
  // vive en la lista que se trajo para poder cambiarlo.
  const clienteElegido = customers.find((c) => c.id === order.customer?.id) ?? null;
  const customerCondition = order.customer?.tax_condition ?? 'CONSUMIDOR_FINAL';
  // La letra la elige quien emite. Para el IVA manda la que le correspondería
  // al cliente, también en la X, para que el total dé lo mismo en las dos
  // numeraciones; lo que cambia es que la X no lo discrimina al imprimirse.
  const letraFiscal = invoiceTypeFor(settings.taxCondition, customerCondition);
  // Sin talonario elegido todavía, la previsualización usa la letra fiscal:
  // el total no puede quedar en blanco solo porque falta esa elección.
  const totals = computeTotals(items, invoiceType === '' ? letraFiscal : invoiceType, descuento);
  // Con un solo medio, ese medio cubre lo que falte (el total menos los
  // cheques): el caso de siempre no pide escribir el importe.
  const pagosEfectivos = ajustarUnicoMedio(pagos, checkDrafts, totals.total);
  // Lo ya asignado, para proponer el importe del próximo cheque. El medio
  // único no cuenta: es el que absorbe lo que el cheque no cubra.
  const totalCobradoSinUnico =
    (checkDrafts ?? []).reduce((s, c) => s + c.amount, 0) +
    (pagos.length > 1 ? pagos.reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0) : 0);

  // Contado es exactamente lo que antes era el check de "factura de contado":
  // se cobra en el mismo acto de emitir.
  const isCash = condicion === 'CONTADO';

  const issueDate = new Date();
  const dueDate = new Date();
  if (!isCash) dueDate.setDate(dueDate.getDate() + PAYMENT_TERMS_DAYS);

  const emptyLines = items.filter((item) => item.description.trim() === '').length;
  const canIssue =
    items.length > 0 && totals.total > 0 && emptyLines === 0 && condicion !== '' && invoiceType !== '' &&
    (!isCash || cobroCompleto(pagosEfectivos, checkDrafts, totals.total)) && !issuing;

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
        (invoiceType === 'X'
          ? 'Es un comprobante interno, sin validez fiscal.\n\nUna vez emitido no se puede editar: solo anular.'
          : 'Se le va a pedir el CAE a ARCA en este mismo paso. Si lo autoriza, el ' +
            'comprobante queda emitido y solo se puede revertir con una nota de crédito.')
    );
    if (!confirmed) return;

    setIssuing(true);
    setError(null);
    try {
      const issued = await issueInvoice(
        order.id, items, notes, emitRemito, invoiceType, condicion as CondicionVenta,
        isCash ? null : (vencimiento || null),
        descuento
      );
      if ((sectorId || null) !== (order.customerSectorId ?? null)) {
        await asignarSectorAFactura(issued.id, sectorId || null);
      }

      // El CAE va en el mismo acto, no en un paso posterior. La X no pasa por
      // acá: no es fiscal y nace emitida.
      // Sin CAE también se vuelve al listado: la factura queda ahí marcada como
      // pendiente o rechazada, con "Pedir el CAE a ARCA" en Más acciones.
      if (invoiceType !== 'X' && !(await pedirCaeAlEmitir(issued.id, issued.fullNumber))) {
        navigate('/facturas');
        return;
      }

      if (isCash) {
        try {
          const values = valoresDelCobro(pagosEfectivos, checkDrafts);
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
        numero={proximo}
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
          por dato, en tres filas sobre cuatro columnas: el cliente y la letra
          se llevan media pantalla cada uno porque son los campos largos, y a
          su derecha van los cortos. Cobrado con queda al lado de la condición
          de venta, que es lo que lo hace aparecer. */}
      <div className="mb-6 grid grid-cols-2 gap-x-6 gap-y-4 border-b-2 border-accent px-4 py-4 sm:grid-cols-4 sm:px-5">
        <FieldBox label="Cliente" className="col-span-2">
          <span className="block truncate font-semibold text-text">
            {order.customer?.legal_name || order.customer?.name || '—'}
          </span>
          {/* A quién se le factura puede no ser quien trajo el vehículo: la
              empresa del titular, el seguro, la contratista. Se cambia acá,
              antes de emitir, porque después la factura ya salió con un
              nombre. Y el alta y la modificación de la ficha van pegadas al
              campo: si el que trajo el vehículo no está cargado —o está
              cargado sin CUIT, que es lo que más pasa— facturar no puede
              obligar a salir a Clientes, arreglarlo y volver a empezar. */}
          <div className="mt-1.5 flex">
            <ClienteCombobox
              clientes={customers}
              value={order.customer?.id ?? ''}
              disabled={cambiandoCliente || customers.length === 0}
              onChange={(id) => id && handleCambiarCliente(id)}
              className="rounded-r-none"
            />
            <AccionesDeCampo
              nuevo={{
                titulo: 'Dar de alta un cliente nuevo',
                onClick: () => setFichaCliente({ customer: null }),
              }}
              modificar={{
                titulo: 'Modificar la ficha del cliente',
                onClick: () => clienteElegido && setFichaCliente({ customer: clienteElegido }),
                disabled: !clienteElegido,
              }}
              arca={{
                titulo: 'Actualizar los datos del cliente desde ARCA',
                onClick: () => clienteElegido && setArcaCliente(clienteElegido),
                disabled: !clienteElegido,
              }}
            />
          </div>
          <span className="mt-1 block text-[11px] normal-case text-text-soft">
            {cambiandoCliente ? 'Cambiando…' : 'Cambiar acá reasigna también la orden y su presupuesto.'}
          </span>
          {sectoresDelCliente.length > 0 && (
            <div className="mt-2">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                Sector — a quién se le manda la factura
              </span>
              <SelectorDeSector sectores={sectoresDelCliente} value={sectorId} onChange={setSectorId} className="normal-case" />
            </div>
          )}
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

        <FieldBox label="Tipo de factura" className="col-span-2">
          {/* La letra y el número, uno al lado del otro y del mismo tamaño:
              juntos son la identidad del comprobante, y el número es lo que
              esta letra define —cambia con ella—. Todavía no está emitido, así
              que es el que le va a tocar. */}
          {/* Envuelve en pantalla angosta: el número baja abajo entero en vez
              de cortarse, que es lo único que no se puede adivinar. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <select
              value={invoiceType}
              onChange={(e) => setInvoiceType(e.target.value as InvoiceType)}
              className={cn(selectCabecera, 'w-auto shrink-0', invoiceType === '' && 'border-danger text-danger')}
            >
              <option value="">Elegí un talonario…</option>
              {LETRAS_EMISIBLES.map((l) => (
                <option key={l} value={l}>{INVOICE_TYPE_LABELS[l]}</option>
              ))}
            </select>
            {invoiceType !== '' && (
              <span className="whitespace-nowrap font-mono text-sm normal-case text-text">
                {proximo ?? (invoiceType === 'X' ? 'Sin validez fiscal' : 'Numeración fiscal')}
              </span>
            )}
          </div>
        </FieldBox>

        {/* Ocupa dos columnas para cerrar la fila de la letra: así la condición
            de venta arranca una fila nueva y no se cuela en el hueco. */}
        <FieldBox label="Remito" className="col-span-2">
          <SiNo value={emitRemito} onChange={setEmitRemito} />
          <span className="mt-1 block text-[11px] normal-case text-text-soft">
            Emitir junto con la factura
          </span>
        </FieldBox>

        <FieldBox label="Condición de venta">
          <select
            value={condicion}
            onChange={(e) => setCondicion(e.target.value as CondicionVenta)}
            className={cn(selectCabecera, 'w-full', condicion === '' && 'border-danger text-danger')}
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
                : 'Queda impaga: se cobra desde Cobranzas'}
          </span>
        </FieldBox>

        {isCash && (
          <FieldBox label="Cobrado con" className="col-span-2">
            {/* Uno o varios medios (y cheques): la suma tiene que dar el total. */}
            <CobroContado
              total={totals.total}
              paymentMethods={paymentMethods}
              pagos={pagosEfectivos}
              onPagosChange={setPagos}
              cheques={checkDrafts}
              onAgregarCheque={(electronico) => {
                setChequeElectronico(electronico);
                setCheckModalOpen(true);
              }}
              onQuitarCheque={(i) =>
                setCheckDrafts((actuales) => {
                  const quedan = (actuales ?? []).filter((_, j) => j !== i);
                  return quedan.length ? quedan : null;
                })
              }
            />
          </FieldBox>
        )}
      </div>

      <Panel className="mb-4 rounded-lg p-4">
        <ItemsEditor
          descripcionEditable
          items={items}
          onChange={setItems}
          articles={articles}
          editable
          descuento={descuento}
          onDescuentoChange={setDescuento}
          totals={<InvoiceTotals type={invoiceType === '' ? letraFiscal : invoiceType} totals={totals} descuento={descuento} />}
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

      {/* Con qué se cobra subió al encabezado, así que abajo queda solo lo
          único que no es una decisión: el texto que sale impreso. */}
      <Panel className="mb-10 rounded-lg p-4">
        <SectionHeader title="Observaciones" className="mb-3" />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Texto que sale impreso en el comprobante. Opcional."
          className="w-full resize-y border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
        />
      </Panel>

      {fichaCliente && (
        <CustomerModal
          customer={fichaCliente.customer}
          onClose={() => setFichaCliente(null)}
          onSaved={async (guardado) => {
            const eraAlta = fichaCliente.customer === null;
            setFichaCliente(null);
            setCustomers((actuales) =>
              (eraAlta
                ? [...actuales, guardado]
                : actuales.map((c) => (c.id === guardado.id ? guardado : c))
              ).sort((a, b) => a.name.localeCompare(b.name))
            );
            if (eraAlta) {
              // Se le factura al que se acaba de cargar: es para eso que se lo
              // dio de alta acá y no en la pantalla de Clientes.
              await handleCambiarCliente(guardado.id);
              return;
            }
            // Modificación: la orden ya apunta a este cliente, así que se le
            // copian los datos nuevos en vez de recargarla. Recargar volvería a
            // traer los renglones de la OT y se perderían los retoques hechos
            // en esta pantalla.
            setOrder((actual) =>
              actual && actual.customer?.id === guardado.id
                ? {
                    ...actual,
                    customer: {
                      id: guardado.id,
                      name: guardado.name,
                      phone: guardado.phone,
                      legal_name: guardado.legalName,
                      tax_id: guardado.taxId,
                      tax_condition: guardado.taxCondition,
                      address_street: guardado.addressStreet,
                      address_city: guardado.addressCity,
                      address_state: guardado.addressState,
                      address_zip: guardado.addressZip,
                      sectors: guardado.sectors,
                    },
                  }
                : actual
            );
          }}
        />
      )}

      {arcaCliente && (
        <ActualizarClienteArca
          cliente={arcaCliente}
          onClose={() => setArcaCliente(null)}
          onActualizado={(guardado) => {
            setArcaCliente(null);
            setCustomers((actuales) => actuales.map((x) => (x.id === guardado.id ? guardado : x)));
            // La orden ya apunta a este cliente: se le copian los datos nuevos
            // (de ellos sale la letra) sin recargarla, igual que al modificar
            // la ficha a mano.
            setOrder((actual) =>
              actual && actual.customer?.id === guardado.id
                ? {
                    ...actual,
                    customer: {
                      id: guardado.id,
                      name: guardado.name,
                      phone: guardado.phone,
                      legal_name: guardado.legalName,
                      tax_id: guardado.taxId,
                      tax_condition: guardado.taxCondition,
                      address_street: guardado.addressStreet,
                      address_city: guardado.addressCity,
                      address_state: guardado.addressState,
                      address_zip: guardado.addressZip,
                      sectors: guardado.sectors,
                    },
                  }
                : actual
            );
          }}
        />
      )}

      {checkModalOpen && (
        <CheckDraftModal
          electronico={chequeElectronico}
          remainingBase={Math.max(0, Math.round((totals.total - totalCobradoSinUnico) * 100) / 100)}
          banks={banks}
          onBankCreated={(bank) => setBanks((current) => [...current, bank])}
          onConfirm={(checks) => {
            setCheckDrafts((actuales) => [...(actuales ?? []), ...checks]);
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
  descuento,
}: {
  type: InvoiceType;
  totals: { gross?: number; discount?: number; net: number; vat: number; total: number };
  /** Para rotular el descuento ("Descuento 10%"). */
  descuento?: Descuento | null;
}) {
  // Solo los totales: la explicación de por qué salió esa letra se fue con el
  // resto del texto estático — la letra se elige a mano y está a la vista en
  // la cabecera.
  return (
    <div className="flex justify-end">
      <div className="w-full space-y-2 rounded-lg border border-line bg-panel-alt p-4 md:w-1/3">
        {!!totals.discount && totals.discount > 0 && (
          <>
            <div className="flex justify-between text-xs text-text-soft">
              <span>Renglones</span>
              <span className="text-text">$ {formatMoney(totals.gross ?? 0)}</span>
            </div>
            <div className="flex justify-between text-xs text-text-soft">
              <span>Descuento{descuento?.tipo === 'PORCENTAJE' ? ` ${descuento.valor}%` : ''}</span>
              <span className="text-text">− $ {formatMoney(totals.discount)}</span>
            </div>
          </>
        )}
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
