/**
 * Datos fiscales (Argentina) compartidos por clientes y proveedores.
 * Ambos padrones usan la misma estructura: razón social, CUIT/CUIL,
 * condición frente al IVA y domicilio fiscal.
 */

export type TaxCondition =
  | 'RESPONSABLE_INSCRIPTO'
  | 'MONOTRIBUTO'
  | 'EXENTO'
  | 'CONSUMIDOR_FINAL';

export const TAX_CONDITION_LABELS: Record<TaxCondition, string> = {
  RESPONSABLE_INSCRIPTO: 'Responsable Inscripto',
  MONOTRIBUTO: 'Monotributo',
  EXENTO: 'Exento',
  CONSUMIDOR_FINAL: 'Consumidor Final',
};

export const TAX_CONDITIONS = Object.keys(TAX_CONDITION_LABELS) as TaxCondition[];

/**
 * Valida un CUIT/CUIL argentino: 11 dígitos con dígito verificador módulo 11.
 * Acepta el string con o sin guiones. Un valor vacío se considera válido
 * (el CUIT es opcional, ej. consumidor final sin datos fiscales).
 */
export function isValidCuit(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return true;
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, weight, i) => acc + weight * Number(digits[i]), 0);

  let checkDigit = 11 - (sum % 11);
  if (checkDigit === 11) checkDigit = 0;
  else if (checkDigit === 10) checkDigit = 9;

  return checkDigit === Number(digits[10]);
}

/** Formatea un CUIT como XX-XXXXXXXX-X. Devuelve el original si no tiene 11 dígitos. */
export function formatCuit(value: string | null): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11) return value;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

/** Los campos de texto vacíos se guardan como null, no como cadena vacía. */
export function nullIfBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Campos fiscales y de contacto comunes a clientes y proveedores. */
export interface FiscalEntity {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  taxCondition: TaxCondition;
  email: string | null;
  phone: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  notes: string | null;
  active: boolean;
}

export interface FiscalEntityInput {
  name: string;
  legalName: string;
  taxId: string;
  taxCondition: TaxCondition;
  email: string;
  phone: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  notes: string;
  active: boolean;
}

export function mapFiscalEntity(row: any): FiscalEntity {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    taxId: row.tax_id,
    taxCondition: row.tax_condition,
    email: row.email,
    phone: row.phone,
    addressStreet: row.address_street,
    addressCity: row.address_city,
    addressState: row.address_state,
    addressZip: row.address_zip,
    notes: row.notes,
    active: row.active,
  };
}

export function fiscalEntityToRow(input: FiscalEntityInput) {
  return {
    name: input.name.trim(),
    legal_name: nullIfBlank(input.legalName),
    tax_id: input.taxId.replace(/\D/g, '') || null,
    tax_condition: input.taxCondition,
    email: nullIfBlank(input.email),
    phone: nullIfBlank(input.phone),
    address_street: nullIfBlank(input.addressStreet),
    address_city: nullIfBlank(input.addressCity),
    address_state: nullIfBlank(input.addressState),
    address_zip: nullIfBlank(input.addressZip),
    notes: nullIfBlank(input.notes),
    active: input.active,
  };
}

export function fiscalEntityToForm(entity: FiscalEntity): FiscalEntityInput {
  return {
    name: entity.name,
    legalName: entity.legalName ?? '',
    taxId: formatCuit(entity.taxId),
    taxCondition: entity.taxCondition,
    email: entity.email ?? '',
    phone: entity.phone ?? '',
    addressStreet: entity.addressStreet ?? '',
    addressCity: entity.addressCity ?? '',
    addressState: entity.addressState ?? '',
    addressZip: entity.addressZip ?? '',
    notes: entity.notes ?? '',
    active: entity.active,
  };
}

export const EMPTY_FISCAL_FORM: FiscalEntityInput = {
  name: '',
  legalName: '',
  taxId: '',
  taxCondition: 'CONSUMIDOR_FINAL',
  email: '',
  phone: '',
  addressStreet: '',
  addressCity: '',
  addressState: '',
  addressZip: '',
  notes: '',
  active: true,
};
