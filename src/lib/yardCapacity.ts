import { supabase } from '@/src/lib/supabase';
import { MEDIANOS_POR_CELDA, type SizeClass } from '@/src/lib/vehicles';

/**
 * Cuánto lugar hay en la playa y cuánto queda.
 *
 * La playa se mide en CELDAS: en cada una entra un vehículo grande o hasta
 * tres medianos. Reemplaza a los tres cupos por tamaño, que modelaban un
 * taller con tres playas separadas —una por tamaño— cuando en realidad hay una
 * sola y lo que entra depende de cómo se combinan los vehículos.
 *
 * La ocupación no se guarda en ninguna tabla: se calcula cada vez leyendo lo
 * que está físicamente en el taller.
 */

/** Cuántas celdas tiene el taller. Sin la clave cargada, cero. */
export async function fetchYardCells(): Promise<number> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'yard_cells')
    .maybeSingle();
  if (error) throw error;
  return Math.max(0, Math.trunc(Number(data?.value) || 0));
}

/**
 * upsert, no update: si faltara la clave, un update no la crea, afecta 0 filas
 * y no tira error — la pantalla mostraría el número tipeado como si hubiera
 * guardado y en realidad no pasó nada.
 */
export async function updateYardCells(cells: number): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'yard_cells', value: String(Math.max(0, Math.trunc(cells))) }, { onConflict: 'key' });
  if (error) throw error;
}

export interface YardOccupant {
  kind: 'OT';
  id: string;
  number: string;
  /** Con qué vehículo físico se corresponde: es la clave para no contarlo dos veces. */
  vehicleId: string;
  customerName: string;
  vehicleLabel: string;
  /** Cruda, para cruzarla con la patente escrita a mano en una reserva. */
  licensePlate: string | null;
  sizeClass: SizeClass;
  statusLabel: string;
  statusColor: string;
  /** Sin esta fecha la orden ocupa lugar, pero queda afuera de la proyección. */
  estimatedDeliveryDate: string | null;
  daysInShop: number;
  createdAt: string;
  /**
   * Cuántos otros registros del mismo vehículo perdieron el desempate (ver
   * ganaAlOtro). La tabla deduplica por vehículo, así que una orden que no se
   * ve acá no desapareció: quedó representada por este registro.
   */
  otrosRegistros: number;
}

function labelDeVehiculo(vehicle: { brand: string | null; model: string; license_plate: string | null } | null): string {
  if (!vehicle) return '—';
  const nombre = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
  return vehicle.license_plate ? `${nombre} — ${vehicle.license_plate}` : nombre || '—';
}

function diasEnTaller(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000));
}

/**
 * El tamaño no se adivina. La columna es NOT NULL, así que si el vehículo no
 * vino es porque RLS lo ocultó a quien preguntó — y entonces esta cuenta no
 * puede ser correcta. Mejor un error visible que una playa que miente.
 */
function tamanoDe(vehicle: { size_class: string } | null, numero: string): SizeClass {
  if (!vehicle?.size_class) {
    throw new Error(`No se pudo leer el tamaño del vehículo de ${numero}. Puede ser un problema de permisos.`);
  }
  return vehicle.size_class as SizeClass;
}

/**
 * Ocupan lugar las OT cuyo estado no libera la playa y que recibieron un
 * vehículo: una pieza sobre el mostrador no ocupa un lugar de estacionamiento,
 * aunque se haya elegido de qué equipo salió.
 *
 * Ya no hay que mirar los ingresos ni resolver el vínculo por cotización: la
 * recepción es la propia orden, así que un vehículo recibido es una OT y nada
 * más.
 */
