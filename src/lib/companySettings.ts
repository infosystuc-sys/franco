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
  /** Punto de venta de la factura electrónica. Con ARCA, uno dado de alta en AFIP. */
  salesPoint: number;
  /** Punto de venta de la factura interna (letra X), sin validez fiscal. */
  salesPointInternal: number;
  grossIncome: string | null;
  activityStartDate: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  phone: string | null;
  email: string | null;
  /**
   * Logo del comprobante, como data URL. No es un dato fiscal y no se congela
   * en la factura: cambiarlo cambia también cómo se reimprime una vieja.
   */
  logo: string | null;
}

export interface CompanySettingsInput {
  legalName: string;
  tradeName: string;
  taxId: string;
  taxCondition: TaxCondition;
  salesPoint: string;
  salesPointInternal: string;
  grossIncome: string;
  activityStartDate: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  phone: string;
  email: string;
}

const SELECT =
  'legal_name, trade_name, tax_id, tax_condition, sales_point, sales_point_internal, gross_income, ' +
  'activity_start_date, address_street, address_city, address_state, address_zip, phone, email, logo';

function mapCompanySettings(row: any): CompanySettings {
  return {
    legalName: row.legal_name ?? '',
    tradeName: row.trade_name,
    taxId: row.tax_id,
    taxCondition: row.tax_condition,
    salesPoint: Number(row.sales_point),
    salesPointInternal: Number(row.sales_point_internal),
    grossIncome: row.gross_income,
    activityStartDate: row.activity_start_date,
    addressStreet: row.address_street,
    addressCity: row.address_city,
    addressState: row.address_state,
    addressZip: row.address_zip,
    phone: row.phone,
    email: row.email,
    logo: row.logo ?? null,
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

/**
 * Los mismos datos, pero los que van impresos en la cabecera de un
 * comprobante y sin pasar por la tabla: company_settings solo la lee un admin,
 * y el encabezado lo necesitan también el cliente que abre el link del
 * presupuesto —sin sesión— y el operario que lo imprime desde la orden.
 */
export type TallerHeader = Omit<CompanySettings, 'salesPoint' | 'salesPointInternal'>;

export async function fetchTallerHeader(): Promise<TallerHeader | null> {
  const { data, error } = await supabase.rpc('datos_del_taller');
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) return null;

  return {
    legalName: row.legal_name ?? '',
    tradeName: row.trade_name,
    taxId: row.tax_id,
    taxCondition: row.tax_condition,
    grossIncome: row.gross_income,
    activityStartDate: row.activity_start_date,
    addressStreet: row.address_street,
    addressCity: row.address_city,
    addressState: row.address_state,
    addressZip: row.address_zip,
    phone: row.phone,
    email: row.email,
    logo: row.logo ?? null,
  };
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
      sales_point_internal: Number(input.salesPointInternal) || 90000,
      gross_income: nullIfBlank(input.grossIncome),
      activity_start_date: nullIfBlank(input.activityStartDate),
      address_street: nullIfBlank(input.addressStreet),
      address_city: nullIfBlank(input.addressCity),
      address_state: nullIfBlank(input.addressState),
      address_zip: nullIfBlank(input.addressZip),
      phone: nullIfBlank(input.phone),
      email: nullIfBlank(input.email),
    })
    .eq('id', true)
    .select(SELECT)
    .single();

  if (error) throw error;
  return mapCompanySettings(data);
}

/**
 * Cuánto puede pesar el logo ya convertido. La base rechaza por encima de
 * 400.000 caracteres de data URL; acá se corta antes para no llegar nunca a
 * que el error lo tire Postgres, que lo diría en otro idioma.
 */
const LOGO_MAX_CHARS = 380_000;

/** Más ancho que esto no aporta nada impreso y solo engorda la fila. */
const LOGO_MAX_ANCHO = 600;

/**
 * Convierte el archivo elegido en un data URL listo para guardar,
 * achicándolo si hace falta.
 *
 * Se reescala en vez de rechazar los archivos grandes: el logo del taller
 * suele ser una foto o un PNG enorme, y pedirle a quien lo sube que lo
 * achique por su cuenta es pedirle que sepa usar un editor de imágenes.
 */
export async function prepararLogo(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('El logo tiene que ser una imagen.');
  }

  const original = await new Promise<string>((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result));
    lector.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    lector.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('El archivo no es una imagen que se pueda abrir.'));
    el.src = original;
  });

  const escala = Math.min(1, LOGO_MAX_ANCHO / img.width);
  if (escala === 1 && original.length <= LOGO_MAX_CHARS) return original;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * escala);
  canvas.height = Math.round(img.height * escala);
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);

  // PNG primero, que conserva el fondo transparente —un logo casi siempre lo
  // tiene—. Si aun así no entra, JPEG, que pesa mucho menos pero lo pierde.
  const png = canvas.toDataURL('image/png');
  if (png.length <= LOGO_MAX_CHARS) return png;

  const jpeg = canvas.toDataURL('image/jpeg', 0.85);
  if (jpeg.length > LOGO_MAX_CHARS) {
    throw new Error('La imagen es demasiado pesada incluso achicada. Probá con una más simple.');
  }
  return jpeg;
}

/**
 * El logo va aparte del formulario: no es un campo que se edite y se guarde
 * con el resto, sino un archivo que se reemplaza o se saca.
 */
export async function updateCompanyLogo(logo: string | null): Promise<CompanySettings> {
  const { data, error } = await supabase
    .from('company_settings')
    .update({ logo })
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
    salesPointInternal: String(settings.salesPointInternal),
    grossIncome: settings.grossIncome ?? '',
    activityStartDate: settings.activityStartDate ?? '',
    addressStreet: settings.addressStreet ?? '',
    addressCity: settings.addressCity ?? '',
    addressState: settings.addressState ?? '',
    addressZip: settings.addressZip ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
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
