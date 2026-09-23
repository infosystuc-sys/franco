import { supabase } from '@/src/lib/supabase';
import { formatDate, todayLocal, toDateString } from '@/src/lib/utils';
import type { TaxCondition } from '@/src/lib/fiscal';
import type { WorkOrderItemInput } from '@/src/lib/workOrders';

/**
 * Facturación (sin ARCA todavía).
 *
 * La factura sale de una OT terminada y es un registro CONGELADO: guarda
 * copia del cliente, del emisor y de los renglones. Todas van a cuenta
 * corriente con vencimiento a 7 días.
 *
 * Lo que se calcula acá —letra del comprobante y totales— es una
 * PREVISUALIZACIÓN para la pantalla. Lo que vale lo recalcula la base al
 * emitir (issue_invoice), porque la app es un sitio estático y cualquiera
 * podría llamar a la API con la anon key.
 */

// Viven en utils.ts porque las comparten facturacion y compras. Se
// reexportan para que las pantallas de ventas sigan importando de un solo
// lugar lo que necesitan del modulo.
export { formatDate, todayLocal, toDateString };

export type InvoiceType = 'A' | 'B' | 'C' | 'X';
/**
 * PENDIENTE_CAE es el hueco entre reservar el número y que ARCA conteste. Una
 * factura ahí todavía no es un comprobante: no se imprime, no se manda y no se
 * cobra. La serie interna X nunca pasa por ese estado.
 */
export type InvoiceStatus = 'PENDIENTE_CAE' | 'EMITIDA' | 'ANULADA';

/**
 * Las letras que se pueden elegir al emitir.
 *
 * A y B van por la numeración electrónica —la que en su momento le va a pedir
 * el CAE a ARCA; hasta entonces se simula—. La X es la interna: sin validez
 * fiscal, con su propio punto de venta, pero numera, imprime, va a la cuenta
 * corriente y se cobra igual que cualquier otra.
 *
 * La C no se ofrece: la emite un monotributista, y este taller es Responsable
 * Inscripto. Si eso cambiara, la base rechaza la A y la B y hay que agregarla.
 */
export const LETRAS_EMISIBLES: InvoiceType[] = ['A', 'B', 'X'];

/** Contado se cobra al emitir; cuenta corriente vence a los 7 días. */
export type CondicionVenta = 'CONTADO' | 'CUENTA_CORRIENTE';

export const CONDICION_VENTA_LABELS: Record<CondicionVenta, string> = {
  CONTADO: 'Contado',
  CUENTA_CORRIENTE: 'Cuenta corriente',
};

/** El IVA general. Cuando haya alícuotas por artículo, este es el lugar a tocar. */
export const VAT_RATE = 0.21;

/** Cuenta corriente: todas las facturas vencen a los 7 días de emitidas. */
export const PAYMENT_TERMS_DAYS = 7;

export const INVOICE_TYPE_LABELS: Record<InvoiceType, string> = {
  A: 'Factura A',
  B: 'Factura B',
  C: 'Factura C',
  X: 'Factura X',
};

/**
 * Por qué salió esa letra. Se muestra al facturar: quien emite tiene que
 * poder entender el comprobante antes de confirmarlo, no después.
 */
export const INVOICE_TYPE_REASON: Record<InvoiceType, string> = {
  A: 'El cliente es Responsable Inscripto: el IVA se discrimina.',
  B: 'El cliente no discrimina IVA: el importe va con el IVA incluido.',
  C: 'El taller no es Responsable Inscripto: el comprobante va sin IVA.',
  X: 'Comprobante interno, sin validez fiscal: el importe va con el IVA incluido.',
};

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  PENDIENTE_CAE: 'Esperando CAE',
  EMITIDA: 'Emitida',
  ANULADA: 'Anulada',
};

/** Estado de cobro. No se guarda: se deriva de paid_amount contra el total. */
export type PaymentState = 'IMPAGA' | 'PARCIAL' | 'PAGADA';

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  IMPAGA: 'Impaga',
  PARCIAL: 'Pago parcial',
  PAGADA: 'Pagada',
};

export const PAYMENT_STATE_BADGE: Record<PaymentState, string> = {
  IMPAGA: 'bg-blue-100 text-blue-700',
  PARCIAL: 'bg-orange-100 text-orange-700',
  PAGADA: 'bg-green-100 text-green-700',
};

