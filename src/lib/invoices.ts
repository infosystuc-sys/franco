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

export type InvoiceType = 'A' | 'B' | 'C';
export type InvoiceStatus = 'EMITIDA' | 'ANULADA';

/** El IVA general. Cuando haya alícuotas por artículo, este es el lugar a tocar. */
export const VAT_RATE = 0.21;

/** Cuenta corriente: todas las facturas vencen a los 7 días de emitidas. */
export const PAYMENT_TERMS_DAYS = 7;

export const INVOICE_TYPE_LABELS: Record<InvoiceType, string> = {
  A: 'Factura A',
  B: 'Factura B',
  C: 'Factura C',
};

/**
 * Por qué salió esa letra. Se muestra al facturar: quien emite tiene que
 * poder entender el comprobante antes de confirmarlo, no después.
 */
export const INVOICE_TYPE_REASON: Record<InvoiceType, string> = {
  A: 'El cliente es Responsable Inscripto: el IVA se discrimina.',
  B: 'El cliente no discrimina IVA: el importe va con el IVA incluido.',
  C: 'El taller no es Responsable Inscripto: el comprobante va sin IVA.',
};

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
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
export const INVOICE_STRIP: Record<PaymentState | 'ANULADA' | 'VENCIDA', string> = {
  IMPAGA: '#2b6cb0',
  PARCIAL: '#e07b1a',
  PAGADA: '#2e7d32',
  VENCIDA: '#c62828',
  ANULADA: '#9a9a9a',
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
}

export function paymentStateOf(invoice: Collectable): PaymentState {
  if (invoice.paidAmount <= 0) return 'IMPAGA';
  if (invoice.paidAmount >= invoice.totalAmount) return 'PAGADA';
  return 'PARCIAL';
}

export function balanceOf(invoice: Collectable): number {
  if (invoice.status === 'ANULADA') return 0;
  return round2(Math.max(0, invoice.totalAmount - invoice.paidAmount));
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

  workOrderId: string;
  workOrderComponent: string | null;

  customerLegalName: string | null;
  customerTaxId: string | null;
  customerTaxCondition: TaxCondition;
  customerAddress: string | null;

  issuerLegalName: string;
  issuerTaxId: string | null;
  issuerTaxCondition: TaxCondition;
  issuerAddress: string | null;
  issuerGrossIncome: string | null;
  issuerActivityStartDate: string | null;

  items: InvoiceItem[];
}

const LIST_SELECT =
  'id, full_number, invoice_type, status, customer_name, issue_date, due_date, ' +
  'total_amount, paid_amount, work_order:work_orders(number)';

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
       notes, voided_at, voided_reason, created_at, work_order_id,
       work_order:work_orders(number, component),
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

    issuerLegalName: row.issuer_legal_name,
    issuerTaxId: row.issuer_tax_id,
    issuerTaxCondition: row.issuer_tax_condition,
    issuerAddress: row.issuer_address,
    issuerGrossIncome: row.issuer_gross_income,
    issuerActivityStartDate: row.issuer_activity_start_date,

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
       customer:customers(name),
       vehicle:vehicles(brand, model, license_plate),
       invoices(status)`
    )
    .eq('status', 'TERMINADO')
    .order('created_at', { ascending: false });

  if (error) throw error;

  return ((data ?? []) as any[])
    .filter((row) => !(row.invoices ?? []).some((i: any) => i.status === 'EMITIDA'))
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
}

export async function issueInvoice(
  workOrderId: string,
  items: WorkOrderItemInput[],
  notes: string
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
  };
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
