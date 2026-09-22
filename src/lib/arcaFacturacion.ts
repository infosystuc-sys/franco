import { supabase } from '@/src/lib/supabase';

/*
  La facturación electrónica con ARCA, del lado de la pantalla.

  Todo pasa por la Edge Function facturacion-arca: es la única que puede leer
  la clave privada. Acá solo se arma el pedido y se interpreta la respuesta.

  Por ahora hay una sola acción, el diagnóstico, que no emite nada.
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
