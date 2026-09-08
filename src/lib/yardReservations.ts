import { supabase } from '@/src/lib/supabase';
import type { SizeClass } from '@/src/lib/vehicles';
import type { YardOccupant } from '@/src/lib/yardCapacity';

/**
 * Reservas de celda.
 *
 * El cliente avisa que el martes trae el camión. Una reserva ocupa celda igual
 * que un vehículo presente —esa es la idea— pero se muestra aparte: no es lo
 * mismo tener el camión que esperarlo.
 */

export interface YardReservation {
  id: string;
  customerId: string;
  customerName: string;
  vehicleId: string | null;
  licensePlate: string;
  sizeClass: SizeClass;
  startsOn: string;
  endsOn: string;
  notes: string | null;
  createdAt: string;
}

export interface YardReservationInput {
  customerId: string;
  licensePlate: string;
  sizeClass: SizeClass | '';
  startsOn: string;
  endsOn: string;
  notes: string;
}

const SELECT = `
  id, customer_id, vehicle_id, license_plate, size_class, starts_on, ends_on, notes, created_at,
  customer:customers(name)
`;

function mapReservation(row: any): YardReservation {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer?.name ?? '—',
    vehicleId: row.vehicle_id ?? null,
    licensePlate: row.license_plate,
    sizeClass: row.size_class,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function fetchYardReservations(): Promise<YardReservation[]> {
  const { data, error } = await supabase
    .from('yard_reservations')
    .select(SELECT)
    .order('starts_on');
  if (error) throw error;
  return (data ?? []).map(mapReservation);
}

/**
 * Las patentes se comparan sin espacios ni guiones y en mayúsculas: la misma
 * chapa se tipea "ABC 123", "abc-123" y "ABC123" según quién la cargue.
 */
export function normalizarPatente(patente: string | null): string {
  return (patente ?? '').replace(/[\s-]/g, '').toUpperCase();
}

export async function createYardReservation(input: YardReservationInput): Promise<void> {
  const { error } = await supabase.from('yard_reservations').insert({
    customer_id: input.customerId,
    license_plate: normalizarPatente(input.licensePlate),
    size_class: input.sizeClass || 'MEDIANO',
    starts_on: input.startsOn,
    ends_on: input.endsOn,
    notes: input.notes.trim() || null,
  });
  if (error) throw error;
}

/**
 * Editar una reserva es corregir lo que el cliente avisó: cambió el día, era
 * la otra camioneta, se equivocaron de patente. Se cambia todo salvo el id.
 */
export async function updateYardReservation(
  id: string,
  input: YardReservationInput
): Promise<void> {
  const { error } = await supabase
    .from('yard_reservations')
    .update({
      customer_id: input.customerId,
      license_plate: normalizarPatente(input.licensePlate),
      size_class: input.sizeClass || 'MEDIANO',
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      notes: input.notes.trim() || null,
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteYardReservation(id: string): Promise<void> {
  const { error } = await supabase.from('yard_reservations').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Si la reserva sigue reservando algo.
 *
 * Cuando el vehículo reservado YA está en el taller con una orden abierta, la
 * celda la ocupa la orden: seguir contando la reserva contaría dos veces el
 * mismo camión y la playa figuraría más llena de lo que está.
 *
 * Se compara por patente y no por vehicle_id porque la reserva puede haberse
 * cargado antes de que el vehículo existiera como ficha.
 */
export function reservaSigueVigente(
  reserva: YardReservation,
  ocupantes: Pick<YardOccupant, 'licensePlate'>[]
): boolean {
  const patente = normalizarPatente(reserva.licensePlate);
  if (!patente) return true;
  return !ocupantes.some((o) => normalizarPatente(o.licensePlate) === patente);
}

/** Si la reserva cubre ese día. Ambos extremos incluidos. */
export function reservaEnFecha(reserva: YardReservation, dia: string): boolean {
  return dia >= reserva.startsOn && dia <= reserva.endsOn;
}

/**
 * Las reservas que de verdad están tomando lugar hoy: dentro de su rango y sin
 * que el vehículo haya llegado todavía.
 */
export function reservasVigentes(
  reservas: YardReservation[],
  ocupantes: Pick<YardOccupant, 'licensePlate'>[],
  dia: string
): YardReservation[] {
  return reservas.filter((r) => reservaEnFecha(r, dia) && reservaSigueVigente(r, ocupantes));
}
