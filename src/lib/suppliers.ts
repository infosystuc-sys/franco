import { supabase } from '@/src/lib/supabase';
import {
  fiscalEntityToRow,
  mapFiscalEntity,
  type FiscalEntity,
  type FiscalEntityInput,
} from '@/src/lib/fiscal';

/** Artículo que provee, con el código y el precio propios del proveedor. */
export interface SupplierArticle {
  id: string;
  code: string;
  description: string;
  supplierCode: string;
  purchasePrice: number;
  isPreferred: boolean;
}

export interface Supplier extends FiscalEntity {
  articles: SupplierArticle[];
}

export type SupplierInput = FiscalEntityInput;

function mapSupplier(row: any): Supplier {
  return {
    ...mapFiscalEntity(row),
    articles: (row.links ?? []).map((link: any) => ({
      id: link.article?.id ?? link.id,
      code: link.article?.code ?? '—',
      description: link.article?.description ?? '',
      supplierCode: link.supplier_code,
      purchasePrice: Number(link.purchase_price),
      isPreferred: link.is_preferred,
    })),
  };
}

// Los artículos cuelgan de article_suppliers, que además guarda el código y el
// precio con que este proveedor identifica y cotiza cada artículo.
const SELECT_WITH_ARTICLES =
  '*, links:article_suppliers(supplier_code, purchase_price, is_preferred, article:articles(id, code, description))';

export async function fetchSuppliers(onlyActive = false): Promise<Supplier[]> {
  let query = supabase.from('suppliers').select(SELECT_WITH_ARTICLES).order('name');
  if (onlyActive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapSupplier);
}

export async function createSupplier(input: SupplierInput): Promise<Supplier> {
  const { data, error } = await supabase
    .from('suppliers')
    .insert(fiscalEntityToRow(input))
    .select(SELECT_WITH_ARTICLES)
    .single();
  if (error) throw error;
  return mapSupplier(data);
}

export async function updateSupplier(id: string, input: SupplierInput): Promise<Supplier> {
  const { data, error } = await supabase
    .from('suppliers')
    .update(fiscalEntityToRow(input))
    .eq('id', id)
    .select(SELECT_WITH_ARTICLES)
    .single();
  if (error) throw error;
  return mapSupplier(data);
}

export async function deleteSupplier(id: string): Promise<void> {
  const { error } = await supabase.from('suppliers').delete().eq('id', id);
  if (error) throw error;
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeSupplierError(message: string): string {
  if (message.includes('suppliers_tax_id_key') || message.includes('duplicate key')) {
    return 'Ya existe otro proveedor con ese CUIT/CUIL.';
  }
  return message;
}
