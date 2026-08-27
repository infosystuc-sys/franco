import { supabase } from '@/src/lib/supabase';
import { createQuotation, defaultValidUntil } from '@/src/lib/quotations';

export type VehicleIntakeStatus = 'PENDIENTE' | 'COTIZADO';

export const VEHICLE_INTAKE_STATUS_LABELS: Record<VehicleIntakeStatus, string> = {
  PENDIENTE: 'Pendiente de cotizar',
  COTIZADO: 'Cotizado',
};

export const VEHICLE_INTAKE_STATUS_STRIP: Record<VehicleIntakeStatus, string> = {
  PENDIENTE: '#e07b1a',
  COTIZADO: '#2e7d32',
};

const BUCKET = 'vehicle-intakes';

export interface VehicleIntakePhoto {
  id: string;
  storagePath: string;
  createdAt: string;
}

export interface VehicleIntakeListRow {
  id: string;
  number: string;
  status: VehicleIntakeStatus;
  component: string | null;
  customerName: string;
  vehicleLabel: string;
  quotationNumber: string | null;
  photoCount: number;
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
  component: string | null;
  observations: string | null;
  quotationId: string | null;
  quotationNumber: string | null;
  photos: VehicleIntakePhoto[];
  createdAt: string;
}

export interface NewVehicleIntakeInput {
  customerId: string;
  vehicleId: string;
  component: string;
  observations: string;
}

const LIST_SELECT = `
  id, number, status, component, created_at,
  customer:customers(name),
  vehicle:vehicles(brand, model, license_plate),
  quotation:quotations(number),
  photos:vehicle_intake_photos(id)
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
    component: row.component,
    customerName: row.customer?.name ?? '—',
    vehicleLabel: vehicleLabelOf(row.vehicle),
    quotationNumber: row.quotation?.number ?? null,
    photoCount: row.photos?.length ?? 0,
    createdAt: row.created_at,
  }));
}

const DETAIL_SELECT = `
  id, number, status, component, observations, quotation_id, created_at,
  customer_id, vehicle_id,
  customer:customers(name),
  vehicle:vehicles(brand, model, license_plate),
  quotation:quotations(number),
  photos:vehicle_intake_photos(id, storage_path, created_at)
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
    component: row.component,
    observations: row.observations,
    quotationId: row.quotation_id,
    quotationNumber: row.quotation?.number ?? null,
    photos: (row.photos ?? [])
      .map((p: any) => ({ id: p.id, storagePath: p.storage_path, createdAt: p.created_at }))
      .sort((a: VehicleIntakePhoto, b: VehicleIntakePhoto) => a.createdAt.localeCompare(b.createdAt)),
    createdAt: row.created_at,
  };
}

export async function createVehicleIntake(input: NewVehicleIntakeInput): Promise<{ id: string; number: string }> {
  const { data, error } = await supabase
    .from('vehicle_intakes')
    .insert({
      customer_id: input.customerId,
      vehicle_id: input.vehicleId,
      component: input.component || null,
      observations: input.observations || null,
    })
    .select('id, number')
    .single();
  if (error) throw error;
  return data as { id: string; number: string };
}

export async function updateVehicleIntake(
  id: string,
  values: { component: string; observations: string }
): Promise<void> {
  const { error } = await supabase
    .from('vehicle_intakes')
    .update({ component: values.component || null, observations: values.observations || null })
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
    component: intake.component ?? '',
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