export async function fetchYardOccupancy(): Promise<YardOccupant[]> {
  const { data, error } = await supabase
    .from('work_orders')
    .select(
      `id, number, created_at, estimated_delivery_date, vehicle_id,
       status:work_order_statuses(label, color, frees_yard),
       customer:customers(name),
       vehicle:vehicles(brand, model, license_plate, size_class)`
    )
    .eq('reception_kind', 'VEHICULO')
    .not('vehicle_id', 'is', null)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const ocupantes: YardOccupant[] = (data ?? [])
    .filter((row: any) => !row.status?.frees_yard)
    .map((row: any) => ({
      kind: 'OT' as const,
      id: row.id,
      number: row.number,
      vehicleId: row.vehicle_id,
      customerName: row.customer?.name ?? '—',
      vehicleLabel: labelDeVehiculo(row.vehicle),
      licensePlate: row.vehicle?.license_plate ?? null,
      sizeClass: tamanoDe(row.vehicle, row.number),
      statusLabel: row.status?.label ?? '—',
      statusColor: row.status?.color ?? '#6b7280',
      estimatedDeliveryDate: row.estimated_delivery_date,
      daysInShop: diasEnTaller(row.created_at),
      createdAt: row.created_at,
      otrosRegistros: 0,
    }));

  // Un vehículo ocupa UN lugar aunque tenga dos órdenes abiertas a la vez.
  // Gana la más reciente, que es la que refleja en qué anda el taller ahora;
  // la que pierde no se descarta en silencio, suma a otrosRegistros para que
  // la pantalla pueda avisar que hay más órdenes del mismo vehículo.
  const porVehiculo = new Map<string, YardOccupant>();
  for (const candidato of ocupantes) {
    const actual = porVehiculo.get(candidato.vehicleId);
    if (!actual) {
      porVehiculo.set(candidato.vehicleId, candidato);
    } else if (candidato.createdAt > actual.createdAt) {
      porVehiculo.set(candidato.vehicleId, { ...candidato, otrosRegistros: actual.otrosRegistros + 1 });
    } else {
      actual.otrosRegistros += 1;
    }
  }
  return [...porVehiculo.values()];
}

/**
 * Celdas que ocupa un conjunto de vehículos.
 *
 * Un grande toma la celda entera; los medianos se amontonan de a tres, así que
 * cuatro medianos ya ocupan dos celdas aunque la segunda tenga lugar de sobra.
 */
export function celdasOcupadas(occupants: Pick<YardOccupant, 'sizeClass'>[]): number {
  let grandes = 0;
  let medianos = 0;
  for (const o of occupants) {
    if (o.sizeClass === 'GRANDE') grandes += 1;
    else medianos += 1;
  }
  return grandes + Math.ceil(medianos / MEDIANOS_POR_CELDA);
}

/**
 * El "hoy" (fecha local, sin hora) que decide qué fecha estimada ya venció. Se
 * exporta para que la pantalla no pueda usar un "hoy" distinto al de la
 * proyección: los dos tienen que estar de acuerdo en qué es pasado.
 */
export function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Si la orden todavía ocupa su celda el día indicado.
 *
 * Ocupa hasta su fecha estimada INCLUSIVE: el trabajo termina ese día y recién
 * después la celda queda disponible. Es el criterio pesimista, coherente con el
 * resto — se prefiere mostrar la celda ocupada un día de más que prometerla un
 * día antes de tiempo.
 *
 * Sin fecha, o con la fecha ya vencida y la orden todavía sin retirar, ocupa
 * toda la ventana: la celda está tomada de hecho y no hay con qué predecir
 * cuándo se libera.
 */
export function ocupaEnFecha(
  occupant: Pick<YardOccupant, 'estimatedDeliveryDate'>,
  dia: string,
  hoy: string
): boolean {
  const fecha = occupant.estimatedDeliveryDate;
  if (!fecha || fecha < hoy) return true;
  return dia <= fecha;
}

export interface YardAvailability {
  /**
   * Celdas enteras sin tocar. Puede ser negativo: hay más vehículos que
   * celdas. La pantalla lo marca.
   */
  freeCells: number;
  /** Cuántos vehículos grandes más entran: cada uno necesita una celda entera. */
  grandes: number;
  /**
   * Cuántos medianos más entran: los de las celdas libres, MÁS el lugar que
   * sobra en la celda a medio llenar. Una celda con dos medianos todavía
   * admite un tercero, y esconderlo hacía rechazar vehículos que entraban.
   */
  medianos: number;
}

/**
 * Cuánto lugar queda, expresado en vehículos y no solo en celdas.
 *
 * "Celdas libres" por sí solo miente cuando hay una celda a medio llenar: con
 * cero celdas libres y una celda con dos medianos, todavía entra un mediano.
 * Por eso se publican las dos cosas.
 */
