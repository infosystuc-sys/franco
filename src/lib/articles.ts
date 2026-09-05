import { supabase } from '@/src/lib/supabase';

export interface Article {
  id: string;
  code: string;
  description: string;
  /** Marca del fabricante (DENSO, BOSCH...). No es el proveedor: es de quién es la pieza. */
  brand: string | null;
  /** Precio de VENTA neto. Lo calcula la base: compra del preferido + utilidad. */
  unitPrice: number;
  tracksStock: boolean;
  stockQuantity: number;
  active: boolean;
  /** Utilidad propia del artículo. null = usa el porcentaje global. */
  markupPercent: number | null;
  /** Datos del proveedor preferido, que es el que define el precio de venta. */
  preferredSupplierName: string | null;
  preferredSupplierCode: string | null;
  purchasePrice: number | null;
  /** Cantidad de proveedores vinculados. */
  supplierCount: number;
}

export interface ArticleInput {
  code: string;
  description: string;
  brand: string | null;
  tracksStock: boolean;
  stockQuantity: number;
  active: boolean;
  markupPercent: number | null;
  /**
   * Precio de venta manual. Solo se usa cuando el artículo no tiene proveedor
   * preferido (ej. mano de obra), porque en ese caso no hay precio de compra
   * del que calcularlo.
   */
  unitPrice: number;
}

function mapArticle(row: any): Article {
  const suppliers: any[] = row.suppliers ?? [];
  const preferred = suppliers.find((s) => s.is_preferred) ?? null;

  return {
    id: row.id,
    code: row.code,
    description: row.description,
    brand: row.brand ?? null,
    unitPrice: Number(row.unit_price),
    tracksStock: row.tracks_stock,
    stockQuantity: Number(row.stock_quantity),
    active: row.active,
    markupPercent: row.markup_percent === null ? null : Number(row.markup_percent),
    preferredSupplierName: preferred?.supplier?.name ?? null,
    preferredSupplierCode: preferred?.supplier_code ?? null,
    purchasePrice: preferred ? Number(preferred.purchase_price) : null,
    supplierCount: suppliers.length,
  };
}

const SELECT_WITH_SUPPLIERS =
  '*, suppliers:article_suppliers(supplier_code, purchase_price, is_preferred, supplier:suppliers(name))';

export async function fetchArticles(includeInactive = true): Promise<Article[]> {
  let query = supabase.from('articles').select(SELECT_WITH_SUPPLIERS).order('code');
  if (!includeInactive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapArticle);
}

function toRow(input: ArticleInput) {
  return {
    code: input.code,
    description: input.description,
    brand: input.brand,
    tracks_stock: input.tracksStock,
    stock_quantity: input.tracksStock ? input.stockQuantity : 0,
    active: input.active,
    markup_percent: input.markupPercent,
    unit_price: input.unitPrice,
  };
}

export async function createArticle(input: ArticleInput): Promise<Article> {
  const { data, error } = await supabase
    .from('articles')
    .insert(toRow(input))
    .select(SELECT_WITH_SUPPLIERS)
    .single();
  if (error) throw error;
  return mapArticle(data);
}

export async function updateArticle(id: string, input: ArticleInput): Promise<Article> {
  const { data, error } = await supabase
    .from('articles')
    .update(toRow(input))
    .eq('id', id)
    .select(SELECT_WITH_SUPPLIERS)
    .single();
  if (error) throw error;
  return mapArticle(data);
}

export async function deleteArticle(id: string): Promise<void> {
  const { error } = await supabase.from('articles').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Precio de venta que resultaría de un precio de compra y una utilidad,
 * redondeado hacia arriba al múltiplo de $10 más cercano (mismo criterio que
 * compute_sale_price() en la base — ver price-lists-rounding.sql).
 */
export function computeSalePrice(purchasePrice: number, markupPercent: number): number {
  return Math.ceil((purchasePrice * (1 + markupPercent / 100)) / 10) * 10;
}

export interface LinkedSupplierArticle {
  articleId: string;
  code: string;
  description: string;
  /** true si el artículo se dio de alta ahora; false si se vinculó a uno que ya existía. */
  created: boolean;
}

/**
 * Deja un renglón de factura enganchado al catálogo, guardando el código con
 * que ese proveedor lo llama.
 *
 * Con `articleId` vincula un artículo que ya existe; sin él lo da de alta con
 * el mismo generador de código que la importación de listas de precios. En
 * los dos casos lo que importa es que el código del proveedor quede
 * registrado: es lo que hace que la próxima factura reconozca ese renglón
 * sola, en vez de volver a pedir que lo elijan a mano.
 *
 * El precio de venta lo calcula la base al guardar el precio de compra.
 */
export async function linkOrCreateSupplierArticle(params: {
  supplierId: string;
  supplierCode: string;
  description: string;
  purchasePrice: number;
  articleId?: string | null;
}): Promise<LinkedSupplierArticle> {
  const { data, error } = await supabase.rpc('link_or_create_supplier_article', {
    p_supplier_id: params.supplierId,
    p_supplier_code: params.supplierCode,
    p_description: params.description,
    p_purchase_price: params.purchasePrice,
    p_article_id: params.articleId ?? null,
  });
  if (error) throw error;
  const row: any = Array.isArray(data) ? data[0] : data;
  return {
    articleId: row.result_article_id,
    code: row.result_code,
    description: row.result_description,
    created: row.result_created,
  };
}

/**
 * Con qué código llama un proveedor a cada uno de sus artículos.
 *
 * Sirve para reconocer un renglón por el código impreso en el papel cuando la
 * lectura con IA ya quedó guardada: el borrador conserva el matcheo del
 * momento en que se leyó, así que un artículo dado de alta después seguiría
 * figurando como desconocido hasta que alguien lo vuelva a tocar.
 *
 * La clave va en mayúsculas, igual que el índice único de la base.
 */
export async function fetchSupplierCodeMap(supplierId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('article_suppliers')
    .select('article_id, supplier_code')
    .eq('supplier_id', supplierId);
  if (error) throw error;
  return new Map(
    (data ?? []).map((row: any) => [String(row.supplier_code).trim().toUpperCase(), row.article_id as string])
  );
}
