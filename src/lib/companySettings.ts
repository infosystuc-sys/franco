import { supabase } from '@/src/lib/supabase';
import { nullIfBlank, type TaxCondition } from '@/src/lib/fiscal';

/**
 * Datos fiscales del taller: el emisor de las facturas.
 *
 * Vive en su propia tabla de una sola fila (company_settings). No reutiliza
 * FiscalEntity como clientes y proveedores porque el emisor tiene datos que
 * un tercero no tiene —punto de venta, ingresos brutos, inicio de
 * actividades— y no tiene los que sí definen a un tercero, como "activo".
 */
export interface CompanySettings {
  legalName: string;
  tradeName: string | null;
  taxId: string | null;
  taxCondition: TaxCondition;
  /** Punto de venta habilitado. Con ARCA tiene que ser uno dado de alta en AFIP. */
  salesPoint: number;
  grossIncome: string | null;
  activityStartDate: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  phone: string | null;
  email: string | null;
  /** Días después de la entrega estimada en que se asume que el vehículo se retira. */
  yardPickupGraceDays: number;
}

export interface CompanySettingsInput {
  legalName: string;
  tradeName: string;
  taxId: string;
  taxCondition: TaxCondition;
  salesPoint: string;
  grossIncome: string;
  activityStartDate: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  phone: string;
  email: string;
  yardPickupGraceDays: string;
}

const SELECT =
  'legal_name, trade_name, tax_id, tax_condition, sales_point, gross_income, ' +
  'activity_start_date, address_street, address_city, address_state, address_zip, phone, email, ' +
  'yard_pickup_grace_days';

function mapCompanySettings(row: any): CompanySettings {
  return {
    legalName: row.legal_name ?? '',
    tradeName: row.trade_name,
    taxId: row.tax_id,
    taxCondition: row.tax_condition,
    salesPoint: Number(row.sales_point),
    grossIncome: row.gross_income,
    activityStartDate: row.activity_start_date,
    addressStreet: row.address_street,
    addressCity: row.address_city,
    addressState: row.address_state,
    addressZip: row.address_zip,
    phone: row.phone,
    email: row.email,
    yardPickupGraceDays: Number(row.yard_pickup_grace_days ?? 2),
  };
}

/**
 * La fila puede no existir todavía (base sin migrar) y la lectura está
 * restringida a admin. En ambos casos devuelve null, y quien llama decide
 * qué hacer: la pantalla de facturación avisa que faltan cargar los datos.
 */
export async function fetchCompanySettings(): Promise<CompanySettings | null> {
  const { data, error } = await supabase.from('company_settings').select(SELECT).maybeSingle();
  if (error) throw error;
  return data ? mapCompanySettings(data) : null;
}

export async function updateCompanySettings(
  input: CompanySettingsInput
): Promise<CompanySettings> {
  const { data, error } = await supabase
    .from('company_settings')
    .update({
      legal_name: input.legalName.trim(),
      trade_name: nullIfBlank(input.tradeName),
      tax_id: input.taxId.replace(/\D/g, '') || null,
      tax_condition: input.taxCondition,
      sales_point: Number(input.salesPoint) || 1,
      gross_income: nullIfBlank(input.grossIncome),
      activity_start_date: nullIfBlank(input.activityStartDate),
      address_street: nullIfBlank(input.addressStreet),
      address_city: nullIfBlank(input.addressCity),
      address_state: nullIfBlank(input.addressState),
      address_zip: nullIfBlank(input.addressZip),
      phone: nullIfBlank(input.phone),
      email: nullIfBlank(input.email),
      // Un margen vacío o inválido cae en 2, el default de la columna: dejarlo
      // en 0 diría que todos retiran el mismo día que termina el trabajo.
      yard_pickup_grace_days: Math.max(0, Number(input.yardPickupGraceDays) || 2),
    })
    .eq('id', true)
    .select(SELECT)
    .single();

  if (error) throw error;
  return mapCompanySettings(data);
}

export function companySettingsToForm(settings: CompanySettings): CompanySettingsInput {
  return {
    legalName: settings.legalName,
    tradeName: settings.tradeName ?? '',
    taxId: settings.taxId ?? '',
    taxCondition: settings.taxCondition,
    salesPoint: String(settings.salesPoint),
    grossIncome: settings.grossIncome ?? '',
    activityStartDate: settings.activityStartDate ?? '',
    addressStreet: settings.addressStreet ?? '',
    addressCity: settings.addressCity ?? '',
    addressState: settings.addressState ?? '',
    addressZip: settings.addressZip ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    yardPickupGraceDays: String(settings.yardPickupGraceDays),
  };
}

/** Domicilio en una línea, como sale impreso en la cabecera del comprobante. */
export function formatAddress(
  parts: {
    addressStreet: string | null;
    addressCity: string | null;
    addressState: string | null;
    addressZip: string | null;
  }
): string {
  const location = [parts.addressZip, parts.addressCity].filter(Boolean).join(' ');
  return [parts.addressStreet, location, parts.addressState].filter(Boolean).join(', ');
}

/**
 * Sin razón social no se puede emitir: es el dato que encabeza el
 * comprobante. El resto se puede completar después.
 */
export function isReadyToInvoice(settings: CompanySettings | null): boolean {
  return !!settings && settings.legalName.trim() !== '';
}