/** Color de la tira lateral, para leer el estado de un vistazo en el listado. */
export const INVOICE_STRIP: Record<
  PaymentState | 'ANULADA' | 'VENCIDA' | 'PENDIENTE_CAE',
  string
> = {
  IMPAGA: '#2b6cb0',
  PARCIAL: '#e07b1a',
  PAGADA: '#2e7d32',
  VENCIDA: '#c62828',
  ANULADA: '#9a9a9a',
  PENDIENTE_CAE: '#8e24aa',
};

// ===========================================================================
// Reglas fiscales (funciones puras)
// ===========================================================================

/**
 * El cruce estándar de AFIP entre la condición del emisor y la del cliente.
 * Espeja invoice_type_for() en la base, que es la que decide de verdad.
 */
export function invoiceTypeFor(
  issuerCondition: TaxCondition,
  customerCondition: TaxCondition
): InvoiceType {
  // Un monotributista o exento emite siempre C, sin IVA.
  if (issuerCondition === 'MONOTRIBUTO' || issuerCondition === 'EXENTO') return 'C';
  // Responsable inscripto: A solo contra otro inscripto, con el IVA discriminado.
  if (customerCondition === 'RESPONSABLE_INSCRIPTO') return 'A';
  // Contra consumidor final, monotributo o exento: B, con el IVA incluido.
  return 'B';
}

