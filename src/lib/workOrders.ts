import { supabase } from '@/src/lib/supabase';
import type { TaxCondition } from '@/src/lib/customers';
import type { VehicleType } from '@/src/lib/vehicles';
import type { WorkOrderItem } from '@/src/types';

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

/**
 * Estados de la OT: ABM de configuración (work_order_statuses), no un enum
 * fijo. El admin agrega, renombra, reordena o desactiva estados desde su
 * propia pantalla, sin pedir un cambio de código. Tres marcas reemplazan lo
 * que antes eran comparaciones contra el texto literal de un estado:
 *  - isInitial: con qué estado nace una OT (a lo sumo uno).
 *  - isTerminal: cierra la orden — habilita facturar, cuenta como cerrada.
 *  - notifiesClient: al llegar acá se manda WhatsApp.
 *  - freesYard: al llegar acá el vehículo salió del taller y libera la playa.
 */
export interface WorkOrderStatusDef {
  id: string;
  label: string;
  clientDescription: string;
  color: string;
  sortOrder: number;
  active: boolean;
  isInitial: boolean;
  isTerminal: boolean;
  notifiesClient: boolean;
  freesYard: boolean;
}

export interface WorkOrderStatusInput {
  label: string;
  clientDescription: string;
  color: string;
  sortOrder: number;
  active: boolean;
  isInitial: boolean;
  isTerminal: boolean;
  notifiesClient: boolean;
  freesYard: boolean;
}

/** Referencia liviana al estado de una OT, tal como viaja embebida en listados y detalle. */
export interface WorkOrderStatusRef {
  id: string;
  label: string;
  color: string;
  isTerminal: boolean;
}

const STATUS_SELECT =
  'id, label, client_description, color, sort_order, active, is_initial, is_terminal, notifies_client, frees_yard';

function mapWorkOrderStatus(row: any): WorkOrderStatusDef {
  return {
    id: row.id,
    label: row.label,
    clientDescription: row.client_description,
    color: row.color,
    sortOrder: Number(row.sort_order),
    active: row.active,
    isInitial: row.is_initial,
    isTerminal: row.is_terminal,
    notifiesClient: row.notifies_client,
    freesYard: row.frees_yard,
  };
}

function mapWorkOrderStatusRef(row: any): WorkOrderStatusRef {
  return { id: row.id, label: row.label, color: row.color, isTerminal: row.is_terminal };
}

export async function fetchWorkOrderStatuses(onlyActive = false): Promise<WorkOrderStatusDef[]> {
  let query = supabase.from('work_order_statuses').select(STATUS_SELECT).order('sort_order');
  if (onlyActive) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapWorkOrderStatus);
}

function statusRow(input: WorkOrderStatusInput) {
  return {
    label: input.label,
    client_description: input.clientDescription,
    color: input.color,
    sort_order: input.sortOrder,
    active: input.active,
    is_initial: input.isInitial,
    is_terminal: input.isTerminal,
    notifies_client: input.notifiesClient,
    frees_yard: input.freesYard,
  };
}

export async function createWorkOrderStatus(input: WorkOrderStatusInput): Promise<WorkOrderStatusDef> {
  const { data, error } = await supabase
    .from('work_order_statuses')
    .insert(statusRow(input))
    .select(STATUS_SELECT)
    .single();
  if (error) throw error;
  return mapWorkOrderStatus(data);
}

export async function updateWorkOrderStatus(id: string, input: WorkOrderStatusInput): Promise<WorkOrderStatusDef> {
  const { data, error } = await supabase
    .from('work_order_statuses')
    .update(statusRow(input))
    .eq('id', id)
    .select(STATUS_SELECT)
    .single();
  if (error) throw error;
  return mapWorkOrderStatus(data);
}

export async function deleteWorkOrderStatus(id: string): Promise<void> {
  const { error } = await supabase.from('work_order_statuses').delete().eq('id', id);
  if (error) throw error;
}

