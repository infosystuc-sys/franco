import { supabase } from '@/src/lib/supabase';
import type { PartKind } from '@/src/lib/articles';

/**
 * Actualización masiva de artículos.
 *
 * Se elige a quiénes alcanza y qué cambiarles. Siempre en dos pasos: primero
 * se cuenta —sin tocar nada— y recién con ese número a la vista se aplica. Un
 * filtro vacío alcanza los dieciséis mil artículos, y la diferencia entre eso
 * y los cuarenta que se querían cambiar tiene que verse antes, no después.
 */

export interface FiltroArticulos {
  codigoDesde?: string;
  codigoHasta?: string;
  rubro?: string;
  familia?: string;
  marca?: string;
  partKind?: PartKind;
  supplierId?: string;
  /** true = solo activos, false = solo inactivos, undefined = todos. */
  activos?: boolean;
  texto?: string;
}

/**
 * Solo se mandan los campos elegidos. La cadena vacía significa "dejarlo sin
 * valor"; el campo ausente significa "no tocarlo". Son cosas distintas.
 */
export interface CambiosArticulos {
  markupPercent?: string;
  rubro?: string;
  familia?: string;
  marca?: string;
  partKind?: string;
  tracksStock?: boolean;
  active?: boolean;
}

export interface ValoresDeClasificacion {
  rubros: string[];
  familias: string[];
  marcas: string[];
}

export async function fetchValoresDeClasificacion(): Promise<ValoresDeClasificacion> {
  const { data, error } = await supabase.rpc('valores_de_clasificacion');
  if (error) throw error;
  const d = (data ?? {}) as any;
  return {
    rubros: d.rubros ?? [],
    familias: d.familias ?? [],
    marcas: d.marcas ?? [],
  };
}

function aFiltroJson(f: FiltroArticulos): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (f.codigoDesde?.trim()) j.codigo_desde = f.codigoDesde.trim();
  if (f.codigoHasta?.trim()) j.codigo_hasta = f.codigoHasta.trim();
  if (f.rubro?.trim()) j.rubro = f.rubro.trim();
  if (f.familia?.trim()) j.familia = f.familia.trim();
  if (f.marca?.trim()) j.marca = f.marca.trim();
  if (f.partKind) j.part_kind = f.partKind;
  if (f.supplierId) j.supplier_id = f.supplierId;
  if (f.activos !== undefined) j.activos = f.activos;
  if (f.texto?.trim()) j.texto = f.texto.trim();
  return j;
}

function aCambiosJson(c: CambiosArticulos): Record<string, unknown> {
  const j: Record<string, unknown> = {};
  if (c.markupPercent !== undefined) j.markup_percent = c.markupPercent;
  if (c.rubro !== undefined) j.rubro = c.rubro;
  if (c.familia !== undefined) j.familia = c.familia;
  if (c.marca !== undefined) j.marca = c.marca;
  if (c.partKind !== undefined) j.part_kind = c.partKind;
  if (c.tracksStock !== undefined) j.tracks_stock = c.tracksStock;
  if (c.active !== undefined) j.active = c.active;
  return j;
}

/** Cuántos artículos caen en el filtro. No toca nada. */
export async function contarAlcanzados(
  filtro: FiltroArticulos,
  cambios: CambiosArticulos
): Promise<number> {
  const { data, error } = await supabase.rpc('actualizar_articulos_en_masa', {
    p_filtro: aFiltroJson(filtro),
    p_cambios: aCambiosJson(cambios),
    p_solo_contar: true,
  });
  if (error) throw error;
  return Number((data as any)?.alcanzados ?? 0);
}

export interface ResultadoMasivo {
  afectados: number;
  /**
   * Artículos a los que no se les pudo poner la marca porque con esa marca
   * quedarían idénticos a otro con el mismo número de fábrica.
   */
  salteados: number;
}

export async function actualizarEnMasa(
  filtro: FiltroArticulos,
  cambios: CambiosArticulos
): Promise<ResultadoMasivo> {
  const { data, error } = await supabase.rpc('actualizar_articulos_en_masa', {
    p_filtro: aFiltroJson(filtro),
    p_cambios: aCambiosJson(cambios),
    p_solo_contar: false,
  });
  if (error) throw error;
  const d = (data ?? {}) as any;
  return { afectados: Number(d.afectados ?? 0), salteados: Number(d.salteados ?? 0) };
}
