import { supabase } from '@/src/lib/supabase';

/**
 * Lo que comparten los listados de comprobantes de venta: la marca de enviado
 * y las etiquetas. Cada tipo tiene su tabla; la base traduce el tipo a la
 * tabla de una lista cerrada (ver supabase/listados-de-comprobantes.sql).
 */
export type TipoComprobante =
  | 'factura'
  | 'nota_credito'
  | 'recibo'
  | 'presupuesto'
  | 'remito'
  | 'orden_trabajo'
  | 'compra'
  | 'orden_pago';

/** Se llama después de mandar el comprobante por mail o WhatsApp. */
export async function marcarEnviado(tipo: TipoComprobante, id: string): Promise<void> {
  const { error } = await supabase.rpc('marcar_comprobante_enviado', { p_tipo: tipo, p_id: id });
  if (error) throw error;
}

export async function guardarEtiquetas(
  tipo: TipoComprobante,
  id: string,
  etiquetas: string[]
): Promise<string[]> {
  const { data, error } = await supabase.rpc('etiquetar_comprobante', {
    p_tipo: tipo,
    p_id: id,
    p_etiquetas: etiquetas,
  });
  if (error) throw error;
  return (data ?? []) as string[];
}

export function siNo(valor: boolean): string {
  return valor ? 'Si' : 'No';
}