export function describeWorkOrderStatusError(message: string): string {
  if (message.includes('work_order_statuses_one_initial')) {
    return 'Ya hay otro estado marcado como inicial. Sacale la marca a ese antes de ponérsela a este.';
  }
  if (message.includes('work_orders_status_id_fkey') || message.includes('foreign key')) {
    return 'No se puede eliminar: hay órdenes de trabajo en este estado. Podés desactivarlo en cambio.';
  }
  return message;
}

/**
 * Datos que ve el cliente en el link público. Es lo único que devuelve la
 * base: sin CUIT, sin teléfono, sin importes y sin precios de compra.
 */
export type PriceAuthStatus = 'PENDIENTE' | 'AUTORIZADO' | 'RECHAZADO';

export interface PublicWorkOrder {
  number: string;
  statusId: string;
  component: string | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  licensePlate: string | null;
  vehicleType: string | null;
  vehicleYear: number | null;
  engineBrand: string | null;
  engineModel: string | null;
  injectionSystem: string | null;
  employeeName: string | null;
  customerName: string | null;
  priceAuthStatus: PriceAuthStatus | null;
  priceAuthRequestedTotal: number | null;
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
    statusId: row.status_id,
    component: row.component,
    vehicleBrand: row.vehicle_brand,
    vehicleModel: row.vehicle_model,
    licensePlate: row.license_plate,
    vehicleType: row.vehicle_type,
    vehicleYear: row.vehicle_year,
    engineBrand: row.engine_brand,
    engineModel: row.engine_model,
    injectionSystem: row.injection_system,
    employeeName: row.employee_name,
    customerName: row.customer_name,
    priceAuthStatus: row.price_auth_status,
    priceAuthRequestedTotal: row.price_auth_requested_total === null ? null : Number(row.price_auth_requested_total),
  };
}

export type PriceAuthDecisionResult = 'PENDIENTE' | 'AUTORIZADO' | 'RECHAZADO' | 'NO_EXISTE' | 'YA_RESUELTA' | 'FALTA_MOTIVO';

export const PRICE_AUTH_DECISION_MESSAGES: Record<PriceAuthDecisionResult, string> = {
  PENDIENTE: 'Solicitud enviada.',
  AUTORIZADO: 'Autorizó el nuevo monto. El taller ya fue avisado y va a continuar con el trabajo.',
  RECHAZADO: 'Registramos que no autoriza el nuevo monto. El taller se va a comunicar.',
  NO_EXISTE: 'Este link no corresponde a ninguna orden.',
  YA_RESUELTA: 'Esta solicitud ya fue respondida. Si necesitás cambiarla, comunicate con el taller.',
  FALTA_MOTIVO: 'Para no autorizar el cambio tenés que contarnos el motivo.',
};

/**
 * Decisión del cliente sobre un cambio de precio, desde el mismo link de
 * seguimiento. Mismo patrón que decideQuotation: toda la validación vive en
 * la base porque el link es público.
 */
export async function decidePriceAuthorization(
  token: string,
  accept: boolean,
  reason = ''
): Promise<PriceAuthDecisionResult> {
  const { data, error } = await supabase.rpc('decide_price_authorization', {
    p_token: token,
    p_accept: accept,
    p_reason: reason.trim() || null,
  });
  if (error) throw error;
  return data as PriceAuthDecisionResult;
}

export async function fetchPublicStatusHistory(
  token: string
): Promise<{ toStatusId: string; changedAt: string }[]> {
  const { data, error } = await supabase.rpc('get_public_status_history', { p_token: token });
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({ toStatusId: r.to_status_id, changedAt: r.changed_at }));
}

export interface StatusChange {
  id: string;
  fromStatus: WorkOrderStatusRef | null;
  toStatus: WorkOrderStatusRef;
  changedByEmail: string | null;
  changedAt: string;
}

