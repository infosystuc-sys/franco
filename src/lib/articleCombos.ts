import { supabase } from '@/src/lib/supabase';

/**
 * Combos: un artículo que contiene otros.
 *
 * El kit de reparación de una VP44 son cuatro repuestos que siempre salen
 * juntos. El combo entra como UN renglón, con su propio precio: el cliente ve
 * "Kit reparación VP44" y no la lista de partes.
 *
 * El stock que sale del estante es el de los componentes, no el del combo —el
 * combo no existe como cosa física—. Eso lo resuelve la base, en el trigger de
 * renglones de orden, para que valga sin importar por dónde se haya cargado el
 * renglón.
 */

export interface ArticleComponent {
  id: string;
  componentArticleId: string;
  code: string;
  description: string;
  quantity: number;
  /** Precio de venta del componente suelto, para comparar contra el del combo. */
  unitPrice: number;
}

const SELECT = `
  id, component_article_id, quantity, position,
  article:articles!article_components_component_article_id_fkey(code, description, unit_price)
`;

function mapComponent(row: Record<string, any>): ArticleComponent {
  return {
    id: row.id,
    componentArticleId: row.component_article_id,
    code: row.article?.code ?? '—',
    description: row.article?.description ?? '—',
    quantity: Number(row.quantity),
    unitPrice: Number(row.article?.unit_price ?? 0),
  };
}

export async function fetchArticleComponents(comboArticleId: string): Promise<ArticleComponent[]> {
  const { data, error } = await supabase
    .from('article_components')
    .select(SELECT)
    .eq('combo_article_id', comboArticleId)
    .order('position');
  if (error) throw error;
  return (data ?? []).map(mapComponent);
}

export async function addArticleComponent(
  comboArticleId: string,
  componentArticleId: string,
  quantity: number
): Promise<void> {
  const { error } = await supabase.from('article_components').insert({
    combo_article_id: comboArticleId,
    component_article_id: componentArticleId,
    quantity: Math.max(1, Math.trunc(quantity) || 1),
  });
  if (error) throw error;
}

export async function updateArticleComponent(id: string, quantity: number): Promise<void> {
  const { error } = await supabase
    .from('article_components')
    .update({ quantity: Math.max(1, Math.trunc(quantity) || 1) })
    .eq('id', id);
  if (error) throw error;
}

export async function removeArticleComponent(id: string): Promise<void> {
  const { error } = await supabase.from('article_components').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Qué artículos son combos, para marcarlos en las listas.
 *
 * Se trae de una sola consulta en vez de preguntar por artículo: el buscador
 * de renglones muestra el catálogo entero y una consulta por fila lo dejaría
 * de rodillas.
 */
export async function fetchComboArticleIds(): Promise<Set<string>> {
  const { data, error } = await supabase.from('article_components').select('combo_article_id');
  if (error) throw error;
  return new Set((data ?? []).map((fila) => fila.combo_article_id as string));
}

/** Traduce los errores de base que puede devolver armar un combo. */
export function describeComboError(message: string): string {
  if (message.includes('article_components_combo_article_id_component_article_id_key')) {
    return 'Ese artículo ya está en el combo. Cambiale la cantidad en vez de agregarlo de nuevo.';
  }
  if (message.includes('article_components_check')) {
    return 'Un combo no puede contenerse a sí mismo.';
  }
  return message;
}
