import { supabase } from '@/src/lib/supabase';
import type { TaxCondition } from '@/src/lib/customers';
import type { VehicleType } from '@/src/lib/vehicles';
import type { WorkOrderStatus, WorkOrderItem } from '@/src/types';

/**
 * Traduce errores de base a mensajes accionables.
 * Una OT originada en una cotización no puede eliminarse: la base lo rechaza
 * (FK on delete restrict) para no romper la trazabilidad entre ambas.
 */
export function describeWorkOrderError(message: string): string {
  if (
    message.includes('quotations_work_order_id_fkey') ||
    message.includes('foreign key') ||
    message.includes('viola la llave')
  ) {
    return 'No se puede eliminar: la orden proviene de una cotización aceptada. ' +
      'Eliminarla rompería la trazabilidad con el presupuesto que aprobó el cliente.';
  }
  return message;
}

export function getErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
    return (err as any).message;
  }
  return err instanceof Error ? err.message : 'Error desconocido.';
}

// La etapa de cotización vive en su propio módulo (src/lib/quotations.ts).
// La OT nace ya autorizada, porque proviene de una cotización aceptada.
export const STATUS_SEQUENCE: WorkOrderStatus[] = [
  'AUTORIZADO',
  'EN_ESPERA_REP',
  'EN_REPARACION',
  'CALIBRACION',
  'TERMINADO',
];

export const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  AUTORIZADO: 'Autorizada',
  EN_ESPERA_REP: 'Esp. Repuestos',
  EN_REPARACION: 'En Reparación',
  CALIBRACION: 'Calibración',
  TERMINADO: 'Terminado',
};

export const STATUS_BADGE_CLASS: Record<WorkOrderStatus, string> = {
  AUTORIZADO: 'bg-blue-100 text-blue-700',
  EN_ESPERA_REP: 'bg-orange-100 text-orange-700',
  EN_REPARACION: 'bg-purple-100 text-purple-700',
  CALIBRACION: 'bg-yellow-100 text-yellow-800',
  TERMINADO: 'bg-green-100 text-green-700',
};

/**
 * Color de la tira lateral por estado. Codifica el avance real de la orden,
 * así el estado se lee de un vistazo en cualquier listado.
 */
export const STATUS_STRIP: Record<WorkOrderStatus, string> = {
  AUTORIZADO: '#2b6cb0',
  EN_ESPERA_REP: '#e07b1a',
  EN_REPARACION: '#7b3fa0',
  CALIBRACION: '#c9a227',
  TERMINADO: '#2e7d32',
};

/** Estado siguiente en el flujo natural, o null si ya está terminada. */
export function nextStatus(current: WorkOrderStatus): WorkOrderStatus | null {
  const index = STATUS_SEQUENCE.indexOf(current);
  if (index === -1 || index === STATUS_SEQUENCE.length - 1) return null;
  return STATUS_SEQUENCE[index + 1];
}

/**
 * Datos que ve el cliente en el link público. Es lo único que devuelve la
 * base: sin CUIT, sin teléfono, sin importes y sin precios de compra.
 */
export interface PublicWorkOrder {
  number: string;
  status: WorkOrderStatus;
  component: string | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  licensePlate: string | null;
  vehicleType: string | null;
  vehicleYear: number | null;
  engineBrand: string | null;
  engineModel: string | null;
  injectionSystem: string | null;
  technicianName: string | null;
  customerName: string | null;
}

/**
 * Consulta pública por token. No requiere sesión: la propia base filtra por
 * el token y devuelve una sola orden. Un token inexistente devuelve null.
 */
export async function fetchPublicWorkOrder(token: string): Promise<PublicWorkOrder | null> {
  const { data, error } = await supabase.rpc('get_public_work_order', { p_token: token });
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) return null;

  return {
    number: row.number,
    status: row.status,
    component: row.component,
    vehicleBrand: row.vehicle_brand,
    vehicleModel: row.vehicle_model,
    licensePlate: row.license_plate,
    vehicleType: row.vehicle_type,
    vehicleYear: row.vehicle_year,
    engineBrand: row.engine_brand,
    engineModel: row.engine_model,
    injectionSystem: row.injection_system,
    technicianName: row.technician_name,
    customerName: row.customer_name,
  };
}

export async function fetchPublicStatusHistory(
  token: string
): Promise<{ toStatus: WorkOrderStatus; changedAt: string }[]> {
  const { data, error } = await supabase.rpc('get_public_status_history', { p_token: token });
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({ toStatus: r.to_status, changedAt: r.changed_at }));
}

export interface StatusChange {
  id: string;
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus;
  changedByEmail: string | null;
  changedAt: string;
}

export const STATUS_DESCRIPTIONS: Record<WorkOrderStatus, string> = {
  AUTORIZADO: 'El cliente autorizó el trabajo. Se procederá con la reparación.',
  EN_ESPERA_REP: 'Se están gestionando los repuestos necesarios.',
  EN_REPARACION: 'El componente está siendo reparado en el taller.',
  CALIBRACION: 'Se está calibrando y probando el componente reparado.',
  TERMINADO: 'El servicio finalizó. Listo para retirar.',
};

export interface WorkOrderListRow {
  id: string;
  number: string;
  status: WorkOrderStatus;
  component: string | null;
  customerName: string;
  vehicleLabel: string;
  publicToken: string;
}