export interface WorkOrderListRow {
  id: string;
  number: string;
  status: WorkOrderStatusRef;
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

function mapWorkOrderListRow(row: any): WorkOrderListRow {
  return {
    id: row.id,
    number: row.number,
    status: mapWorkOrderStatusRef(row.status),
    component: row.component,
    customerName: row.customer?.name ?? '—',
    vehicleLabel: vehicleLabel(row.vehicle),
    publicToken: row.public_token,
  };
}

export interface WorkOrderStatusCount {
  status: WorkOrderStatusDef;
  count: number;
}

/**
 * Un contador por estado activo (en vez de cinco tarjetas fijas): la
 * cantidad de tarjetas y sus nombres siguen al ABM de estados solos, sin
 * tocar código acá cuando el admin agrega o renombra uno.
 */
export async function fetchDashboardData(): Promise<{ kpis: WorkOrderStatusCount[]; pendingOrders: WorkOrderListRow[] }> {
  const [rows, statuses] = await Promise.all([
    (async () => {
      const { data, error } = await supabase
        .from('work_orders')
        .select(
          `id, number, component, public_token,
           status:work_order_statuses(id, label, color, is_terminal),
           customer:customers(name),
           vehicle:vehicles(brand, model, license_plate)`
        )
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(mapWorkOrderListRow);
    })(),
    fetchWorkOrderStatuses(true),
  ]);

  const countByStatusId = new Map<string, number>();
  for (const row of rows) countByStatusId.set(row.status.id, (countByStatusId.get(row.status.id) ?? 0) + 1);

  const kpis: WorkOrderStatusCount[] = statuses.map((status) => ({
    status,
    count: countByStatusId.get(status.id) ?? 0,
  }));
  const pendingOrders = rows.filter((r) => !r.status.isTerminal);

  return { kpis, pendingOrders };
}

export interface WorkOrderRow extends WorkOrderListRow {
  employeeName: string | null;
  createdAt: string;
  /**
   * El total actual de la OT difiere del total de la cotización que la
   * originó, y ese cambio todavía no quedó autorizado por el cliente — el
   * mismo cálculo que el cartel de la ficha, para verlo de un vistazo en el
   * listado sin entrar a cada orden.
   */
  priceDiffers: boolean;
}

/**
 * Todas las órdenes, en cualquier estado. A diferencia de fetchDashboardData
 * —que solo trae lo pendiente, porque el Panel es una cola de trabajo— esta
 * alimenta el listado completo de /ordenes, con quién la tiene asignada y
 * desde cuándo.
 *
 * El RLS de work_orders ya filtra solo: un operario recibe únicamente sus
 * propias órdenes, sin que esta función tenga que saberlo.
 */
export async function fetchAllWorkOrders(): Promise<WorkOrderRow[]> {
  const { data, error } = await supabase
    .from('work_orders')
    .select(
      `id, number, component, public_token, created_at,
       price_auth_status, price_auth_requested_total,
       status:work_order_statuses(id, label, color, is_terminal),
       customer:customers(name),
       vehicle:vehicles(brand, model, license_plate),
       employee:employees(name),
       quotation:quotations!work_orders_quotation_id_fkey(items:quotation_items(subtotal)),
       items:work_order_items(subtotal)`
    )
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((row: any) => {
    const quotation = row.quotation;
    const quotedTotal = quotation
      ? (quotation.items ?? []).reduce((sum: number, i: any) => sum + Number(i.subtotal), 0)
      : null;
    const currentTotal = (row.items ?? []).reduce((sum: number, i: any) => sum + Number(i.subtotal), 0);
    const priceDiffers = quotedTotal !== null && Math.abs(currentTotal - quotedTotal) > 0.005;
    const priceAuthCoversCurrent =
      row.price_auth_status === 'AUTORIZADO' &&
      row.price_auth_requested_total !== null &&
      Math.abs(Number(row.price_auth_requested_total) - currentTotal) < 0.005;

    return {
      ...mapWorkOrderListRow(row),
      employeeName: row.employee?.name ?? null,
      createdAt: row.created_at,
      priceDiffers: priceDiffers && !priceAuthCoversCurrent,
    };
  });
}

/**
 * Si el usuario logueado es un operario, dice si tiene un empleado activo
 * vinculado. Sin esto, un operario dado de baja (o nunca vinculado) ve la
 * lista de órdenes vacía y no hay forma de distinguirlo de alguien que
 * simplemente todavía no tiene nada asignado.
 */
export async function hasLinkedEmployee(): Promise<boolean> {
  const { data, error } = await supabase.rpc('current_employee_id');
  if (error) throw error;
  return data !== null;
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
  const { data: initial, error: initialError } = await supabase
    .from('work_order_statuses')
    .select('id')
    .eq('is_initial', true)
    .limit(1)
    .maybeSingle();
  if (initialError) throw initialError;
  if (!initial) {
    throw new Error('No hay un estado inicial configurado para las órdenes de trabajo. Marcá uno desde Estados de OT.');
  }

  const { data: workOrder, error } = await supabase
    .from('work_orders')
    .insert({
      status_id: initial.id,
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
  status: WorkOrderStatusRef;
  component: string | null;
  customer:
    | {
        id: string;
        name: string;
        phone: string | null;
        legal_name: string | null;
        tax_id: string | null;
        tax_condition: TaxCondition;
        address_street: string | null;
        address_city: string | null;
        address_state: string | null;
        address_zip: string | null;
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
  employee: { id: string; name: string } | null;
  quotationNumber: string | null;
  /** Total de la cotización que le dio origen. Null si la OT no nació de una. */
  quotedTotal: number | null;
  priceAuth: {
    status: PriceAuthStatus | null;
    requestedTotal: number | null;
    requestedAt: string | null;
    decidedAt: string | null;
    reason: string | null;
  };
  /** Identificador aleatorio con el que se arma el link para el cliente. */
  publicToken: string;
  /** Cuándo estima el admin que el vehículo va a estar listo. Carga manual, opcional. */
  estimatedDeliveryDate: string | null;
  items: WorkOrderItem[];
  photos: WorkOrderPhoto[];
}

export interface WorkOrderPhoto {
  id: string;
  storagePath: string;
  createdAt: string;
}

export async function fetchWorkOrderByNumber(number: string): Promise<WorkOrderDetail | null> {
  const { data, error } = await supabase
    .from('work_orders')
    .select(
      `id, number, component, public_token, estimated_delivery_date,
       price_auth_status, price_auth_requested_total, price_auth_requested_at, price_auth_decided_at, price_auth_reason,
       status:work_order_statuses(id, label, color, is_terminal),
       customer:customers(id, name, phone, legal_name, tax_id, tax_condition,
                          address_street, address_city, address_state, address_zip),
       vehicle:vehicles(brand, model, license_plate, vehicle_type, year, engine_brand, engine_model, injection_system),
       employee:employees(id, name),
       quotation:quotations!work_orders_quotation_id_fkey(number, items:quotation_items(subtotal)),
       items:work_order_items(id, article_id, code, description, quantity, unit_price, subtotal),
       photos:work_order_photos(id, storage_path, created_at)`
    )
    .eq('number', number)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const quotation = (data as any).quotation;

  return {
    id: (data as any).id,
    number: (data as any).number,
    status: mapWorkOrderStatusRef((data as any).status),
    component: (data as any).component,
    customer: (data as any).customer,
    vehicle: (data as any).vehicle,
    employee: (data as any).employee,
    quotationNumber: quotation?.number ?? null,
    quotedTotal: quotation
      ? (quotation.items ?? []).reduce((sum: number, i: any) => sum + Number(i.subtotal), 0)
      : null,
    priceAuth: {
      status: (data as any).price_auth_status,
      requestedTotal: (data as any).price_auth_requested_total === null ? null : Number((data as any).price_auth_requested_total),
      requestedAt: (data as any).price_auth_requested_at,
      decidedAt: (data as any).price_auth_decided_at,
      reason: (data as any).price_auth_reason,
    },
    publicToken: (data as any).public_token,
    estimatedDeliveryDate: (data as any).estimated_delivery_date,
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
    photos: ((data as any).photos ?? [])
      .map((p: any) => ({ id: p.id, storagePath: p.storage_path, createdAt: p.created_at }))
      .sort((a: WorkOrderPhoto, b: WorkOrderPhoto) => a.createdAt.localeCompare(b.createdAt)),
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
 * Cambia el estado de la OT (a cuál de work_order_statuses). El historial lo
 * escribe un trigger en la base, así que no hace falta registrarlo desde acá.
 */
export async function setWorkOrderStatus(workOrderId: string, statusId: string) {
  const { error } = await supabase.from('work_orders').update({ status_id: statusId }).eq('id', workOrderId);
  if (error) throw error;
}

/**
 * Manda al cliente el aviso de que el monto cambió respecto a la cotización,
 * pidiéndole autorización. Mientras no responda con un sí para este mismo
 * monto, la base no deja llevar la OT a un estado terminal (no se factura
 * ni se cierra sin que el cliente lo haya autorizado).
 */
export async function requestPriceAuthorization(workOrderId: string): Promise<void> {
  const { error } = await supabase.rpc('request_price_authorization', { p_work_order_id: workOrderId });
  if (error) throw error;
}

export async function fetchStatusHistory(workOrderId: string): Promise<StatusChange[]> {
  const { data, error } = await supabase
    .from('work_order_status_history')
    .select(
      `id, changed_by_email, changed_at,
       from_status:work_order_statuses!work_order_status_history_from_status_id_fkey(id, label, color, is_terminal),
       to_status:work_order_statuses!work_order_status_history_to_status_id_fkey(id, label, color, is_terminal)`
    )
    .eq('work_order_id', workOrderId)
    .order('changed_at');
  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    id: row.id,
    fromStatus: row.from_status ? mapWorkOrderStatusRef(row.from_status) : null,
    toStatus: mapWorkOrderStatusRef(row.to_status),
    changedByEmail: row.changed_by_email,
    changedAt: row.changed_at,
  }));
}

/**
 * Asigna o desasigna el empleado que hace el trabajo. No toca el estado ni
 * dispara el aviso al cliente: ese mensaje se arma solo con datos del
 * vehículo y la orden, así que la asignación no lo afecta.
 */
export async function assignEmployee(workOrderId: string, employeeId: string | null) {
  const { error } = await supabase
    .from('work_orders')
    .update({ employee_id: employeeId })
    .eq('id', workOrderId);
  if (error) throw error;
}

/** Fecha estimada de entrega, para la vista de disponibilidad del taller. */
export async function setEstimatedDeliveryDate(workOrderId: string, date: string | null) {
  const { error } = await supabase
    .from('work_orders')
    .update({ estimated_delivery_date: date })
    .eq('id', workOrderId);
  if (error) throw error;
}

const PHOTOS_BUCKET = 'work-order-photos';

/**
 * Fotos del estado de las piezas durante la reparación. El archivo se guarda
 * como "<work_order_id>/<uuid>.<ext>": la política de storage.objects lee
 * ese primer segmento para aplicar la misma regla de "admin o el operario
 * asignado" que ya tiene la propia OT, sin depender de esta tabla.
 */
export async function uploadWorkOrderPhoto(workOrderId: string, file: File): Promise<WorkOrderPhoto> {
  const ext = file.name.includes('.') ? file.name.split('.').pop() : 'jpg';
  const path = `${workOrderId}/${crypto.randomUUID()}.${ext}`;

  const { error: errorSubida } = await supabase.storage.from(PHOTOS_BUCKET).upload(path, file, {
    contentType: file.type || 'image/jpeg',
  });
  if (errorSubida) throw errorSubida;

  const { data, error } = await supabase
    .from('work_order_photos')
    .insert({ work_order_id: workOrderId, storage_path: path })
    .select('id, storage_path, created_at')
    .single();

  if (error) {
    await supabase.storage.from(PHOTOS_BUCKET).remove([path]);
    throw error;
  }

  return { id: data.id, storagePath: data.storage_path, createdAt: data.created_at };
}

export async function deleteWorkOrderPhoto(photo: WorkOrderPhoto): Promise<void> {
  const { error } = await supabase.from('work_order_photos').delete().eq('id', photo.id);
  if (error) throw error;
  await supabase.storage.from(PHOTOS_BUCKET).remove([photo.storagePath]);
}

/** El bucket es privado: se muestra con una URL firmada, nunca con getPublicUrl. */
export async function getWorkOrderPhotoUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(PHOTOS_BUCKET).createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
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
