import { supabase } from '@/src/lib/supabase';
import { createQuotation, defaultValidUntil } from '@/src/lib/quotations';

export type VehicleIntakeStatus = 'PENDIENTE' | 'COTIZADO' | 'CERRADO';

export const VEHICLE_INTAKE_STATUS_LABELS: Record<VehicleIntakeStatus, string> = {
  PENDIENTE: 'Pendiente de cotizar',
  COTIZADO: 'Cotizado',
  CERRADO: 'Cerrado sin OT',
};

export const VEHICLE_INTAKE_STATUS_STRIP: Record<VehicleIntakeStatus, string> = {
  PENDIENTE: '#e07b1a',
  COTIZADO: '#2e7d32',
  CERRADO: '#6b7280',
};

const BUCKET = 'vehicle-intakes';

export interface VehicleIntakePhoto {
  id: string;
  storagePath: string;
  createdAt: string;
}

export interface VehicleIntakePart {
  id: string;
  name: string;
  serialNumber: string;
  createdAt: string;
}

export interface VehicleIntakeListRow {
  id: string;
  number: string;
  status: VehicleIntakeStatus;
  customerName: string;
  vehicleLabel: string;
  quotationNumber: string | null;
  photoCount: number;
  partsCount: number;
  createdAt: string;
}

export interface VehicleIntakeDetail {
  id: string;
  number: string;
  status: VehicleIntakeStatus;
  customerId: string;
  vehicleId: string;
  customerName: string;
  vehicleLabel: string;
  observations: string | null;
  quotationId: string | null;
  quotationNumber: string | null;
  photos: VehicleIntakePhoto[];
  parts: VehicleIntakePart[];
  createdAt: string;
}

export interface NewVehicleIntakeInput {
  customerId: string;
  vehicleId: string;
  observations: string;
}

const LIST_SELECT = `
  id, number, status, created_at,
  customer:customers(name),
  vehicle:vehicles(brand, model, license_plate),
  quotation:quotations(number),
  photos:vehicle_intake_photos(id),
  parts:vehicle_intake_parts(id)
`;

function vehicleLabelOf(vehicle: { brand: string | null; model: string; license_plate: string | null } | null): string {
  if (!vehicle) return '—';
  const name = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
  return vehicle.license_plate ? `${name} — ${vehicle.license_plate}` : name || '—';
}

export async function fetchVehicleIntakes(): Promise<VehicleIntakeListRow[]> {
  const { data, error } = await supabase
    .from('vehicle_intakes')
    .select(LIST_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    customerName: row.customer?.name ?? '—',
    vehicleLabel: vehicleLabelOf(row.vehicle),
    quotationNumber: row.quotation?.number ?? null,
    photoCount: row.photos?.length ?? 0,
    partsCount: row.parts?.length ?? 0,
    createdAt: row.created_at,
  }));
}

const DETAIL_SELECT = `
  id, number, status, observations, quotation_id, created_at,
  customer_id, vehicle_id,
  customer:customers(name),
  vehicle:vehicles(brand, model, license_plate),
  quotation:quotations(number),
  photos:vehicle_intake_photos(id, storage_path, created_at),
  parts:vehicle_intake_parts(id, name, serial_number, created_at)
`;

export async function fetchVehicleIntake(id: string): Promise<VehicleIntakeDetail | null> {
  const { data, error } = await supabase
    .from('vehicle_intakes')
    .select(DETAIL_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as any;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    customerName: row.customer?.name ?? '—',
    vehicleLabel: vehicleLabelOf(row.vehicle),
    observations: row.observations,
    quotationId: row.quotation_id,
    quotationNumber: row.quotation?.number ?? null,
    photos: (row.photos ?? [])
      .map((p: any) => ({ id: p.id, storagePath: p.storage_path, createdAt: p.created_at }))
      .sort((a: VehicleIntakePhoto, b: VehicleIntakePhoto) => a.createdAt.localeCompare(b.createdAt)),
    parts: (row.parts ?? [])
      .map((p: any) => ({ id: p.id, name: p.name, serialNumber: p.serial_number, createdAt: p.created_at }))
      .sort((a: VehicleIntakePart, b: VehicleIntakePart) => a.createdAt.localeCompare(b.createdAt)),
    createdAt: row.created_at,
  };
}

