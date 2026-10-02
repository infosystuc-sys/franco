import { normalizarBusqueda } from '@/src/lib/utils';
import { supabase } from '@/src/lib/supabase';

export interface Article {
  id: string;
  code: string;
  description: string;
  /** Marca del fabricante (DENSO, BOSCH...). No es el proveedor: es de quién es la pieza. */
  brand: string | null;
  /**
   * Número del fabricante, normalizado. Es lo que une a los proveedores que
   * venden la misma pieza con códigos distintos.
   */
  factoryCode: string | null;
  /** Si es la pieza del fabricante o la que lo reemplaza. Null = no se sabe. */
  partKind: PartKind | null;
  /** Agrupación mayor: TOBERAS, BOMBAS... Texto libre. */
  rubro: string | null;
  /** Agrupación dentro del rubro: COMMON RAIL, CONVENCIONAL... Texto libre. */
  familia: string | null;
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

export type PartKind = 'ORIGINAL' | 'REEMPLAZO';

export const PART_KIND_LABELS: Record<PartKind, string> = {
  ORIGINAL: 'Original',
  REEMPLAZO: 'Reemplazo',
};

export interface ArticleInput {
  /** Vacío al dar de alta: lo pone la base con la secuencia del catálogo. */
  code: string;
  description: string;
  brand: string | null;
  factoryCode: string | null;
  /** Si es la pieza del fabricante o la que lo reemplaza. Null = no se sabe. */
  partKind: PartKind | null;
  rubro: string | null;
  familia: string | null;
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

/**
 * Deja un código comparable: mayúsculas y sin separadores. Bosch imprime sus
 * números partidos —"0 433 171 034"— y cada lista los copia a su manera.
 */
function normalizar(valor: string): string {
  return valor.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * ¿Este artículo coincide con lo que se escribió en el buscador?
 *
 * Vive acá y no en cada pantalla porque lo usan tres buscadores —el de la
 * orden, el de la factura de compra y el de Inventario— y tienen que
 * encontrar lo mismo: si uno halla la pieza por el número de Bosch y otro no,
 * quien carga cree que no está en el catálogo y la da de alta de nuevo.
 *
 * El número de fábrica se compara normalizado; el resto, como se escribió.
 * Normalizar todo rompería la búsqueda por descripción de más de una palabra.
 */
export function articuloCoincide(article: Article, termino: string): boolean {
  return coincideConClave(claveDeBusqueda(article), prepararTermino(termino));
}

/**
 * Lo que se compara de cada artículo, ya normalizado. Normalizar (minúsculas,
 * sin acentos, sin separadores) es lo caro de buscar, y hacerlo de nuevo en
 * cada tecla sobre ~20.000 artículos trababa el buscador de la factura. Se
 * calcula una vez por artículo y queda guardado mientras el objeto exista.
 */
interface ClaveDeBusqueda {
  texto: string;
  descripcion: string;
  compacto: string;
  fabrica: string;
}

const claves = new WeakMap<Article, ClaveDeBusqueda>();

function claveDeBusqueda(article: Article): ClaveDeBusqueda {
  let clave = claves.get(article);
  if (!clave) {
    const textos = [
      article.code,
      article.description,
      article.brand,
      article.preferredSupplierCode,
      article.preferredSupplierName,
    ].filter((c) => c !== null && c !== undefined && c !== '');
    const texto = normalizarBusqueda(textos.join(' '));
    clave = {
      texto,
      descripcion: normalizarBusqueda(article.description),
      compacto: texto.replace(/[\s-]/g, ''),
      fabrica: article.factoryCode ? normalizar(article.factoryCode) : '',
    };
    claves.set(article, clave);
  }
  return clave;
}

interface TerminoPreparado {
  palabras: { tal: string; sinGuiones: string }[];
  fabrica: string;
}

function prepararTermino(termino: string): TerminoPreparado {
  return {
    palabras: normalizarBusqueda(termino)
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => ({ tal: p, sinGuiones: p.replace(/-/g, '') })),
    fabrica: normalizar(termino),
  };
}

// La misma regla que coincideBusqueda (cada palabra en algún campo, en
// cualquier orden), más el número de fábrica comparado sin separadores.
function coincideConClave(clave: ClaveDeBusqueda, t: TerminoPreparado): boolean {
  if (t.palabras.length === 0) return true;
  if (t.palabras.every((p) => clave.texto.includes(p.tal) || clave.compacto.includes(p.sinGuiones))) return true;
  return t.fabrica !== '' && clave.fabrica !== '' && clave.fabrica.includes(t.fabrica);
}

/** Los artículos que coinciden con lo escrito, en el orden en que vienen. */
export function filtrarArticulos(articles: Article[], termino: string): Article[] {
  if (termino.trim() === '') return articles;
  const t = prepararTermino(termino);
  return articles.filter((a) => coincideConClave(claveDeBusqueda(a), t));
}

/**
 * Cuántos renglones dibuja un buscador de artículos. Dibujar los ~20.000 del
 * catálogo (o los miles que coinciden con una letra) es lo que más tardaba:
 * nadie los recorre a mano, se escribe más para acotar.
 */
export const ARTICULOS_A_MOSTRAR = 100;

function mapArticle(row: any): Article {
  const suppliers: any[] = row.suppliers ?? [];
  const preferred = suppliers.find((s) => s.is_preferred) ?? null;

  return {
    id: row.id,
    code: row.code,
    description: row.description,
    brand: row.brand ?? null,
    factoryCode: row.factory_code ?? null,
    partKind: (row.part_kind ?? null) as PartKind | null,
    rubro: row.rubro ?? null,
    familia: row.familia ?? null,
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

/**
 * La base entrega como máximo 1000 filas por consulta: con más artículos que
 * eso, los últimos en orden de código (los que empiezan con letras más
 * avanzadas, como una Z) no llegaban a ninguna pantalla.
 *
 * Se piden de a tandas hasta traerlos todos, pero no una después de la otra:
 * con ~20.000 artículos eso son veinte viajes de ida y vuelta en fila, y cada
 * pantalla que factura, cotiza o compra espera esa fila entera antes de poder
 * usarse. La primera tanda trae también el total (count: 'exact'), y con eso
 * se sabe cuántas tandas más hacen falta y se piden todas juntas.
 */
const TANDA = 1000;

function tandaDeArticulos(includeInactive: boolean, desde: number, hasta: number, conTotal: boolean) {
  let query = supabase
    .from('articles')
    .select(SELECT_WITH_SUPPLIERS, conTotal ? { count: 'exact' } : undefined)
    .order('code')
    .range(desde, hasta);
  if (!includeInactive) query = query.eq('active', true);
  return query;
}

export async function fetchArticles(includeInactive = true): Promise<Article[]> {
  const primera = await tandaDeArticulos(includeInactive, 0, TANDA - 1, true);
  if (primera.error) throw primera.error;

  const total = primera.count ?? (primera.data ?? []).length;
  const tandasQueFaltan = Math.max(0, Math.ceil(total / TANDA) - 1);

  const resto = await Promise.all(
    Array.from({ length: tandasQueFaltan }, (_, i) => {
      const desde = (i + 1) * TANDA;
      return tandaDeArticulos(includeInactive, desde, desde + TANDA - 1, false);
    })
  );
  for (const r of resto) if (r.error) throw r.error;

  return [...(primera.data ?? []), ...resto.flatMap((r) => r.data ?? [])].map(mapArticle);
}

function toRow(input: ArticleInput) {
  // El código no se manda nunca: lo asigna la base con la secuencia del
  // catálogo al dar de alta y no deja cambiarlo después.
  return {
    description: input.description,
    brand: input.brand,
    factory_code: input.factoryCode,
    part_kind: input.partKind,
    rubro: input.rubro,
    familia: input.familia,
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

/**
 * Los artículos cuyo número de fábrica, código nuestro o descripción es
 * exactamente lo escrito (sin importar mayúsculas, acentos ni separadores en
 * el número de fábrica). Es lo que usa el campo código de los renglones: si
 * hay uno solo, se agrega directo; si no, se abre el buscador.
 *
 * El índice se arma una vez por catálogo y queda guardado mientras ese
 * arreglo exista: buscar en él es inmediato aunque haya 20.000 artículos.
 */
const indicesExactos = new WeakMap<Article[], Map<string, Article[]>>();

function indiceExacto(articles: Article[]): Map<string, Article[]> {
  let indice = indicesExactos.get(articles);
  if (!indice) {
    const nuevo = new Map<string, Article[]>();
    const sumar = (clave: string, a: Article) => {
      const lista = nuevo.get(clave);
      if (lista) lista.push(a);
      else nuevo.set(clave, [a]);
    };
    for (const a of articles) {
      sumar('c:' + a.code.trim().toUpperCase(), a);
      if (a.factoryCode) {
        const f = normalizar(a.factoryCode);
        if (f) sumar('f:' + f, a);
      }
      const d = normalizarBusqueda(a.description);
      if (d) sumar('d:' + d, a);
    }
    indicesExactos.set(articles, nuevo);
    indice = nuevo;
  }
  return indice;
}

export function articulosExactos(articles: Article[], termino: string): Article[] {
  const t = termino.trim();
  if (t === '') return [];
  const indice = indiceExacto(articles);
  const vistos = new Set<string>();
  const resultado: Article[] = [];
  for (const clave of ['c:' + t.toUpperCase(), 'f:' + normalizar(t), 'd:' + normalizarBusqueda(t)]) {
    if (clave.length <= 2) continue;
    for (const a of indice.get(clave) ?? []) {
      if (!vistos.has(a.id)) {
        vistos.add(a.id);
        resultado.push(a);
      }
    }
  }
  return resultado;
}

/**
 * Lo que muestran los buscadores de artículos, en orden de relevancia: los
 * que coinciden exacto, después los que EMPIEZAN con lo escrito (en nuestro
 * código, el de fábrica o la descripción) y al final el resto de los que lo
 * contienen.
 *
 * Sin este orden, los resultados salían por código: los artículos propios
 * con código de letras (ZRICR200 - REPARACION INYECTOR CR) quedaban al fondo,
 * detrás de cientos de inyectores numerados, y no entraban en la lista.
 */
export function buscarArticulos(articles: Article[], termino: string): Article[] {
  if (termino.trim() === '') return articles;
  const exactos = articulosExactos(articles, termino);
  const ids = new Set(exactos.map((a) => a.id));
  const codigo = termino.trim().toUpperCase();
  const fabrica = normalizar(termino);
  const descripcion = normalizarBusqueda(termino);
  const empiezan: Article[] = [];
  const contienen: Article[] = [];
  for (const a of filtrarArticulos(articles, termino)) {
    if (ids.has(a.id)) continue;
    const clave = claveDeBusqueda(a);
    const empieza =
      a.code.toUpperCase().startsWith(codigo) ||
      (fabrica !== '' && clave.fabrica.startsWith(fabrica)) ||
      (descripcion !== '' && clave.descripcion.startsWith(descripcion));
    (empieza ? empiezan : contienen).push(a);
  }
  return [...exactos, ...empiezan, ...contienen];
}
