import { supabase } from '@/src/lib/supabase';

export type VehicleType =
  | 'CAMION'
  | 'MAQUINARIA'
  | 'GENERADOR'
  | 'EMBARCACION'
  | 'AGRICOLA'
  | 'OTRO';

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  CAMION: 'Camión / Utilitario',
  MAQUINARIA: 'Maquinaria vial',
  AGRICOLA: 'Maquinaria agrícola',
  GENERADOR: 'Grupo electrógeno',
  EMBARCACION: 'Embarcación',
  OTRO: 'Otro',
};

export const VEHICLE_TYPES = Object.keys(VEHICLE_TYPE_LABELS) as VehicleType[];

export type SizeClass = 'CHICO' | 'MEDIANO' | 'GRANDE';

export const SIZE_CLASS_LABELS: Record<SizeClass, string> = {
  CHICO: 'Chico',
  MEDIANO: 'Mediano',
  GRANDE: 'Grande',
};

export const SIZE_CLASSES = Object.keys(SIZE_CLASS_LABELS) as SizeClass[];

/**
 * Tamaño que se propone al elegir el tipo. Es solo el punto de partida: el
 * tipo no dice cuánto lugar ocupa el vehículo — "Camión / Utilitario" mete en
 * la misma bolsa una Transit y un Scania — así que el campo queda editable.
 */
export const SIZE_BY_VEHICLE_TYPE: Record<VehicleType, SizeClass> = {
  CAMION: 'GRANDE',
  MAQUINARIA: 'GRANDE',
  AGRICOLA: 'GRANDE',
  EMBARCACION: 'MEDIANO',
  GENERADOR: 'CHICO',
  OTRO: 'MEDIANO',
};

export type OdometerUnit = 'KM' | 'HORAS';

export const ODOMETER_UNIT_LABELS: Record<OdometerUnit, string> = {
  KM: 'Kilómetros',
  HORAS: 'Horas de uso',
};

/** Sistemas de inyección más comunes; el campo admite texto libre igual. */
export const INJECTION_SYSTEMS = [
  'Bosch Common Rail',
  'Bosch VP44',
  'Bosch VE',
  'Bosch PLD',
  'Delphi',
  'Denso',
  'Siemens VDO',
  'Caterpillar HEUI',
  'Cummins',
  'Stanadyne',
];

export interface Vehicle {
  id: string;
  customerId: string;
  customerName: string;
  brand: string | null;
  model: string;
  vehicleType: VehicleType;
  sizeClass: SizeClass;
  licensePlate: string | null;
  year: number | null;
  vin: string | null;
  engineBrand: string | null;
  engineModel: string | null;
  engineNumber: string | null;
  injectionSystem: string | null;
  odometer: number | null;
  odometerUnit: OdometerUnit;
  notes: string | null;
  active: boolean;
}

export interface VehicleInput {
  customerId: string;
  brand: string;
  model: string;
  vehicleType: VehicleType;
  sizeClass: SizeClass;
  licensePlate: string;
  year: string;
  vin: string;
  engineBrand: string;
  engineModel: string;
  engineNumber: string;
  injectionSystem: string;
  odometer: string;
  odometerUnit: OdometerUnit;
  notes: string;
  active: boolean;
}

export const EMPTY_VEHICLE_FORM: VehicleInput = {
  customerId: '',
  brand: '',
  model: '',
  vehicleType: 'CAMION',
  sizeClass: 'GRANDE',
  licensePlate: '',
  year: '',
  vin: '',
  engineBrand: '',
  engineModel: '',
  engineNumber: '',
  injectionSystem: '',
  odometer: '',
  odometerUnit: 'KM',
  notes: '',
  active: true,
};

/** Etiqueta legible del vehículo: "Volvo FH16 — ABC-123". */
export function vehicleLabel(vehicle: Pick<Vehicle, 'brand' | 'model' | 'licensePlate'>): string {
  const name = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
  return vehicle.licensePlate ? `${name} — ${vehicle.licensePlate}` : name;
}

