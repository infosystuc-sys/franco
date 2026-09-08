import { supabase } from '@/src/lib/supabase';

/**
 * Catálogo de marcas y modelos.
 *
 * No es una lista cerrada: marca y modelo se siguen escribiendo libremente y
 * lo nuevo queda guardado para la próxima carga. El catálogo existe para que
 * el mismo camión no entre como "volvo", "Volvo" y "VOLVO" según quién lo
 * cargue, no para frenar a quien está recibiendo un vehículo en el mostrador.
 *
 * vehicles.brand y vehicles.model siguen siendo texto: esto alimenta las
 * sugerencias, no reemplaza al dato.
 */

export interface VehicleBrand {
  id: string;
  name: string;
}

export interface VehicleModel {
  id: string;
  brandId: string;
  name: string;
}

export async function fetchVehicleBrands(): Promise<VehicleBrand[]> {
  const { data, error } = await supabase
    .from('vehicle_brands')
    .select('id, name')
    .order('name');
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.name }));
}

/** Todos los modelos, con su marca. Son pocos: se traen de una y se filtran en pantalla. */
export async function fetchVehicleModels(): Promise<VehicleModel[]> {
  const { data, error } = await supabase
    .from('vehicle_models')
    .select('id, brand_id, name')
    .order('name');
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ id: r.id, brandId: r.brand_id, name: r.name }));
}

/**
 * Suma al catálogo lo que se acaba de escribir. Se llama después de guardar el
 * vehículo, nunca antes: si el alta falla, el catálogo no se ensucia con una
 * marca que en realidad no se usó.
 *
 * Va por RPC y no por dos inserts desde el navegador porque dos altas
 * simultáneas de la misma marca chocarían contra el índice único, y una de las
 * dos se caería con un error que el usuario no puede entender.
 *
 * Si falla, el vehículo ya está guardado igual: por eso quien la llama la deja
 * pasar en silencio en vez de mostrar un error por algo que no le importa a
 * quien está cargando.
 */
export async function registerBrandAndModel(brand: string, model: string): Promise<void> {
  const { error } = await supabase.rpc('registrar_marca_modelo', {
    p_marca: brand,
    p_modelo: model,
  });
  if (error) throw error;
}

/** Los modelos de una marca, buscándola por nombre sin distinguir mayúsculas. */
export function modelsOfBrand(
  brands: VehicleBrand[],
  models: VehicleModel[],
  brandName: string
): VehicleModel[] {
  const nombre = brandName.trim().toLowerCase();
  if (!nombre) return [];
  const marca = brands.find((b) => b.name.toLowerCase() === nombre);
  if (!marca) return [];
  return models.filter((m) => m.brandId === marca.id);
}
