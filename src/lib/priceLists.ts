import { supabase } from '@/src/lib/supabase';

/** Precio de compra de un artículo para un proveedor puntual. */
export interface ArticleSupplier {
  id: string;
  articleId: string;
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  supplierDescription: string | null;
  purchasePrice: number;
  isPreferred: boolean;
  updatedAt: string;
}

export interface PriceImport {
  id: string;
  supplierId: string;
  supplierName: string;
  fileName: string | null;
  totalRows: number;
  matchedRows: number;
  /** Artículos nuevos dados de alta en esta importación. */
  createdRows: number;
  importedAt: string;
}

/** Fila del Excel, ya normalizada. */
export interface ImportRow {
  code: string;
  description: string;
  brand: string | null;
  price: number;
}

export interface ImportResult {
  totalRows: number;
  matchedRows: number;
  /** Artículos nuevos dados de alta en esta importación. */
  createdRows: number;
  importId: string;
}

/** Mapeo de columnas del Excel de un proveedor, guardado para reusar. */
export interface ColumnMapping {
  codeColumn: number;
  priceColumn: number;
  descriptionColumn: number | null;
  brandColumn: number | null;
}

function mapArticleSupplier(row: any): ArticleSupplier {
  return {
    id: row.id,
    articleId: row.article_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier?.name ?? '—',
    supplierCode: row.supplier_code,
    supplierDescription: row.supplier_description,
    purchasePrice: Number(row.purchase_price),
    isPreferred: row.is_preferred,
    updatedAt: row.updated_at,
  };
}

// ===== Utilidad global =====

export async function fetchDefaultMarkup(): Promise<number> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'default_markup_percent')
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.value) : 0;
}

/**
 * Cambia la utilidad global y recalcula los precios de venta de los artículos
 * que no tienen utilidad propia. Devuelve cuántos precios cambiaron.
 */
export async function updateDefaultMarkup(percent: number): Promise<number> {
  const { error } = await supabase
    .from('app_settings')
    .update({ value: String(percent), updated_at: new Date().toISOString() })
    .eq('key', 'default_markup_percent');
  if (error) throw error;

  const { data, error: rpcError } = await supabase.rpc('recalculate_all_sale_prices');
  if (rpcError) throw rpcError;
  return Number(data ?? 0);
}

// ===== Proveedores de un artículo =====

export async function fetchArticleSuppliers(articleId: string): Promise<ArticleSupplier[]> {
  const { data, error } = await supabase
    .from('article_suppliers')
    .select('*, supplier:suppliers(name)')
    .eq('article_id', articleId)
    .order('is_preferred', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapArticleSupplier);
}

export interface ArticleSupplierInput {
  supplierId: string;
  supplierCode: string;
  purchasePrice: number;
}

export async function addArticleSupplier(
  articleId: string,
  input: ArticleSupplierInput,
  makePreferred: boolean
): Promise<void> {
  const { error } = await supabase.from('article_suppliers').insert({
    article_id: articleId,
    supplier_id: input.supplierId,
    supplier_code: input.supplierCode.trim(),
    purchase_price: input.purchasePrice,
    is_preferred: makePreferred,
  });
  if (error) throw error;
}

export async function updateArticleSupplier(
  id: string,
  values: { supplierCode: string; purchasePrice: number }
): Promise<void> {
  const { error } = await supabase
    .from('article_suppliers')
    .update({ supplier_code: values.supplierCode.trim(), purchase_price: values.purchasePrice })
    .eq('id', id);
  if (error) throw error;
}

export async function removeArticleSupplier(id: string): Promise<void> {
  const { error } = await supabase.from('article_suppliers').delete().eq('id', id);
  if (error) throw error;
}

/** Marca el proveedor preferido; la RPC desmarca el anterior de forma atómica. */
export async function setPreferredSupplier(articleId: string, supplierId: string): Promise<void> {
  const { error } = await supabase.rpc('set_preferred_supplier', {
    p_article_id: articleId,
    p_supplier_id: supplierId,
  });
  if (error) throw error;
}

// ===== Mapeo de columnas por proveedor =====

export async function fetchSupplierImportProfile(supplierId: string): Promise<ColumnMapping | null> {
  const { data, error } = await supabase
    .from('supplier_import_profiles')
    .select('code_column, description_column, brand_column, price_column')
    .eq('supplier_id', supplierId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    codeColumn: data.code_column,
    priceColumn: data.price_column,
    descriptionColumn: data.description_column,
    brandColumn: data.brand_column,
  };
}

export async function saveSupplierImportProfile(supplierId: string, mapping: ColumnMapping): Promise<void> {
  const { error } = await supabase.from('supplier_import_profiles').upsert({
    supplier_id: supplierId,
    code_column: mapping.codeColumn,
    price_column: mapping.priceColumn,
    description_column: mapping.descriptionColumn,
    brand_column: mapping.brandColumn,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// ===== Importación =====

export async function importSupplierPrices(
  supplierId: string,
  fileName: string,
  rows: ImportRow[]
): Promise<ImportResult> {
  const { data, error } = await supabase.rpc('import_supplier_prices', {
    p_supplier_id: supplierId,
    p_file_name: fileName,
    p_rows: rows,
  });
  if (error) throw error;
  const result: any = Array.isArray(data) ? data[0] : data;
  return {
    totalRows: Number(result.total_rows),
    matchedRows: Number(result.matched_rows),
    createdRows: Number(result.unmatched_rows),
    importId: result.import_id,
  };
}

export async function fetchPriceImports(limit = 20): Promise<PriceImport[]> {
  const { data, error } = await supabase
    .from('price_imports')
    .select('*, supplier:suppliers(name)')
    .order('imported_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier?.name ?? '—',
    fileName: row.file_name,
    totalRows: row.total_rows,
    matchedRows: row.matched_rows,
    createdRows: row.unmatched_rows,
    importedAt: row.imported_at,
  }));
}

/** Traduce errores de base a mensajes accionables. */
export function describePriceError(message: string): string {
  if (message.includes('article_suppliers_supplier_code_key')) {
    return 'Ese código ya está usado por otro artículo para el mismo proveedor.';
  }
  if (message.includes('article_suppliers_article_id_supplier_id_key')) {
    return 'Este proveedor ya está vinculado al artículo. Editá el vínculo existente.';
  }
  if (message.includes('article_suppliers_one_preferred')) {
    return 'El artículo ya tiene un proveedor preferido.';
  }
  return message;
}
