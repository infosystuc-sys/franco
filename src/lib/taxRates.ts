import { supabase } from '@/src/lib/supabase';
import { nullIfBlank } from '@/src/lib/fiscal';

/**
 * Padrón de alícuotas: IVA, percepciones, impuestos internos y retenciones.
 *
 * Percepción y retención no son lo mismo ni caen en el mismo módulo. La
 * PERCEPCIÓN la cobra el proveedor y viene impresa en su factura: va al pie
 * del comprobante de compra y suma al total y a la deuda. La RETENCIÓN la
 * practica el taller al pagar, resta de lo que se transfiere y genera un
 * certificado. Las dos se definen acá; las retenciones las usa el módulo de
 * pagos, no el de compras.
 */

export type TaxKind = 'IVA' | 'PERCEPCION' | 'IMPUESTO_INTERNO' | 'RETENCION';
export type TaxBase = 'NETO' | 'TOTAL';
export type VatTreatment = 'GRAVADO' | 'EXENTO' | 'NO_GRAVADO';

export const TAX_KIND_LABELS: Record<TaxKind, string> = {
  IVA: 'IVA',
  PERCEPCION: 'Percepción',
  IMPUESTO_INTERNO: 'Impuesto interno',
  RETENCION: 'Retención',
};

/** Dónde actúa cada tipo. Se muestra en el ABM para que no haya que saberlo de memoria. */
export const TAX_KIND_HELP: Record<TaxKind, string> = {
  IVA: 'Se elige por renglón del comprobante.',
  PERCEPCION: 'La cobra el proveedor en su factura. Va al pie y suma al total.',
  IMPUESTO_INTERNO: 'Va al pie del comprobante y suma al total.',
  RETENCION: 'La practica el taller al pagar. La usa el módulo de pagos, no el de compras.',
};

export const TAX_KINDS = Object.keys(TAX_KIND_LABELS) as TaxKind[];

export const TAX_BASE_LABELS: Record<TaxBase, string> = {
  NETO: 'Neto',
  TOTAL: 'Total con IVA',
};

export const VAT_TREATMENT_LABELS: Record<VatTreatment, string> = {
  GRAVADO: 'Gravado',
  EXENTO: 'Exento',
  NO_GRAVADO: 'No gravado',
};

export const VAT_TREATMENTS = Object.keys(VAT_TREATMENT_LABELS) as VatTreatment[];

export interface TaxRate {
  id: string;
  kind: TaxKind;
  name: string;
  rate: number;
  base: TaxBase;
  jurisdiction: string | null;
  vatTreatment: VatTreatment | null;
  active: boolean;
}

export interface TaxRateInput {
  kind: TaxKind;
  name: string;
  rate: string;
  base: TaxBase;
  jurisdiction: string;
  vatTreatment: VatTreatment;
  active: boolean;
}

export const EMPTY_TAX_RATE_FORM: TaxRateInput = {
  kind: 'PERCEPCION',
  name: '',
  rate: '',
  base: 'NETO',
  jurisdiction: '',
  vatTreatment: 'GRAVADO',
  active: true,
};

function mapTaxRate(row: any): TaxRate {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    rate: Number(row.rate),
    base: row.base,
    jurisdiction: row.jurisdiction,
    vatTreatment: row.vat_treatment,
    active: row.active,
  };
}

/**
 * La base y el tratamiento no son libres: el IVA siempre se aplica sobre el
 * neto del renglón y siempre declara tratamiento; los demás impuestos no
 * tienen tratamiento que declarar. La base lo rechaza con un check, así que
 * conviene mandar lo correcto y no un error de constraint.
 */
function toRow(input: TaxRateInput) {
  const isVat = input.kind === 'IVA';
  return {
    kind: input.kind,
    name: input.name.trim(),
    rate: Number(input.rate) || 0,
    base: isVat ? 'NETO' : input.base,
    jurisdiction: nullIfBlank(input.jurisdiction),
    vat_treatment: isVat ? input.vatTreatment : null,
    active: input.active,
  };
}

export function taxRateToForm(rate: TaxRate): TaxRateInput {
  return {
    kind: rate.kind,
    name: rate.name,
    rate: String(rate.rate),
    base: rate.base,
    jurisdiction: rate.jurisdiction ?? '',
    vatTreatment: rate.vatTreatment ?? 'GRAVADO',
    active: rate.active,
  };
}

const SELECT = 'id, kind, name, rate, base, jurisdiction, vat_treatment, active';

export async function fetchTaxRates(onlyActive = false): Promise<TaxRate[]> {
  let query = supabase.from('tax_rates').select(SELECT).order('kind').order('rate', { ascending: false });
  if (onlyActive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapTaxRate);
}

/** Las alícuotas de IVA activas, que es lo que ofrece el selector de cada renglón. */
export async function fetchVatRates(): Promise<TaxRate[]> {
  const { data, error } = await supabase
    .from('tax_rates')
    .select(SELECT)
    .eq('kind', 'IVA')
    .eq('active', true)
    .order('rate', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapTaxRate);
}

export async function createTaxRate(input: TaxRateInput): Promise<TaxRate> {
  const { data, error } = await supabase.from('tax_rates').insert(toRow(input)).select(SELECT).single();
  if (error) throw error;
  return mapTaxRate(data);
}

export async function updateTaxRate(id: string, input: TaxRateInput): Promise<TaxRate> {
  const { data, error } = await supabase
    .from('tax_rates')
    .update(toRow(input))
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return mapTaxRate(data);
}

export async function deleteTaxRate(id: string): Promise<void> {
  const { error } = await supabase.from('tax_rates').delete().eq('id', id);
  if (error) throw error;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeTaxRateError(message: string): string {
  if (message.includes('tax_rates_kind_name_key') || message.includes('duplicate key')) {
    return 'Ya existe una alícuota de ese tipo con ese nombre.';
  }
  if (message.includes('tax_rates_iva_coherente')) {
    return 'Una alícuota de IVA se aplica siempre sobre el neto y necesita un tratamiento (gravado, exento o no gravado).';
  }
  if (message.includes('foreign key') || message.includes('violates')) {
    return 'No se puede eliminar: la alícuota ya está usada en algún comprobante. Desactivala en su lugar.';
  }
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de compras en la base (supabase/purchase-catalogs.sql).';
  }
  return message;
}