function mapVehicle(row: any): Vehicle {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer?.name ?? '—',
    brand: row.brand,
    model: row.model,
    vehicleType: row.vehicle_type,
    sizeClass: row.size_class,
    licensePlate: row.license_plate,
    year: row.year,
    vin: row.vin,
    engineBrand: row.engine_brand,
    engineModel: row.engine_model,
    engineNumber: row.engine_number,
    injectionSystem: row.injection_system,
    odometer: row.odometer === null ? null : Number(row.odometer),
    odometerUnit: row.odometer_unit,
    notes: row.notes,
    active: row.active,
  };
}

function nullIfBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRow(input: VehicleInput) {
  return {
    customer_id: input.customerId,
    brand: nullIfBlank(input.brand),
    model: input.model.trim(),
    vehicle_type: input.vehicleType,
    size_class: input.sizeClass,
    // Patente y VIN se normalizan en mayúsculas: los índices únicos comparan así.
    license_plate: nullIfBlank(input.licensePlate)?.toUpperCase() ?? null,
    year: numberOrNull(input.year),
    vin: nullIfBlank(input.vin)?.toUpperCase() ?? null,
    engine_brand: nullIfBlank(input.engineBrand),
    engine_model: nullIfBlank(input.engineModel),
    engine_number: nullIfBlank(input.engineNumber),
    injection_system: nullIfBlank(input.injectionSystem),
    odometer: numberOrNull(input.odometer),
    odometer_unit: input.odometerUnit,
    notes: nullIfBlank(input.notes),
    active: input.active,
  };
}

export function vehicleToForm(vehicle: Vehicle): VehicleInput {
  return {
    customerId: vehicle.customerId,
    brand: vehicle.brand ?? '',
    model: vehicle.model,
    vehicleType: vehicle.vehicleType,
    sizeClass: vehicle.sizeClass,
    licensePlate: vehicle.licensePlate ?? '',
    year: vehicle.year === null ? '' : String(vehicle.year),
    vin: vehicle.vin ?? '',
    engineBrand: vehicle.engineBrand ?? '',
    engineModel: vehicle.engineModel ?? '',
    engineNumber: vehicle.engineNumber ?? '',
    injectionSystem: vehicle.injectionSystem ?? '',
    odometer: vehicle.odometer === null ? '' : String(vehicle.odometer),
    odometerUnit: vehicle.odometerUnit,
    notes: vehicle.notes ?? '',
    active: vehicle.active,
  };
}

const SELECT_WITH_CUSTOMER = '*, customer:customers(name)';

export async function fetchVehicles(): Promise<Vehicle[]> {
  const { data, error } = await supabase
    .from('vehicles')
    .select(SELECT_WITH_CUSTOMER)
    .order('model');
  if (error) throw error;
  return (data ?? []).map(mapVehicle);
}

export async function createVehicle(input: VehicleInput): Promise<Vehicle> {
  const { data, error } = await supabase
    .from('vehicles')
    .insert(toRow(input))
    .select(SELECT_WITH_CUSTOMER)
    .single();
  if (error) throw error;
  return mapVehicle(data);
}

export async function updateVehicle(id: string, input: VehicleInput): Promise<Vehicle> {
  const { data, error } = await supabase
    .from('vehicles')
    .update(toRow(input))
    .eq('id', id)
    .select(SELECT_WITH_CUSTOMER)
    .single();
  if (error) throw error;
  return mapVehicle(data);
}

export async function deleteVehicle(id: string): Promise<void> {
  const { error } = await supabase.from('vehicles').delete().eq('id', id);
  if (error) throw error;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeVehicleError(message: string): string {
  if (message.includes('vehicles_license_plate_key')) {
    return 'Ya existe otro vehículo con esa patente.';
  }
  if (message.includes('vehicles_vin_key')) {
    return 'Ya existe otro vehículo con ese N° de chasis (VIN).';
  }
  if (message.includes('foreign key') || message.includes('violates foreign key')) {
    return 'No se puede eliminar: el vehículo tiene órdenes de trabajo asociadas. Desactivalo en su lugar.';
  }
  return message;
}