/** En la A el IVA se discrimina en el comprobante; en la B va incluido y en la C no existe. */
export function discriminatesVat(type: InvoiceType): boolean {
  return type === 'A';
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Los códigos de comprobante de ARCA. La X no tiene: no es fiscal. */
const COD_COMPROBANTE: Partial<Record<InvoiceType, number>> = { A: 1, B: 6, C: 11 };

/**
 * El QR obligatorio de la RG 4892: un JSON con los datos del comprobante,
 * en base64, colgado de la URL de ARCA. Quien lo escanea le pregunta al
 * organismo si el comprobante que tiene en la mano existe de verdad.
 *
 * Devuelve null cuando el comprobante no lleva QR: la serie interna X, que no
 * es fiscal, y cualquiera que todavía no tenga CAE.
 */
export function afipQrUrl(
  invoice: {
    invoiceType: InvoiceType;
    salesPoint: number;
    number: number;
    issueDate: string;
    totalAmount: number;
    issuerTaxId: string | null;
    customerTaxId: string | null;
    cae: string | null;
  },
  /**
   * El código de comprobante de ARCA, para lo que no es una factura. La nota
   * de crédito comparte letra con la factura que revierte pero es otro tipo:
   * la A es la 3 y no la 1.
   */
  codigoComprobante?: number
): string | null {
  const tipoCmp = codigoComprobante ?? COD_COMPROBANTE[invoice.invoiceType];
  const cuitEmisor = (invoice.issuerTaxId ?? '').replace(/\D/g, '');
  if (!tipoCmp || !invoice.cae || cuitEmisor.length !== 11) return null;

  const cuitReceptor = (invoice.customerTaxId ?? '').replace(/\D/g, '');

  const datos: Record<string, string | number> = {
    ver: 1,
    fecha: invoice.issueDate.slice(0, 10),
    cuit: Number(cuitEmisor),
    ptoVta: invoice.salesPoint,
    tipoCmp,
    nroCmp: invoice.number,
    importe: invoice.totalAmount,
    moneda: 'PES',
    ctz: 1,
    // Sin CUIT del cliente el comprobante va a consumidor final sin
    // identificar, y ARCA espera el tipo 99 con documento 0.
    tipoDocRec: cuitReceptor.length === 11 ? 80 : 99,
    nroDocRec: cuitReceptor.length === 11 ? Number(cuitReceptor) : 0,
    // "E" es CAE; "A" sería CAEA, que es otro régimen y no usamos.
    tipoCodAut: 'E',
    codAut: Number(invoice.cae),
  };

  return `https://www.afip.gob.ar/fe/qr/?p=${btoa(JSON.stringify(datos))}`;
}

export interface InvoiceTotals {
  net: number;
  vat: number;
  total: number;
}

/**
 * Los renglones son NETOS: articles.unit_price lo es (ver price-lists.sql),
 * así que el IVA se suma arriba. En la C no hay IVA que sumar.
 */
export function computeTotals(
  items: { quantity: number; unitPrice: number }[],
  type: InvoiceType
): InvoiceTotals {
  const net = round2(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  const vat = type === 'C' ? 0 : round2(net * VAT_RATE);
  return { net, vat, total: round2(net + vat) };
}

// ===========================================================================
// Estado de cobro y vencimiento
// ===========================================================================

interface Collectable {
  totalAmount: number;
  paidAmount: number;
  dueDate: string;
  status: InvoiceStatus;
  /** Opcional: cobranzas arma su propia fila y ahí ya viene descontado. */
  creditedAmount?: number;
}

export function paymentStateOf(invoice: Collectable): PaymentState {
  if (invoice.paidAmount <= 0) return 'IMPAGA';
  if (invoice.paidAmount >= invoice.totalAmount) return 'PAGADA';
  return 'PARCIAL';
}

/**
 * Una pendiente de CAE no es deuda todavía: el cliente no recibió ningún
 * comprobante, y cobranzas tampoco la ofrece. Contarla mostraría un saldo que
 * nadie puede explicar ni cancelar.
 *
 * Lo acreditado sí baja el saldo, pero solo lo que una nota de crédito
 * IMPUTADA canceló. Una nota emitida y sin imputar no toca esta cuenta: queda
 * a cuenta del cliente hasta que alguien decida contra qué va.
 */
export function balanceOf(invoice: Collectable): number {
  if (invoice.status === 'ANULADA' || invoice.status === 'PENDIENTE_CAE') return 0;
  return round2(
    Math.max(0, invoice.totalAmount - invoice.paidAmount - (invoice.creditedAmount ?? 0))
  );
}

/**
 * Vencida es la que pasó su fecha y todavía debe algo. Una anulada nunca
 * vence: dejó de existir como deuda.
 */
export function isOverdue(invoice: Collectable): boolean {
  if (invoice.status === 'ANULADA') return false;
  if (balanceOf(invoice) <= 0) return false;
  return invoice.dueDate < todayLocal();
}

/** Días que faltan para el vencimiento. Negativo si ya venció. */
export function daysUntilDue(dueDate: string): number {
  const due = new Date(`${dueDate}T00:00:00`);
  const now = new Date(`${todayLocal()}T00:00:00`);
  return Math.round((due.getTime() - now.getTime()) / 86_400_000);
}

// ===========================================================================
// Lectura
// ===========================================================================

export interface InvoiceListRow {
  id: string;
  fullNumber: string;
  invoiceType: InvoiceType;
  status: InvoiceStatus;
  customerName: string;
  workOrderNumber: string | null;
  issueDate: string;
  dueDate: string;
  totalAmount: number;
  paidAmount: number;
  /** Por qué ARCA rechazó el último pedido de CAE. Null si nunca rechazó. */
  caeRechazo: string | null;
  /**
   * Cuánto cancelaron notas de crédito IMPUTADAS a esta factura. Una nota
   * emitida y sin imputar no lo toca: queda a cuenta del cliente.
   */
  creditedAmount: number;
}

export interface InvoiceItem {
  code: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface InvoiceDetail extends InvoiceListRow {
  salesPoint: number;
  number: number;
  paymentTermsDays: number;
  netAmount: number;
  vatAmount: number;
  notes: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  createdAt: string;

  /** Null en una factura libre, sin OT ni cotización. */
  workOrderId: string | null;
  workOrderComponent: string | null;

  customerLegalName: string | null;
  customerTaxId: string | null;
  customerTaxCondition: TaxCondition;
  customerAddress: string | null;
  /** Contacto vigente del cliente (no es un dato fiscal impreso, se lee en vivo). */
  customerEmail: string | null;
  customerPhone: string | null;

  issuerLegalName: string;
  issuerTaxId: string | null;
  issuerTaxCondition: TaxCondition;
  issuerAddress: string | null;
  issuerGrossIncome: string | null;
  issuerActivityStartDate: string | null;

  /** CAE de ARCA. Null mientras la factura está esperando que lo otorgue. */
  cae: string | null;
  caeDueDate: string | null;
  caeSimulated: boolean;
  caeRechazadoAt: string | null;
  /**
   * Una nota de crédito la canceló entera. Sigue siendo válida ante ARCA, pero
   * ya no respalda su orden, que vuelve a quedar facturable.
   */
  revertidaPorNc: boolean;

  items: InvoiceItem[];
}

const LIST_SELECT =
  'id, full_number, invoice_type, status, customer_name, issue_date, due_date, ' +
  'total_amount, paid_amount, credited_amount, cae_rechazo, work_order:work_orders(number)';

function mapListRow(row: any): InvoiceListRow {
  return {
    id: row.id,
    fullNumber: row.full_number,
    invoiceType: row.invoice_type,
    status: row.status,
    customerName: row.customer_name,
    workOrderNumber: row.work_order?.number ?? null,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    totalAmount: Number(row.total_amount),
    paidAmount: Number(row.paid_amount),
    caeRechazo: row.cae_rechazo ?? null,
    creditedAmount: Number(row.credited_amount ?? 0),
  };
}

export async function fetchInvoices(): Promise<InvoiceListRow[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select(LIST_SELECT)
    .order('issue_date', { ascending: false })
    .order('number', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapListRow);
}

export async function fetchInvoiceById(id: string): Promise<InvoiceDetail | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select(
      `id, full_number, invoice_type, sales_point, number, status,
       customer_name, customer_legal_name, customer_tax_id, customer_tax_condition, customer_address,
       issuer_legal_name, issuer_tax_id, issuer_tax_condition, issuer_address,
       issuer_gross_income, issuer_activity_start_date,
       issue_date, due_date, payment_terms_days,
       net_amount, vat_amount, total_amount, paid_amount,
       cae, cae_due_date, cae_simulated, cae_rechazo, cae_rechazado_at, revertida_por_nc, credited_amount,
       notes, voided_at, voided_reason, created_at, work_order_id,
       work_order:work_orders(number, component),
       customer:customers(email, phone),
       items:invoice_items(code, description, quantity, unit_price, subtotal, line_number)`
    )
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as any;
  return {
    ...mapListRow(row),
    salesPoint: Number(row.sales_point),
    number: Number(row.number),
    paymentTermsDays: Number(row.payment_terms_days),
    netAmount: Number(row.net_amount),
    vatAmount: Number(row.vat_amount),
    notes: row.notes,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,
    createdAt: row.created_at,

    workOrderId: row.work_order_id,
    workOrderComponent: row.work_order?.component ?? null,

    customerLegalName: row.customer_legal_name,
    customerTaxId: row.customer_tax_id,
    customerTaxCondition: row.customer_tax_condition,
    customerAddress: row.customer_address,
    customerEmail: row.customer?.email ?? null,
    customerPhone: row.customer?.phone ?? null,

    issuerLegalName: row.issuer_legal_name,
    issuerTaxId: row.issuer_tax_id,
    issuerTaxCondition: row.issuer_tax_condition,
    issuerAddress: row.issuer_address,
    issuerGrossIncome: row.issuer_gross_income,
    issuerActivityStartDate: row.issuer_activity_start_date,

    cae: row.cae,
    caeDueDate: row.cae_due_date,
    caeSimulated: row.cae_simulated ?? false,
    caeRechazo: row.cae_rechazo ?? null,
    caeRechazadoAt: row.cae_rechazado_at ?? null,
    revertidaPorNc: row.revertida_por_nc ?? false,
    creditedAmount: Number(row.credited_amount ?? 0),

    items: ((row.items ?? []) as any[])
      .sort((a, b) => a.line_number - b.line_number)
      .map((item) => ({
        code: item.code,
        description: item.description,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unit_price),
        subtotal: Number(item.subtotal),
      })),
  };
}

export interface PendingToInvoice {
  id: string;
  number: string;
  component: string | null;
  customerName: string;
  vehicleLabel: string;
}

/**
 * Órdenes terminadas que todavía no se facturaron.
 *
 * Es la pregunta con la que se entra a esta pantalla: qué hay para facturar.
 * Sin esto no habría forma de llegar a una orden terminada, porque el panel
 * muestra solo las abiertas —es una cola de trabajo— y /ordenes todavía
 * apunta al panel.
 *
 * El descarte de las ya facturadas se hace acá y no con un filtro de la
 * consulta: PostgREST no sabe filtrar por "no tiene ninguna fila relacionada
 * en tal estado", y en un taller la cantidad de órdenes terminadas es chica.
 */
export async function fetchPendingToInvoice(): Promise<PendingToInvoice[]> {
  const { data, error } = await supabase
    .from('work_orders')
    .select(
      `id, number, component,
       status:work_order_statuses(is_terminal),
       customer:customers(name),
       vehicle:vehicles(brand, model, license_plate),
       invoices(status, revertida_por_nc)`
    )
    .order('created_at', { ascending: false });

  if (error) throw error;

  return ((data ?? []) as any[])
    // Una factura revertida por una nota de crédito total sigue existiendo
    // ante ARCA, pero ya no respalda el trabajo: la orden vuelve a la cola.
    .filter(
      (row) =>
        (row.status as any)?.is_terminal &&
        !(row.invoices ?? []).some((i: any) => i.status === 'EMITIDA' && !i.revertida_por_nc)
    )
    .map((row) => {
      const name = [row.vehicle?.brand, row.vehicle?.model].filter(Boolean).join(' ');
      return {
        id: row.id,
        number: row.number,
        component: row.component,
        customerName: row.customer?.name ?? '—',
        vehicleLabel: row.vehicle?.license_plate ? `${name} — ${row.vehicle.license_plate}` : name || '—',
      };
    });
}

export interface WorkOrderInvoiceRef {
  id: string;
  fullNumber: string;
  invoiceType: InvoiceType;
}

/**
 * La factura vigente de una OT, si la tiene. Se consulta aparte del detalle
 * de la orden a propósito: así una base sin migrar, o la sesión de un
 * operario (que no ve facturas), no rompen la pantalla de la OT — solo se
 * quedan sin el botón.
 */
export async function fetchInvoiceForWorkOrder(
  workOrderId: string
): Promise<WorkOrderInvoiceRef | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, full_number, invoice_type')
    .eq('work_order_id', workOrderId)
    .eq('status', 'EMITIDA')
    .eq('revertida_por_nc', false)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: (data as any).id,
    fullNumber: (data as any).full_number,
    invoiceType: (data as any).invoice_type,
  };
}

