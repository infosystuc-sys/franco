import { supabase } from '@/src/lib/supabase';

export interface Article {
  id: string;
  code: string;
  description: string;
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

/** Precio de venta que resultaría de un precio de compra y una utilidad. */
export function computeSalePrice(purchasePrice: number, markupPercent: number): number {
  return Math.round(purchasePrice * (1 + markupPercent / 100) * 100) / 100;
}