export function disponibilidad(
  cells: number,
  occupants: Pick<YardOccupant, 'sizeClass'>[]
): YardAvailability {
  const medianos = occupants.filter((o) => o.sizeClass === 'MEDIANO').length;
  const libres = cells - celdasOcupadas(occupants);

  // Lo que sobra en la última celda de medianos. Cero cuando el reparto da
  // justo, o cuando no hay ningún mediano.
  const huecoParcial = (MEDIANOS_POR_CELDA - (medianos % MEDIANOS_POR_CELDA)) % MEDIANOS_POR_CELDA;

  // Con la playa desbordada no entra nada más: el faltante se comunica por
  // freeCells en negativo, no diciendo que entran "menos tres" vehículos.
  return {
    freeCells: libres,
    grandes: Math.max(0, libres),
    medianos: Math.max(0, libres * MEDIANOS_POR_CELDA + huecoParcial),
  };
}

export interface YardDayAvailability extends YardAvailability {
  date: string;
  /** Cuántas de las celdas tomadas ese día lo están por una reserva. */
  reservedCells: number;
}

/**
 * Lo mínimo que la proyección necesita saber de una reserva. Se pide así, y no
 * el tipo entero, para que el cálculo no dependa del módulo de reservas: es al
 * revés, las reservas se apoyan en este.
 */
export interface YardReservationSlot {
  sizeClass: SizeClass;
  startsOn: string;
  endsOn: string;
  licensePlate: string;
}

/**
 * Cuántas celdas quedarían libres cada día, suponiendo que cada orden se retire
 * en su fecha estimada.
 *
 * Cada día se calcula ENTERO, no por diferencia con el anterior. El techo no es
 * aditivo: con 4 medianos ocupando 2 celdas, que se vaya uno solo libera una
 * celda entera (quedan 3, que entran en 1). Ir restando "un tercio de celda por
 * mediano que sale" da resultados equivocados.
 */
export function proyectarDisponibilidad(
  cells: number,
  occupants: YardOccupant[],
  dias = 14,
  hoy: string = hoyISO(),
  reservations: YardReservationSlot[] = []
): YardDayAvailability[] {
  const resultado: YardDayAvailability[] = [];
  const base = new Date(`${hoy}T00:00:00`);

  // Una patente que ya está en el taller no se cuenta dos veces: la celda la
  // ocupa la orden, no la reserva que la anticipaba.
  const patentesPresentes = new Set(
    occupants.map((o) => (o.licensePlate ?? '').replace(/[\s-]/g, '').toUpperCase()).filter(Boolean)
  );

  for (let i = 0; i < dias; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const date = d.toISOString().slice(0, 10);

    const eseDia = occupants.filter((o) => ocupaEnFecha(o, date, hoy));
    const reservasDelDia = reservations.filter(
      (r) =>
        date >= r.startsOn &&
        date <= r.endsOn &&
        !patentesPresentes.has(r.licensePlate.replace(/[\s-]/g, '').toUpperCase())
    );

    // Se cuentan juntos a propósito: una celda admite tres medianos sin
    // importar si están presentes o reservados. Separarlos daría más celdas
    // ocupadas de las que el taller usa en realidad.
    const total = disponibilidad(cells, [...eseDia, ...reservasDelDia]);
    const soloOcupadas = celdasOcupadas(eseDia);

    resultado.push({
      date,
      ...total,
      reservedCells: cells - total.freeCells - soloOcupadas,
    });
  }
  return resultado;
}

/** Órdenes que nunca tuvieron fecha estimada: ocupan toda la ventana. */
export function sinFechaEstimada(occupants: YardOccupant[]): YardOccupant[] {
  return occupants.filter((o) => !o.estimatedDeliveryDate);
}

/**
 * Órdenes cuya fecha estimada ya pasó y siguen sin marcarse Retirado. La celda
 * está ocupada de hecho, así que ocupan toda la ventana igual que las que no
 * tienen fecha.
 */
export function vencidas(occupants: YardOccupant[], hoy: string = hoyISO()): YardOccupant[] {
  return occupants.filter((o) => !!o.estimatedDeliveryDate && o.estimatedDeliveryDate < hoy);
}
