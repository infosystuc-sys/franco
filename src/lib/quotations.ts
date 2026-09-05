import { supabase } from '@/src/lib/supabase';
import type { WorkOrderItemInput } from '@/src/lib/workOrders';

export type QuotationStatus = 'EMITIDA' | 'ENVIADA' | 'ACEPTADA' | 'RECHAZADA';

export const QUOTATION_STATUS_SEQUENCE: QuotationStatus[] = [
  'EMITIDA',
  'ENVIADA',
  'ACEPTADA',
  'RECHAZADA',
];

export const QUOTATION_STATUS_LABELS: Record<QuotationStatus, string> = {
  EMITIDA: 'Emitida',
  ENVIADA: 'Enviada',
  ACEPTADA: 'Aceptada',
  RECHAZADA: 'Rechazada',
};

/** Color de la tira lateral por estado, para leer el avance de un vistazo. */
export const QUOTATION_STATUS_STRIP: Record<QuotationStatus, string> = {
  EMITIDA: '#9a9a9a',
  ENVIADA: '#2b6cb0',
  ACEPTADA: '#2e7d32',
  RECHAZADA: '#c62828',
};

export const QUOTATION_STATUS_BADGE: Record<QuotationStatus, string> = {
  EMITIDA: 'bg-gray-100 text-gray-700',
  ENVIADA: 'bg-blue-100 text-blue-700',
  ACEPTADA: 'bg-green-100 text-green-700',
  RECHAZADA: 'bg-red-100 text-red-700',
};

/** Aceptada y Rechazada son estados finales: la cotización queda congelada. */
export function isQuotationEditable(status: QuotationStatus): boolean {
  return status === 'EMITIDA' || status === 'ENVIADA';
}

/**
 * Una cotización está vencida si pasó su fecha de validez y todavía no se
 * resolvió. El vencimiento solo avisa; no cambia el estado automáticamente.
 */
export function isExpired(validUntil: string | null, status: QuotationStatus): boolean {
  if (!validUntil) return false;
  if (status === 'ACEPTADA' || status === 'RECHAZADA') return false;
  return validUntil < new Date().toISOString().slice(0, 10);
}

export interface QuotationListRow {
  id: string;
  number: string;
  status: QuotationStatus;
  component: string | null;
  customerName: string;
  vehicleLabel: string;
  validUntil: string | null;
  total: number;
  workOrderId: string | null;
  workOrderNumber: string | null;
  publicToken: string;
  createdAt: string;
}

export interface QuotationDetail {
  id: string;
  number: string;
  status: QuotationStatus;
  component: string | null;
  notes: string | null;
  validUntil: string | null;
  customerId: string;
  vehicleId: string;
  customer: {
    name: string;
    legal_name: string | null;
    tax_id: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  vehicle: { brand: string | null; model: string; license_plate: string | null } | null;
  workOrderId: string | null;
  workOrderNumber: string | null;
  /** Identificador aleatorio con el que se arma el link para el cliente. */
  publicToken: string;
  items: WorkOrderItemInput[];
  createdAt: string;
  /** Cuándo respondió el cliente desde el link. Null si todavía no respondió. */
  decidedAt: string | null;
  /**
   * Por qué el cliente rechazó. Se conserva al reabrir la cotización: estás
   * recotizando por ese motivo, así que es cuando más sirve tenerlo.
   */
  rejectionReason: string | null;
}

function vehicleLabelOf(vehicle: { brand: string | null; model: string; license_plate: string | null } | null): string {
  if (!vehicle) return '—';
  const name = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
  return vehicle.license_plate ? `${name} - ${vehicle.license_plate}` : name;
}

const LIST_SELECT = `
  id, number, status, component, valid_until, created_at, public_token,
  customer:customers(name),
  vehicle:vehicles(brand, model, license_plate),
  work_order:work_orders!quotations_work_order_id_fkey(id, number),
  items:quotation_items(quantity, unit_price)
`;

function mapQuotationRow(row: any): QuotationListRow {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    component: row.component,
    customerName: row.customer?.name ?? '—',
    vehicleLabel: vehicleLabelOf(row.vehicle),
    validUntil: row.valid_until,
    total: (row.items ?? []).reduce(
      (sum: number, i: any) => sum + Number(i.quantity) * Number(i.unit_price),
      0
    ),
    workOrderId: row.work_order?.id ?? null,
    workOrderNumber: row.work_order?.number ?? null,
    publicToken: row.public_token,
    createdAt: row.created_at,
  };
}

export async function fetchQuotations(): Promise<QuotationListRow[]> {
  const { data, error } = await supabase
    .from('quotations')
    .select(LIST_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapQuotationRow);
}

/**
 * Cotizaciones de este cliente que todavía no pertenecen a ninguna orden.
 * Son las que se pueden enganchar a una OT recién abierta: el presupuesto que
 * se hizo por teléfono, antes de que el vehículo llegara al taller.
 */
export async function fetchUnlinkedQuotations(customerId: string): Promise<QuotationListRow[]> {
  const { data, error } = await supabase
    .from('quotations')
    .select(LIST_SELECT)
    .eq('customer_id', customerId)
    .is('work_order_id', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapQuotationRow);
}

const DETAIL_SELECT = `
  id, number, status, component, notes, valid_until, created_at, customer_id, vehicle_id, public_token,
  decided_at, rejection_reason,
  customer:customers(name, legal_name, tax_id, email, phone),
  vehicle:vehicles(brand, model, license_plate),
  work_order:work_orders!quotations_work_order_id_fkey(id, number),
  items:quotation_items(id, article_id, code, description, quantity, unit_price)
`;