function vehicleLabel(
  vehicle: { brand: string | null; model: string; license_plate: string | null } | null
): string {
  if (!vehicle) return '—';
  const name = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
  return vehicle.license_plate ? `${name} - Placa ${vehicle.license_plate}` : name;
}

export async function fetchDashboardData() {
  const { data, error } = await supabase
    .from('work_orders')
    .select('id, number, status, component, public_token, customer:customers(name), vehicle:vehicles(brand, model, license_plate)')
    .order('created_at', { ascending: false });

  if (error) throw error;

  const rows: WorkOrderListRow[] = (data ?? []).map((row: any) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    component: row.component,
    customerName: row.customer?.name ?? '—',
    vehicleLabel: vehicleLabel(row.vehicle),
    publicToken: row.public_token,
  }));

  const kpis = {
    autorizadas: rows.filter((r) => r.status === 'AUTORIZADO').length,
    enReparacion: rows.filter((r) => r.status === 'EN_REPARACION').length,
    espRepuestos: rows.filter((r) => r.status === 'EN_ESPERA_REP').length,
    terminadasHoy: rows.filter((r) => r.status === 'TERMINADO').length,
    cerradasMes: rows.filter((r) => r.status === 'TERMINADO').length,
  };

  const pendingOrders = rows.filter((r) => r.status !== 'TERMINADO');

  return { kpis, pendingOrders };
}

export interface NewWorkOrderInput {
  customerId: string;
  vehicleId: string;
  component: string;
}

/**
 * Crea una OT directa (sin cotización previa), para trabajos que no la
 * requieren. El número lo asigna la secuencia de la base, igual que en la
 * conversión desde cotización, así no hay riesgo de números repetidos.
 */
export async function createWorkOrder(input: NewWorkOrderInput) {
  const { data: workOrder, error } = await supabase
    .from('work_orders')
    .insert({
      status: 'AUTORIZADO',
      customer_id: input.customerId,
      vehicle_id: input.vehicleId,
      component: input.component || null,
    })
    .select()
    .single();
  if (error) throw error;

  return workOrder;
}

export interface WorkOrderDetail {
  id: string;
  number: string;
  status: WorkOrderStatus;
  component: string | null;
  customer:
    | {
        name: string;
        phone: string | null;
        legal_name: string | null;
        tax_id: string | null;
        tax_condition: TaxCondition;
      }
    | null;
  vehicle:
    | {
        brand: string | null;
        model: string;
        license_plate: string | null;
        vehicle_type: VehicleType;
        year: number | null;
        engine_brand: string | null;
        engine_model: string | null;
        injection_system: string | null;
      }
    | null;
  technician: { name: string } | null;
  quotationNumber: string | null;
  /** Identificador aleatorio con el que se arma el link para el cliente. */
  publicToken: string;
  items: WorkOrderItem[];
}

export async function fetchWorkOrderByNumber(number: string): Promise<WorkOrderDetail | null> {
  const { data, error } = await supabase
    .from('work_orders')
    .select(
      `id, number, status, component, public_token,
       customer:customers(name, phone, legal_name, tax_id, tax_condition),
       vehicle:vehicles(brand, model, license_plate, vehicle_type, year, engine_brand, engine_model, injection_system),
       technician:technicians(name),
       quotation:quotations!work_orders_quotation_id_fkey(number),
       items:work_order_items(id, article_id, code, description, quantity, unit_price, subtotal)`
    )
    .eq('number', number)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: (data as any).id,
    number: (data as any).number,
    status: (data as any).status,
    component: (data as any).component,
    customer: (data as any).customer,
    vehicle: (data as any).vehicle,
    technician: (data as any).technician,
    quotationNumber: (data as any).quotation?.number ?? null,
    publicToken: (data as any).public_token,
    items: ((data as any).items ?? []).map((item: any) => ({
      id: item.id,
      workOrderId: (data as any).id,
      articleId: item.article_id ?? null,
      code: item.code ?? '',
      description: item.description,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      subtotal: Number(item.subtotal),
    })),
  };
}

export interface WorkOrderItemInput {
  articleId: string | null;
  code: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Cambia el estado de la OT. El historial lo escribe un trigger en la base,
 * así que no hace falta registrarlo desde acá.
 */
export async function updateWorkOrderStatus(id: string, status: WorkOrderStatus) {
  const { error } = await supabase.from('work_orders').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function fetchStatusHistory(workOrderId: string): Promise<StatusChange[]> {
  const { data, error } = await supabase
    .from('work_order_status_history')
    .select('id, from_status, to_status, changed_by_email, changed_at')
    .eq('work_order_id', workOrderId)
    .order('changed_at');
  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedByEmail: row.changed_by_email,
    changedAt: row.changed_at,
  }));
}

/**
 * Reemplaza los renglones de la OT en una sola transacción del lado de la
 * base (RPC). Si algo falla —típicamente stock insuficiente— se revierte
 * todo y la OT conserva los renglones que tenía.
 */
export async function saveWorkOrderItems(workOrderId: string, items: WorkOrderItemInput[]) {
  const { error } = await supabase.rpc('replace_work_order_items', {
    p_work_order_id: workOrderId,
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
