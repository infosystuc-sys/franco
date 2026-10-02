import { supabase } from '@/src/lib/supabase';
import {
  fiscalEntityToRow,
  mapFiscalEntity,
  type FiscalEntity,
  type FiscalEntityInput,
} from '@/src/lib/fiscal';
import type { SizeClass, VehicleKind } from '@/src/lib/vehicles';
import type { CondicionVenta } from '@/src/lib/invoices';

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
  /**
   * Vehículo o pieza. El alta de OT filtra por esto: una pieza elegida como
   * vehículo ocuparía celda en la playa sin estar ocupando nada.
   */
  kind: VehicleKind;
  brand: string | null;
  model: string;
  licensePlate: string | null;
  referenceNumber: string | null;
  year: number | null;
  sizeClass: SizeClass;
  active: boolean;
}

export interface Customer extends FiscalEntity {
  vehicles: CustomerVehicle[];
  /**
   * Condición de venta habitual. Se propone al facturar y se puede cambiar
   * ahí mismo. Null = sin definir: la factura obliga a elegirla, que es lo que
   * pasa hoy con todos los clientes ya cargados.
   */
  condicionVenta: CondicionVenta | null;
}

export interface CustomerInput extends FiscalEntityInput {
  /** Vacío = sin definir. */
  condicionVenta: CondicionVenta | '';
}

function mapCustomer(row: any): Customer {
  return {
    ...mapFiscalEntity(row),
    condicionVenta: (row.condicion_venta ?? null) as CondicionVenta | null,
    vehicles: (row.vehicles ?? []).map((v: any) => ({
      id: v.id,
      kind: v.kind ?? 'VEHICULO',
      brand: v.brand,
      model: v.model,
      licensePlate: v.license_plate,
      referenceNumber: v.reference_number ?? null,
      year: v.year,
      sizeClass: v.size_class,
      active: v.active,
    })),
  };
}

// El alta/baja de vehículos vive en src/lib/vehicles.ts, que maneja la ficha
// técnica completa. Acá solo se leen los vehículos asociados a cada cliente.
const SELECT_WITH_VEHICLES =
  '*, vehicles(id, kind, brand, model, license_plate, reference_number, year, active, size_class)';

/**
 * La base entrega como máximo 1000 filas por consulta: con más clientes que
 * eso, los demás no llegaban a ninguna pantalla (ni al listado ni a los
 * buscadores de facturación y cobranza). Se piden de a tandas hasta traerlos
 * todos. El id desempata el orden, para que una tanda no repita ni saltee a
 * dos clientes con el mismo nombre.
 */
const TANDA = 1000;

function tandaDeClientes(onlyActive: boolean, desde: number, hasta: number, conTotal: boolean) {
  let query = supabase
    .from('customers')
    .select(SELECT_WITH_VEHICLES, conTotal ? { count: 'exact' } : undefined)
    .order('name')
    .order('id')
    .range(desde, hasta);
  if (onlyActive) query = query.eq('active', true);
  return query;
}

export async function fetchCustomers(onlyActive = false): Promise<Customer[]> {
  // La primera tanda trae también el total (count: 'exact'); con eso se sabe
  // cuántas tandas más hacen falta y se piden todas juntas, en vez de una
  // después de la otra: con miles de clientes esa fila de viajes de ida y
  // vuelta es la diferencia entre instantáneo y varios segundos de espera.
  const primera = await tandaDeClientes(onlyActive, 0, TANDA - 1, true);
  if (primera.error) throw primera.error;

  const total = primera.count ?? (primera.data ?? []).length;
  const tandasQueFaltan = Math.max(0, Math.ceil(total / TANDA) - 1);

  const resto = await Promise.all(
    Array.from({ length: tandasQueFaltan }, (_, i) => {
      const desde = (i + 1) * TANDA;
      return tandaDeClientes(onlyActive, desde, desde + TANDA - 1, false);
    })
  );
  for (const r of resto) if (r.error) throw r.error;

  return [...(primera.data ?? []), ...resto.flatMap((r) => r.data ?? [])].map(mapCustomer);
}

/** La fila del padrón fiscal más lo que es propio del cliente. */
function aFilaDeCliente(input: CustomerInput): Record<string, unknown> {
  return {
    ...fiscalEntityToRow(input),
    condicion_venta: input.condicionVenta === '' ? null : input.condicionVenta,
  };
}

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  const { data, error } = await supabase
    .from('customers')
    .insert(aFilaDeCliente(input))
    .select(SELECT_WITH_VEHICLES)
    .single();
  if (error) throw error;
  return mapCustomer(data);
}

export async function updateCustomer(id: string, input: CustomerInput): Promise<Customer> {
  const { data, error } = await supabase
    .from('customers')
    .update(aFilaDeCliente(input))
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
