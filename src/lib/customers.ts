import { supabase } from '@/src/lib/supabase';
import {
  fiscalEntityToRow,
  mapFiscalEntity,
  type FiscalEntity,
  type FiscalEntityInput,
} from '@/src/lib/fiscal';

// Los datos fiscales (CUIT, condición de IVA, domicilio) viven en fiscal.ts
// porque los comparte con el padrón de proveedores. Se reexportan acá para
// que los consumidores del módulo de clientes no tengan que saberlo.
export {
  formatCuit,
  isValidCuit,
  TAX_CONDITION_LABELS,
  TAX_CONDITIONS,
  type TaxCondition,
} from '@/src/lib/fiscal';

export interface CustomerVehicle {
  id: string;
  brand: string | null;
  model: string;
  licensePlate: string | null;
  year: number | null;
  active: boolean;
}

export interface Customer extends FiscalEntity {
  vehicles: CustomerVehicle[];
}

export type CustomerInput = FiscalEntityInput;

function mapCustomer(row: any): Customer {
  return {
    ...mapFiscalEntity(row),
    vehicles: (row.vehicles ?? []).map((v: any) => ({
      id: v.id,
      brand: v.brand,
      model: v.model,
      licensePlate: v.license_plate,
      year: v.year,
      active: v.active,
    })),
  };
}

// El alta/baja de vehículos vive en src/lib/vehicles.ts, que maneja la ficha
// técnica completa. Acá solo se leen los vehículos asociados a cada cliente.
const SELECT_WITH_VEHICLES = '*, vehicles(id, brand, model, license_plate, year, active)';

export async function fetchCustomers(onlyActive = false): Promise<Customer[]> {
  let query = supabase.from('customers').select(SELECT_WITH_VEHICLES).order('name');
  if (onlyActive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapCustomer);
}

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  const { data, error } = await supabase
    .from('customers')
    .insert(fiscalEntityToRow(input))
    .select(SELECT_WITH_VEHICLES)
    .single();
  if (error) throw error;
  return mapCustomer(data);
}

export async function updateCustomer(id: string, input: CustomerInput): Promise<Customer> {
  const { data, error } = await supabase
    .from('customers')
    .update(fiscalEntityToRow(input))
    .eq('id', id)
    .select(SELECT_WITH_VEHICLES)
    .single();
  if (error) throw error;
  return mapCustomer(data);
}

export async function deleteCustomer(id: string): Promise<void> {
  const { error } = await supabase.from('customers').delete().eq('id', id);
  if (error) throw error;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeCustomerError(message: string, customerName: string): string {
  if (message.includes('customers_tax_id_key') || message.includes('duplicate key')) {
    return 'Ya existe otro cliente con ese CUIT/CUIL.';
  }
  if (message.includes('foreign key') || message.includes('violates')) {
    return `No se puede eliminar "${customerName}" porque tiene órdenes de trabajo asociadas. Desactivalo en su lugar (editar → destildar "Activo").`;
  }
  return message;
}
