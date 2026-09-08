import { supabase } from '@/src/lib/supabase';

/**
 * Fotos de la ficha del equipo.
 *
 * Van pegadas al vehículo o a la pieza, no a la orden: sirven para dejar
 * asentado el estado con que llegó y para reconocerlo la próxima vez que
 * entre, aunque sea por otra orden.
 */

const BUCKET = 'vehicle-photos';

export interface VehiclePhoto {
  id: string;
  storagePath: string;
  createdAt: string;
}

export async function fetchVehiclePhotos(vehicleId: string): Promise<VehiclePhoto[]> {
  const { data, error } = await supabase
    .from('vehicle_photos')
    .select('id, storage_path, created_at')
    .eq('vehicle_id', vehicleId)
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    id: r.id,
    storagePath: r.storage_path,
    createdAt: r.created_at,
  }));
}

/**
 * El archivo se guarda como "<vehicle_id>/<uuid>.<ext>": la política de
 * storage.objects mira ese primer segmento, así que el permiso no depende de
 * la tabla vehicle_photos.
 */
export async function uploadVehiclePhoto(vehicleId: string, file: File): Promise<VehiclePhoto> {
  const ext = file.name.includes('.') ? file.name.split('.').pop() : 'jpg';
  const path = `${vehicleId}/${crypto.randomUUID()}.${ext}`;

  const { error: errorSubida } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'image/jpeg',
  });
  if (errorSubida) throw errorSubida;

  const { data, error } = await supabase
    .from('vehicle_photos')
    .insert({ vehicle_id: vehicleId, storage_path: path })
    .select('id, storage_path, created_at')
    .single();

  if (error) {
    // Si la fila no entra, el archivo subido queda huérfano en el bucket y no
    // hay nada que lo referencie: se borra en el momento.
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }

  return { id: data.id, storagePath: data.storage_path, createdAt: data.created_at };
}

export async function deleteVehiclePhoto(photo: VehiclePhoto): Promise<void> {
  const { error } = await supabase.from('vehicle_photos').delete().eq('id', photo.id);
  if (error) throw error;
  // El archivo se borra después de la fila: si fallara, queda un archivo suelto
  // —molesto pero inofensivo—, mientras que al revés quedaría una foto rota en
  // pantalla.
  await supabase.storage.from(BUCKET).remove([photo.storagePath]);
}

/** El bucket es privado: se muestra con URL firmada, nunca pública. */
export async function getVehiclePhotoUrl(photo: VehiclePhoto): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(photo.storagePath, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}