// ===========================================================================
// Escritura (solo por RPC: la base decide letra, IVA y número)
// ===========================================================================

export interface IssuedInvoice {
  id: string;
  fullNumber: string;
  invoiceType: InvoiceType;
  /** Número del remito emitido junto con la factura. Null si no se pidió. */
  remitoFullNumber: string | null;
}

/**
 * Cambia a qué cliente se le va a facturar una orden.
 *
 * El vehículo entra a nombre de quien lo trae, pero la factura muchas veces va
 * a otro: la empresa del titular, el seguro, la contratista. Reasigna también
 * el presupuesto que salió de esa orden, para que no quede pendiente de
 * autorizar en la cuenta de alguien que ya no tiene nada que ver.
 *
 * La base lo rechaza si la orden ya tiene factura emitida: mover una factura
 * entregada arrastra saldos y recibos ya aplicados.
 */
export async function reasignarClienteDeOrden(
  workOrderId: string,
  customerId: string
): Promise<void> {
  const { error } = await supabase.rpc('reasignar_cliente_de_orden', {
    p_work_order_id: workOrderId,
    p_customer_id: customerId,
  });
  if (error) throw error;
}

export async function issueInvoice(
  workOrderId: string,
  items: WorkOrderItemInput[],
  notes: string,
  emitRemito: boolean,
  invoiceType: InvoiceType,
  condicion: CondicionVenta,
  /** Solo se usa en cuenta corriente; en contado vence el mismo día. */
  dueDate: string | null
): Promise<IssuedInvoice> {
  const { data, error } = await supabase.rpc('issue_invoice', {
    p_work_order_id: workOrderId,
    p_items: items.map((item) => ({
      article_id: item.articleId,
      code: item.code,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unitPrice,
    })),
    p_notes: notes.trim() || null,
    p_emit_remito: emitRemito,
    p_invoice_type: invoiceType,
    p_condicion: condicion,
    p_due_date: dueDate,
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió la factura emitida.');

  // Los nombres invoice_* vienen del RETURNS TABLE de la RPC, que los usa
  // para no chocar con las columnas de la tabla dentro de la función.
  return {
    id: row.invoice_id,
    fullNumber: row.invoice_full_number,
    invoiceType: row.invoice_letter,
    remitoFullNumber: row.remito_full_number,
  };
}

/**
 * Factura libre: sin OT ni cotización de por medio, directo por cliente.
 * Si viene de un remito pendiente (remitoId), lo vincula a la factura en vez
 * de crear uno nuevo — emitRemito se ignora en ese caso, ya hay uno.
 */
export async function issueFreeInvoice(
  customerId: string,
  items: WorkOrderItemInput[],
  notes: string,
  emitRemito: boolean,
  invoiceType: InvoiceType,
  condicion: CondicionVenta,
  dueDate: string | null,
  remitoId: string | null = null
): Promise<IssuedInvoice> {
  const { data, error } = await supabase.rpc('issue_free_invoice', {
    p_customer_id: customerId,
    p_items: items.map((item) => ({
      article_id: item.articleId,
      code: item.code,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unitPrice,
    })),
    p_notes: notes.trim() || null,
    p_emit_remito: emitRemito,
    p_remito_id: remitoId,
    p_invoice_type: invoiceType,
    p_condicion: condicion,
    p_due_date: dueDate,
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) throw new Error('La base no devolvió la factura emitida.');

  return {
    id: row.invoice_id,
    fullNumber: row.invoice_full_number,
    invoiceType: row.invoice_letter,
    remitoFullNumber: row.remito_full_number,
  };
}

/**
 * Qué número va a llevar la próxima factura de esta letra. Es una previsión
 * para mostrarla antes de emitir: si alguien emite primero, el número real va
 * a ser el siguiente.
 */
export async function fetchProximoNumero(
  invoiceType: InvoiceType
): Promise<{ salesPoint: number; nextNumber: number; fullNumber: string } | null> {
  const { data, error } = await supabase.rpc('proximo_numero_factura', {
    p_invoice_type: invoiceType,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) return null;
  return {
    salesPoint: Number(row.sales_point),
    nextNumber: Number(row.next_number),
    fullNumber: row.full_number,
  };
}

export interface SerieNumeracion {
  invoiceType: InvoiceType;
  salesPoint: number;
  nextNumber: number;
  emitidas: number;
}

/** Cada serie con el número que va a salir en la próxima factura. */
export async function fetchNumeracion(): Promise<SerieNumeracion[]> {
  const { data, error } = await supabase.rpc('numeracion_facturas');
  if (error) throw error;
  return ((data ?? []) as any[]).map((row) => ({
    invoiceType: row.invoice_type,
    salesPoint: Number(row.sales_point),
    nextNumber: Number(row.next_number),
    emitidas: Number(row.emitidas),
  }));
}

/**
 * Mueve desde dónde sigue la numeración de una serie. La base se niega a
 * retroceder por debajo de lo ya emitido.
 */
export async function fijarProximoNumero(
  invoiceType: InvoiceType,
  salesPoint: number,
  nextNumber: number
): Promise<void> {
  const { error } = await supabase.rpc('fijar_proximo_numero', {
    p_invoice_type: invoiceType,
    p_sales_point: salesPoint,
    p_next_number: nextNumber,
  });
  if (error) throw error;
}

/**
 * Corrige el vencimiento de una factura de cuenta corriente ya emitida.
 * Renegociar el plazo es habitual y no toca nada del contenido fiscal. La base
 * rechaza las anuladas, las de contado y una fecha anterior a la emisión.
 */
export async function cambiarVencimiento(invoiceId: string, dueDate: string): Promise<void> {
  const { error } = await supabase.rpc('cambiar_vencimiento_factura', {
    p_invoice_id: invoiceId,
    p_due_date: dueDate,
  });
  if (error) throw error;
}

export async function voidInvoice(invoiceId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_invoice', {
    p_invoice_id: invoiceId,
    p_reason: reason,
  });
  if (error) throw error;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeInvoiceError(message: string): string {
  if (message.includes('invoices_una_activa_por_ot')) {
    return 'Esta orden ya tiene una factura emitida. Actualizá la pantalla para verla.';
  }
  // PostgREST avisa de una tabla inexistente con "schema cache"; Postgres,
  // con "relation ... does not exist". Los dos significan lo mismo acá.
  if (
    message.includes('schema cache') ||
    message.includes('does not exist') ||
    message.includes('company_settings')
  ) {
    return 'Falta aplicar la migración de facturación en la base (supabase/invoicing.sql).';
  }
  return message;
}
