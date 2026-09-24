import { supabase } from '@/src/lib/supabase';

/**
 * Artículos duplicados: la misma pieza cargada más de una vez, con el mismo
 * número de fábrica.
 *
 * Salieron de importaciones viejas, cuando todavía no se reconocía la pieza
 * por su número de fábrica. Molestan de dos maneras: el stock y el precio
 * quedan repartidos entre dos fichas, y al importar una lista el duplicado
 * hace chocar el índice único —fue lo que abortaba una importación entera—.
 */

export interface ArticuloDuplicado {
  id: string;
  code: string;
  description: string;
  brand: string | null;
  active: boolean;
  tracksStock: boolean;
  stockQuantity: number;
  unitPrice: number;
  /** Cuántos proveedores lo tienen cargado. */
  proveedores: number;
  /** En cuántos comprobantes aparece. El que tiene historia conviene conservarlo. */
  movimientos: number;
}

export interface GrupoDuplicado {
  factoryCode: string;
  articulos: ArticuloDuplicado[];
}

export async function fetchArticulosDuplicados(): Promise<GrupoDuplicado[]> {
  const { data, error } = await supabase.rpc('articulos_duplicados');
  if (error) throw error;

  return ((data ?? []) as any[]).map((g) => ({
    factoryCode: g.factory_code,
    articulos: (g.articulos ?? []).map((a: any) => ({
      id: a.id,
      code: a.code,
      description: a.description,
      brand: a.brand,
      active: a.active,
      tracksStock: a.tracks_stock,
      stockQuantity: Number(a.stock_quantity ?? 0),
      unitPrice: Number(a.unit_price ?? 0),
      proveedores: Number(a.proveedores ?? 0),
      movimientos: Number(a.movimientos ?? 0),
    })),
  }));
}

export interface ResultadoFusion {
  conservado: string;
  absorbido: string;
  proveedoresMovidos: number;
  /**
   * Un artículo tiene un solo código por proveedor. Si los dos estaban
   * cargados con el mismo proveedor, uno de los códigos se pierde y ese código
   * deja de reconocerse al importar.
   */
  codigosPerdidos: string[];
  stockResultante: number;
}

export async function fusionarArticulos(
  conservarId: string,
  absorberId: string
): Promise<ResultadoFusion> {
  const { data, error } = await supabase.rpc('fusionar_articulos', {
    p_conservar: conservarId,
    p_absorber: absorberId,
  });
  if (error) throw error;

  const r = data as any;
  return {
    conservado: r.conservado,
    absorbido: r.absorbido,
    proveedoresMovidos: Number(r.proveedores_movidos ?? 0),
    codigosPerdidos: r.codigos_perdidos ?? [],
    stockResultante: Number(r.stock_resultante ?? 0),
  };
}