export async function fetchQuotationByNumber(number: string): Promise<QuotationDetail | null> {
  const { data, error } = await supabase
    .from('quotations')
    .select(DETAIL_SELECT)
    .eq('number', number)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as any;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    component: row.component,
    notes: row.notes,
    validUntil: row.valid_until,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    customer: row.customer,
    vehicle: row.vehicle,
    workOrderId: row.work_order?.id ?? null,
    workOrderNumber: row.work_order?.number ?? null,
    publicToken: row.public_token,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    rejectionReason: row.rejection_reason,
    items: (row.items ?? []).map((item: any) => ({
      articleId: item.article_id ?? null,
      code: item.code ?? '',
      description: item.description,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
    })),
  };
}

export interface NewQuotationInput {
  customerId: string;
  vehicleId: string;
  component: string;
  validUntil: string;
  /** Se completa al crear desde un ingreso de vehículo: las observaciones pasan directo a las notas. */
  notes?: string;
}

export async function createQuotation(input: NewQuotationInput) {
  const { data, error } = await supabase
    .from('quotations')
    .insert({
      customer_id: input.customerId,
      vehicle_id: input.vehicleId,
      component: input.component || null,
      valid_until: input.validUntil || null,
      notes: input.notes || null,
    })
    .select('id, number')
    .single();
  if (error) throw error;
  return data as { id: string; number: string };
}

const DEFAULT_VALIDITY_DAYS = 15;

/** Vencimiento por defecto al crear una cotización nueva: hoy + 15 días. */
export function defaultValidUntil(): string {
  const date = new Date();
  date.setDate(date.getDate() + DEFAULT_VALIDITY_DAYS);
  return date.toISOString().slice(0, 10);
}

export async function updateQuotationStatus(id: string, status: QuotationStatus) {
  const { error } = await supabase.from('quotations').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function updateQuotationHeader(
  id: string,
  values: { component: string; notes: string; validUntil: string }
) {
  const { error } = await supabase
    .from('quotations')
    .update({
      component: values.component || null,
      notes: values.notes || null,
      valid_until: values.validUntil || null,
    })
    .eq('id', id);
  if (error) throw error;
}

/** Reemplaza los renglones en una sola transacción (RPC). */
export async function saveQuotationItems(quotationId: string, items: WorkOrderItemInput[]) {
  const { error } = await supabase.rpc('replace_quotation_items', {
    p_quotation_id: quotationId,
    p_items: items.map((item) => ({
      article_id: item.articleId,
      code: item.code,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unitPrice,
    })),
  });
  if (error) throw error;
}

/**
 * Aceptar la cotización llena la OT que ya existe: copia los renglones,
 * descuenta el stock y la autoriza, todo en una transacción. Si el stock no
 * alcanza, no cambia nada.
 *
 * Devuelve null cuando la cotización no tiene OT enganchada —el presupuesto
 * que se hizo por teléfono, antes de que el vehículo llegara—: ahí solo queda
 * aceptada, y la orden se abre cuando el cliente trae el vehículo.
 */
export async function applyQuotationToWorkOrder(
  quotationId: string
): Promise<{ id: string; number: string } | null> {
  const { data, error } = await supabase.rpc('apply_quotation_to_work_order', {
    p_quotation_id: quotationId,
  });
  if (error) throw error;
  const row: any = Array.isArray(data) ? data[0] : data;
  return row ? { id: row.result_id, number: row.result_number } : null;
}

/**
 * Rechazar mueve la OT enganchada a "Rechazada", que libera el lugar en la
 * playa. La cotización ya quedó rechazada por updateQuotationStatus; esto es
 * el efecto sobre la orden.
 */
export async function rejectQuotationWorkOrder(quotationId: string): Promise<void> {
  const { data: quotation, error } = await supabase
    .from('quotations')
    .select('work_order_id')
    .eq('id', quotationId)
    .single();
  if (error) throw error;
  if (!quotation?.work_order_id) return;

  const { data: estado, error: errorEstado } = await supabase
    .from('work_order_statuses')
    .select('id')
    .eq('label', 'Rechazada')
    .maybeSingle();
  if (errorEstado) throw errorEstado;
  if (!estado) throw new Error('Falta el estado "Rechazada" en el ABM de estados de OT.');

  const { error: errorUpdate } = await supabase
    .from('work_orders')
    .update({ status_id: estado.id })
    .eq('id', quotation.work_order_id);
  if (errorUpdate) throw errorUpdate;
}

/**
 * Engancha la cotización a la OT que la origina y mueve la orden a
 * "Cotizado". Sirve tanto para la cotización que se arma desde la OT como
 * para una suelta —el presupuesto que se hizo por teléfono— que después se
 * asocia cuando el cliente trae el vehículo.
 */
export async function linkQuotationToWorkOrder(quotationId: string, workOrderId: string): Promise<void> {
  const { error } = await supabase.rpc('link_quotation_to_work_order', {
    p_quotation_id: quotationId,
    p_work_order_id: workOrderId,
  });
  if (error) throw error;
}

export async function duplicateQuotation(quotationId: string): Promise<{ id: string; number: string }> {
  const { data, error } = await supabase.rpc('duplicate_quotation', {
    p_quotation_id: quotationId,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  return result as { id: string; number: string };
}

export async function deleteQuotation(id: string): Promise<void> {
  const { error } = await supabase.from('quotations').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Traduce errores de base a mensajes accionables.
 * El borrado de una cotización con OT lo rechaza la propia base
 * (FK on delete restrict), no solo la interfaz.
 */
export function describeQuotationError(message: string): string {
  if (
    message.includes('work_orders_quotation_id_fkey') ||
    message.includes('foreign key') ||
    message.includes('viola la llave')
  ) {
    return 'No se puede eliminar: la cotización ya generó una orden de trabajo. ' +
      'Es el registro de lo que el cliente aceptó y el origen de esa orden.';
  }
  return message;
}