export async function createVehicleIntake(input: NewVehicleIntakeInput): Promise<{ id: string; number: string }> {
  const { data, error } = await supabase
    .from('vehicle_intakes')
    .insert({
      customer_id: input.customerId,
      vehicle_id: input.vehicleId,
      observations: input.observations || null,
    })
    .select('id, number')
    .single();
  if (error) throw error;
  return data as { id: string; number: string };
}

export async function updateVehicleIntake(
  id: string,
  values: { observations: string }
): Promise<void> {
  const { error } = await supabase
    .from('vehicle_intakes')
    .update({ observations: values.observations || null })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteVehicleIntake(id: string): Promise<void> {
  const { error } = await supabase.from('vehicle_intakes').delete().eq('id', id);
  if (error) throw error;
}

/** Sube una foto tomada en el momento y la vincula al ingreso. */
export async function uploadIntakePhoto(intakeId: string, file: File): Promise<VehicleIntakePhoto> {
  const ext = file.name.includes('.') ? file.name.split('.').pop() : 'jpg';
  const path = `${intakeId}/${crypto.randomUUID()}.${ext}`;

  const { error: errorSubida } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'image/jpeg',
  });
  if (errorSubida) throw errorSubida;

  const { data, error } = await supabase
    .from('vehicle_intake_photos')
    .insert({ intake_id: intakeId, storage_path: path })
    .select('id, storage_path, created_at')
    .single();

  if (error) {
    // La foto quedó subida pero sin registrar: no sirve de nada huérfana.
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }

  return { id: data.id, storagePath: data.storage_path, createdAt: data.created_at };
}

export async function deleteIntakePhoto(photo: VehicleIntakePhoto): Promise<void> {
  const { error } = await supabase.from('vehicle_intake_photos').delete().eq('id', photo.id);
  if (error) throw error;
  await supabase.storage.from(BUCKET).remove([photo.storagePath]);
}

/**
 * Piezas del ingreso (inyector, bomba...), identificadas por N° de serie.
 * No hace falta cargarlas al recibir el vehículo: se agregan, editan o
 * borran en cualquier momento desde el detalle del ingreso.
 */
export async function addIntakePart(
  intakeId: string,
  values: { name: string; serialNumber: string }
): Promise<VehicleIntakePart> {
  const { data, error } = await supabase
    .from('vehicle_intake_parts')
    .insert({ intake_id: intakeId, name: values.name, serial_number: values.serialNumber })
    .select('id, name, serial_number, created_at')
    .single();
  if (error) throw error;
  return { id: data.id, name: data.name, serialNumber: data.serial_number, createdAt: data.created_at };
}

export async function updateIntakePart(
  id: string,
  values: { name: string; serialNumber: string }
): Promise<void> {
  const { error } = await supabase
    .from('vehicle_intake_parts')
    .update({ name: values.name, serial_number: values.serialNumber })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteIntakePart(id: string): Promise<void> {
  const { error } = await supabase.from('vehicle_intake_parts').delete().eq('id', id);
  if (error) throw error;
}

/** El bucket es privado: se muestra con una URL firmada, nunca con getPublicUrl. */
export async function getIntakePhotoUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Crea la cotización con los mismos datos del ingreso (las observaciones
 * van al campo notes que la cotización ya tenía) y marca el ingreso como
 * cotizado, vinculado a ella.
 */
export async function convertIntakeToQuotation(
  intake: VehicleIntakeDetail
): Promise<{ id: string; number: string }> {
  const quotation = await createQuotation({
    customerId: intake.customerId,
    vehicleId: intake.vehicleId,
    component: '',
    notes: intake.observations ?? '',
    validUntil: defaultValidUntil(),
  });

  const { error } = await supabase
    .from('vehicle_intakes')
    .update({ status: 'COTIZADO', quotation_id: quotation.id })
    .eq('id', intake.id);
  if (error) throw error;

  return quotation;
}

export function describeVehicleIntakeError(message: string): string {
  if (message.includes('vehicle_intakes_quotation_id_fkey')) {
    return 'No se puede eliminar: la cotización que generó todavía existe.';
  }
  return message;
}

/**
 * El vehículo se fue sin que el ingreso derivara en una orden de trabajo —
 * típicamente porque el cliente rechazó el presupuesto. Cierra el ingreso
 * para que deje de ocupar un lugar en la playa.
 */
export async function closeVehicleIntake(id: string): Promise<void> {
  const { error } = await supabase
    .from('vehicle_intakes')
    .update({ status: 'CERRADO' })
    .eq('id', id);
  if (error) throw error;
}
