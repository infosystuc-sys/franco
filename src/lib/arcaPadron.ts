import { supabase } from '@/src/lib/supabase';
import type { FiscalEntityInput, TaxCondition } from '@/src/lib/fiscal';

/**
 * Padrón de ARCA: traer los datos de un cliente o proveedor con el CUIT.
 *
 * La consulta la hace una Edge Function, no el navegador: firmarla exige una
 * clave privada que no puede salir del servidor. Acá solo se manda el número y
 * se recibe la ficha ya traducida.
 *
 * El certificado también se carga desde acá, pero por RPC y en un solo sentido:
 * se manda y no se puede recuperar. La pantalla nunca ve la clave privada, ni
 * siquiera la que acaba de guardar.
 */

export interface DatosDePadron {
  taxId: string;
  legalName: string;
  name: string;
  taxCondition: TaxCondition;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  tipoPersona: string;
  /** ACTIVO / INACTIVO según ARCA. Una clave inactiva se avisa, no se bloquea. */
  estadoClave: string;
  detalleImpuestos: string[];
  categoriaMonotributo: string;
}

export interface ResultadoDePadron {
  datos: DatosDePadron;
  /** Cuando el DNI resolvió a más de un CUIT, cuál se trajo. */
  aviso: string | null;
}

export async function consultarPadron(documento: string): Promise<ResultadoDePadron> {
  const limpio = documento.replace(/\D/g, '');
  const { data, error } = await supabase.functions.invoke('consultar-padron', {
    body: { documento: limpio },
  });

  // Un error de la función viene con cuerpo propio: el mensaje de adentro dice
  // qué pasó (no existe, certificado vencido, servicio sin habilitar) y el de
  // afuera solo dice que dio error.
  if (error) {
    const detalle = await mensajeDeError(error);
    throw new Error(detalle);
  }
  if (data?.error) throw new Error(String(data.error));
  if (!data?.datos) throw new Error('ARCA no devolvió datos.');

  return { datos: data.datos as DatosDePadron, aviso: data.aviso ?? null };
}

async function mensajeDeError(error: unknown): Promise<string> {
  const contexto = (error as { context?: Response })?.context;
  if (contexto && typeof contexto.json === 'function') {
    try {
      const cuerpo = await contexto.json();
      if (cuerpo?.error) return String(cuerpo.error);
    } catch {
      // Sin cuerpo JSON queda el mensaje genérico de abajo.
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lo que trae ARCA, volcado sobre la ficha que se está editando.
 *
 * Se pisan solo los campos que ARCA conoce. Email, teléfono y observaciones se
 * dejan como estaban: el padrón no los publica, y borrar un teléfono que
 * alguien cargó a mano para reemplazarlo por nada sería peor que no consultar.
 *
 * El nombre visible solo se completa si estaba vacío. En un taller el cliente
 * suele estar anotado como lo nombran —"Agrícola del Sur"— y no como figura en
 * ARCA; una consulta para corregir el domicilio no tiene por qué renombrarlo.
 */
export function volcarEnFicha(
  form: FiscalEntityInput,
  datos: DatosDePadron
): Partial<FiscalEntityInput> {
  const cambios: Partial<FiscalEntityInput> = {
    taxId: datos.taxId,
    legalName: datos.legalName,
    taxCondition: datos.taxCondition,
    addressStreet: datos.addressStreet,
    addressCity: datos.addressCity,
    addressState: datos.addressState,
    addressZip: datos.addressZip,
  };
  if (form.name.trim() === '') cambios.name = datos.name;
  return cambios;
}

// ── El certificado ──────────────────────────────────────────────────────────

export type PropositoArca = 'PADRON' | 'FACTURACION';

export const PROPOSITO_LABELS: Record<PropositoArca, string> = {
  PADRON: 'Consulta de padrón',
  FACTURACION: 'Facturación electrónica',
};

export const PROPOSITO_AYUDA: Record<PropositoArca, string> = {
  PADRON:
    'Trae razón social, condición de IVA y domicilio al dar de alta un cliente o proveedor. ' +
    'Puede estar a nombre de cualquier CUIT: ARCA solo mira quién firma la consulta.',
  FACTURACION:
    'Para pedir el CAE de cada comprobante. Este tiene que ser del CUIT que factura. ' +
    'Por ahora solo sirve para probar la conexión: las facturas todavía no piden CAE a ARCA.',
};

export interface EstadoCertificado {
  proposito: PropositoArca;
  cargado: boolean;
  cuit: string | null;
  actualizado: string | null;
  ticketVigenteHasta: string | null;
}

export async function fetchEstadoCertificados(): Promise<EstadoCertificado[]> {
  const { data, error } = await supabase.rpc('estado_certificados_arca');
  if (error) throw error;
  return (data ?? []).map((fila: Record<string, unknown>) => ({
    proposito: fila.proposito as PropositoArca,
    cargado: Boolean(fila.cargado),
    cuit: (fila.cuit as string) ?? null,
    actualizado: (fila.actualizado as string) ?? null,
    ticketVigenteHasta: (fila.ticket_vigente_hasta as string) ?? null,
  }));
}

export async function guardarCertificado(
  proposito: PropositoArca,
  cuit: string,
  cert: string,
  key: string
): Promise<void> {
  const { error } = await supabase.rpc('guardar_certificado_arca', {
    p_proposito: proposito,
    p_cuit: cuit,
    p_cert: cert,
    p_key: key,
  });
  if (error) throw error;
}

export async function borrarCertificado(proposito: PropositoArca): Promise<void> {
  const { error } = await supabase.rpc('borrar_certificado_arca', { p_proposito: proposito });
  if (error) throw error;
}

/**
 * El CUIT que figura en el certificado, leído del propio archivo.
 *
 * ARCA lo pone en el campo serialNumber del titular, como "CUIT 20418705516".
 * Se lo saca de ahí en vez de pedirlo aparte: escribirlo a mano es una
 * oportunidad más de equivocarse, y un CUIT que no coincide con el certificado
 * hace que ARCA rechace todas las consultas sin decir por qué.
 */
export function cuitDelCertificado(certPem: string): string | null {
  const cuerpo = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  if (!cuerpo) return null;
  try {
    const binario = atob(cuerpo);
    // El certificado es DER (binario) y el CUIT está adentro como texto plano:
    // buscarlo así evita tener que traer un parser de X.509 entero al navegador
    // para leer un solo campo.
    const encontrado = binario.match(/CUIT\s*(\d{11})/);
    return encontrado ? encontrado[1] : null;
  } catch {
    return null;
  }
}
