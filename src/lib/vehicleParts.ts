import { supabase } from '@/src/lib/supabase';

/**
 * Renglones de un ingreso de piezas.
 *
 * Al mostrador no llega "una pieza": llega un juego. Seis inyectores y la
 * bomba, cada uno con su referencia. Por eso el ingreso de piezas es una ficha
 * con renglones y no una ficha por pieza.
 */

export interface VehiclePart {
  id: string;
  partType: string;
  brand: string;
  model: string;
  referenceNumber: string;
  quantity: string;
}

export interface VehiclePartType {
  id: string;
  name: string;
}

/** Un renglón vacío, listo para escribir encima. */
export function nuevoRenglon(): VehiclePart {
  return {
    id: crypto.randomUUID(),
    partType: '',
    brand: '',
    model: '',
    referenceNumber: '',
    quantity: '1',
  };
}

/**
 * Un renglón cuenta si tiene tipo. Lo demás es descripción: puede entrar una
 * pieza sin marca ni número de referencia legible, y sigue siendo una pieza
 * que hay que recibir.
 */
export function renglonCargado(parte: VehiclePart): boolean {
  return parte.partType.trim().length > 0;
}

export async function fetchVehiclePartTypes(): Promise<VehiclePartType[]> {
  const { data, error } = await supabase
    .from('vehicle_part_types')
    .select('id, name')
    .order('name');
  if (error) throw error;
  return data ?? [];
}

export async function fetchVehicleParts(vehicleId: string): Promise<VehiclePart[]> {
  const { data, error } = await supabase
    .from('vehicle_parts')
    .select('id, part_type, brand, model, reference_number, quantity')
    .eq('vehicle_id', vehicleId)
    .order('position');
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    partType: row.part_type,
    brand: row.brand ?? '',
    model: row.model ?? '',
    referenceNumber: row.reference_number ?? '',
    quantity: String(row.quantity ?? 1),
  }));
}

/**
 * Se reemplazan todos: editar un ingreso es volver a decir qué se recibió, y
 * llevar la cuenta de cuál renglón se borró y cuál cambió cuesta más que
 * escribirlos de nuevo. Son unas pocas filas por ficha.
 */
export async function saveVehicleParts(vehicleId: string, partes: VehiclePart[]): Promise<void> {
  const cargados = partes.filter(renglonCargado);

  const { error: errorBorrado } = await supabase
    .from('vehicle_parts')
    .delete()
    .eq('vehicle_id', vehicleId);
  if (errorBorrado) throw errorBorrado;

  if (cargados.length === 0) return;

  const { error } = await supabase.from('vehicle_parts').insert(
    cargados.map((parte, indice) => ({
      vehicle_id: vehicleId,
      part_type: parte.partType.trim(),
      brand: parte.brand.trim() || null,
      model: parte.model.trim() || null,
      reference_number: parte.referenceNumber.trim() || null,
      // La cantidad nunca baja de 1: la base rechaza el cero, y un renglón de
      // cero piezas no significa nada.
      quantity: Math.max(1, Math.trunc(Number(parte.quantity) || 1)),
      position: indice,
    }))
  );
  if (error) throw error;
}

/**
 * Los tipos nuevos quedan en el catálogo para la próxima carga. Si falla, el
 * ingreso ya se guardó: no vale la pena hacerlo fracasar por una sugerencia.
 */
export async function registrarTiposDePieza(partes: VehiclePart[]): Promise<void> {
  const tipos = new Set(
    partes.filter(renglonCargado).map((parte) => parte.partType.trim())
  );
  for (const tipo of tipos) {
    await supabase.rpc('registrar_tipo_de_pieza', { p_tipo: tipo });
  }
}

/**
 * Cómo se rotula la ficha cuando lo que entró es un juego de piezas.
 *
 * `vehicles.brand/model/reference_number` los leen el listado de vehículos, el
 * selector de la OT, las cotizaciones y los remitos. Se completan con el
 * primer renglón para que un ingreso de piezas no aparezca en blanco en media
 * app; el detalle completo vive en los renglones.
 */
export function rotuloDeLaFicha(partes: VehiclePart[]): {
  brand: string;
  model: string;
  referenceNumber: string;
} {
  const primero = partes.find(renglonCargado);
  if (!primero) return { brand: '', model: '', referenceNumber: '' };
  return {
    brand: primero.brand.trim(),
    // El modelo es obligatorio en la base. Si el renglón no lo trae, el tipo
    // de pieza describe mejor que un guión: "Inyector" dice algo, "—" no.
    model: primero.model.trim() || primero.partType.trim(),
    referenceNumber: primero.referenceNumber.trim(),
  };
}
