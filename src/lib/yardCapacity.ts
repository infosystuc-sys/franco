import { supabase } from '@/src/lib/supabase';
import { SIZE_CLASSES, type SizeClass } from '@/src/lib/vehicles';

/**
 * Cuánto lugar hay en la playa y cuánto queda.
 *
 * La ocupación no se guarda en ninguna tabla: se calcula cada vez leyendo lo
 * que está físicamente en el taller. Reemplaza al cálculo por sector del
 * empleado (shopCapacity.ts), que dejaba afuera las OT sin empleado asignado
 * y "movía" vehículos de lugar cuando se reasignaba un mecánico.
 */

export interface YardCapacityRow {
  sizeClass: SizeClass;
  capacity: number;
}

/**
 * Siempre devuelve los tres tamaños, en orden. Un tamaño sin fila se completa
 * con cupo 0 —que es lo mismo que dice la fila sembrada— en vez de romper la
 * vista.
 */
export async function fetchYardCapacities(): Promise<YardCapacityRow[]> {
  const { data, error } = await supabase.from('yard_capacity').select('size_class, capacity');
  if (error) throw error;

  const bySize = new Map((data ?? []).map((r: any) => [r.size_class as SizeClass, Number(r.capacity)]));
  return SIZE_CLASSES.map((sizeClass) => ({ sizeClass, capacity: bySize.get(sizeClass) ?? 0 }));
}

/**
 * upsert, no update: si falta la fila del tamaño (base sin sembrar del todo),
 * un update no la crea, afecta 0 filas y no tira error — la pantalla muestra
 * el número tipeado como si hubiera guardado y en realidad no pasó nada.
 * fetchYardCapacities ya está preparada para filas faltantes; esta función
 * tiene que dejar de asumir que siempre existen.
 */
export async function updateYardCapacity(sizeClass: SizeClass, capacity: number): Promise<void> {
  const { error } = await supabase
    .from('yard_capacity')
    .upsert({ size_class: sizeClass, capacity }, { onConflict: 'size_class' });
  if (error) throw error;
}

export interface YardOccupant {
  kind: 'INGRESO' | 'OT';
  id: string;
  number: string;
  /** Con qué vehículo físico se corresponde: es la clave para no contarlo dos veces. */
  vehicleId: string;
  customerName: string;
  vehicleLabel: string;
  sizeClass: SizeClass;
  statusLabel: string;
  statusColor: string;
  /** Solo las OT la tienen; un ingreso sin OT no tiene fecha de salida. */
  estimatedDeliveryDate: string | null;
  daysInShop: number;
  createdAt: string;
  /**
   * Cuántos otros registros del mismo vehículo perdieron el desempate (ver
   * ganaAlOtro). La tabla deduplica por vehículo, así que un ingreso que no
   * se ve acá no desapareció: quedó representado por este registro.
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


export interface YardSizeSummary {
  sizeClass: SizeClass;
  capacity: number;
  occupied: number;
  /** Puede ser negativo: hay más vehículos que cupo. La pantalla lo marca. */
  free: number;
}

export function summarizeYard(
  capacities: YardCapacityRow[],
  occupants: YardOccupant[]
): YardSizeSummary[] {
  return capacities.map(({ sizeClass, capacity }) => {
    const occupied = occupants.filter((o) => o.sizeClass === sizeClass).length;
    return { sizeClass, capacity, occupied, free: capacity - occupied };
  });
}

/**
 * Cuándo se espera que el vehículo libere el lugar: la fecha estimada de
 * finalización más el margen de retiro. Sin fecha estimada no se inventa una.
 */
export function expectedFreeDate(estimatedDeliveryDate: string | null, graceDays: number): string | null {
  if (!estimatedDeliveryDate) return null;
  const fecha = new Date(`${estimatedDeliveryDate}T00:00:00`);
  if (Number.isNaN(fecha.getTime())) return null;
  fecha.setDate(fecha.getDate() + graceDays);
  return fecha.toISOString().slice(0, 10);
}

/**
 * El "hoy" (fecha local, sin hora) que decide qué liberación ya venció. Se
 * exporta para que la pantalla no pueda usar un "hoy" distinto al de
 * projectReleases al armar el contador de "sin fecha a futuro": los dos
 * tienen que estar de acuerdo en qué es pasado.
 */
export function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Si el vehículo tiene una fecha de liberación esperada que todavía está por
 * venir. Sin fecha estimada, o con la fecha ya vencida, no la tiene — y en
 * los dos casos el vehículo ocupa lugar igual, solo que projectReleases no
 * puede proyectar nada para él.
 */
export function tieneFechaFutura(
  occupant: Pick<YardOccupant, 'estimatedDeliveryDate'>,
  graceDays: number,
  hoy: string = hoyISO()
): boolean {
  const fecha = expectedFreeDate(occupant.estimatedDeliveryDate, graceDays);
  return fecha !== null && fecha >= hoy;
}

export interface YardReleaseDay {
  date: string;
  bySize: Partial<Record<SizeClass, number>>;
}

/**
 * Cuántos lugares se liberarían cada día si todo saliera según lo estimado.
 * Es una proyección, no una promesa: una fecha estimada que se corre arrastra
 * todo lo que viene atrás.
 *
 * maxDays es una ventana de días calendario, no una cantidad de filas: se
 * descarta toda fecha posterior a hoy + maxDays. Antes hacía slice(0,
 * maxDays) sobre las fechas con liberaciones, así que una entrega estimada
 * para dentro de varios meses podía colarse bajo "próximas salidas" con solo
 * que hubiera pocas fechas distintas cargadas.
 */
export function projectReleases(
  occupants: YardOccupant[],
  graceDays: number,
  maxDays = 14
): YardReleaseDay[] {
  const hoy = hoyISO();
  const limite = new Date(`${hoy}T00:00:00`);
  limite.setDate(limite.getDate() + maxDays);
  const fechaLimite = limite.toISOString().slice(0, 10);

  const porFecha = new Map<string, Partial<Record<SizeClass, number>>>();

  for (const occupant of occupants) {
    const fecha = expectedFreeDate(occupant.estimatedDeliveryDate, graceDays);
    if (!fecha || fecha < hoy || fecha > fechaLimite) continue;
    const delDia = porFecha.get(fecha) ?? {};
    delDia[occupant.sizeClass] = (delDia[occupant.sizeClass] ?? 0) + 1;
    porFecha.set(fecha, delDia);
  }

  return [...porFecha.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bySize]) => ({ date, bySize }));
}
