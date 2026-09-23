import { supabase } from '@/src/lib/supabase';

/*
  La facturación electrónica con ARCA, del lado de la pantalla.

  Todo pasa por la Edge Function facturacion-arca: es la única que puede leer
  la clave privada. Acá solo se arma el pedido y se interpreta la respuesta.

  El diagnóstico no emite nada. Emitir sí, y es la única operación de la app
  que no se puede deshacer sola: un CAE otorgado solo se revierte con una nota
  de crédito.
*/

export interface PuntoDeVentaArca {
  numero: number;
  /** "CAE" = web services, lo que usa la app. "CAEA" es otro régimen. */
  tipoEmision: string;
  bloqueado: boolean;
  fechaBaja: string | null;
  /** Último comprobante autorizado por letra, o el error de ARCA para esa letra. */
  ultimos: Record<string, number | string>;
}

export interface DiagnosticoArca {
  servidores: { aplicacion: string; baseDeDatos: string; autenticacion: string };
  certificado: {
    cuit: string;
    vence: string;
    diasParaVencer: number;
    coincideConTaller: boolean;
  } | null;
  puntosDeVenta: PuntoDeVentaArca[];
  puntoDeVentaConfigurado: number | null;
  avisos: string[];
}

/**
 * Consulta el estado real de ARCA sin emitir nada: servidores, certificado,
 * puntos de venta habilitados y el último número autorizado de cada uno.
 */
export async function diagnosticoFacturacion(): Promise<DiagnosticoArca> {
  const { data, error } = await supabase.functions.invoke('facturacion-arca', {
    body: { accion: 'diagnostico' },
  });

  // El error de la función viene con cuerpo propio: el mensaje de adentro es el
  // de ARCA (servicio sin delegar, certificado vencido), que es el que sirve.
  if (error) throw new Error(await mensajeDeError(error));
  if (data?.error) throw new Error(String(data.error));
  return data as DiagnosticoArca;
}

/**
 * Lo que contesta ARCA cuando se le pide el CAE de una factura pendiente.
 *
 * Un rechazo no es una falla del sistema: la factura se queda en PENDIENTE_CAE
 * con su número reservado, y una vez corregido lo que ARCA objetó se reintenta
 * con el mismo número. Por eso `autorizada: false` viaja como respuesta normal
 * y no como excepción.
 */
export interface ResultadoEmision {
  autorizada: boolean;
  factura: string;
  /** Con CAE solo si ARCA autorizó. */
  cae?: string;
  caeVence?: string;
  /** El veredicto crudo de ARCA (A, R, P) cuando no autorizó. */
  resultado?: string;
  errores?: string[];
  observaciones?: string[];
}

export async function emitirEnArca(invoiceId: string): Promise<ResultadoEmision> {
  const { data, error } = await supabase.functions.invoke('facturacion-arca', {
    body: { accion: 'emitir', invoice_id: invoiceId },
  });

  if (error) throw new Error(await mensajeDeError(error));
  if (data?.error) throw new Error(String(data.error));
  return data as ResultadoEmision;
}

/** Los reparos de ARCA en un texto, para avisarlos en el momento. */
export function motivoDelRechazo(r: ResultadoEmision): string {
  const motivos = [...(r.errores ?? []), ...(r.observaciones ?? [])];
  return motivos.length
    ? motivos.join('\n')
    : `ARCA respondió "${r.resultado ?? '?'}" sin detallar por qué.`;
}

/**
 * El CAE como parte del acto de emitir, no como un trámite posterior.
 *
 * Devuelve true solo si ARCA autorizó. Cuando no, avisa y devuelve false: la
 * factura ya tomó su número y quedó esperando, así que lo importante es que
 * quien emitió entienda que no hay comprobante todavía y que el camino es
 * reintentar con ese mismo número, no rehacer la factura.
 *
 * Vive acá y no en cada pantalla para que las dos digan exactamente lo mismo.
 */
export async function pedirCaeAlEmitir(invoiceId: string, fullNumber: string): Promise<boolean> {
  let resultado: ResultadoEmision;

  try {
    resultado = await emitirEnArca(invoiceId);
  } catch (err) {
    window.alert(
      `La factura ${fullNumber} tomó su número, pero no se pudo hablar con ARCA:\n\n` +
        `${err instanceof Error ? err.message : String(err)}\n\n` +
        'Quedó esperando el CAE con ese mismo número. Volvé a pedirlo desde ' +
        'Facturación cuando se resuelva; no hace falta rehacer la factura.'
    );
    return false;
  }

  if (!resultado.autorizada) {
    window.alert(
      `La factura ${fullNumber} tomó su número, pero ARCA no la autorizó:\n\n` +
        `${motivoDelRechazo(resultado)}\n\n` +
        'Quedó esperando el CAE con ese mismo número. Corregí lo que ARCA objeta y ' +
        'volvé a pedirlo desde Facturación.'
    );
    return false;
  }

  return true;
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
