import React from 'react';
import { Plus, Trash2, Package, Search, X, Check, PackagePlus } from 'lucide-react';
import { ArticleModal } from '@/src/components/ArticleModal';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { fetchDefaultMarkup } from '@/src/lib/priceLists';
import { cn, formatMoney } from '@/src/lib/utils';
import { Button, SectionHeader } from '@/src/components/ui';
import { type Article } from '@/src/lib/articles';
import type { WorkOrderItemInput } from '@/src/lib/workOrders';

const IVA_RATE = 0.21;

/**
 * Editor de renglones compartido por órdenes de trabajo y cotizaciones:
 * ambas se cargan igual (artículos del catálogo o líneas manuales).
 * Con `editable` en false se muestra en solo lectura.
 */
export function ItemsEditor({
  items,
  onChange,
  articles,
  editable,
  title = 'Renglones',
  totals,
}: {
  items: WorkOrderItemInput[];
  onChange: (items: WorkOrderItemInput[]) => void;
  articles: Article[];
  editable: boolean;
  title?: string;
  /**
   * Reemplaza el cuadro de totales. Lo usa la facturación, donde el IVA
   * depende de la letra del comprobante: en una factura C es cero y en una B
   * no se discrimina, así que el 21% fijo de acá no sirve.
   */
  totals?: React.ReactNode;
}) {
  const [showPicker, setShowPicker] = React.useState(false);
  // Artículos creados al vuelo desde el buscador: el catálogo que llega por
  // prop no se refresca solo, así que se suman acá para que aparezcan de
  // inmediato en la misma sesión de carga.
  const [extraArticles, setExtraArticles] = React.useState<Article[]>([]);
  const allArticles = React.useMemo(() => [...articles, ...extraArticles], [articles, extraArticles]);

  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const iva = total * IVA_RATE;

  function updateItem(index: number, patch: Partial<WorkOrderItemInput>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function addManualItem() {
    onChange([...items, { articleId: null, code: '', description: '', quantity: 1, unitPrice: 0 }]);
  }

  function addArticle(article: Article) {
    onChange([
      ...items,
      {
        articleId: article.id,
        code: article.code,
        description: article.description,
        quantity: 1,
        unitPrice: article.unitPrice,
      },
    ]);
  }

  function handleArticleCreated(article: Article) {
    setExtraArticles((current) => [...current, article]);
    addArticle(article);
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title={title}
        actions={
          editable && (
            <>
              <Button type="button" onClick={() => setShowPicker(true)} className="px-3">
                <Package size={16} /> Agregar artículo
              </Button>
              <Button type="button" variant="ghost" onClick={addManualItem} className="px-3">
                <Plus size={16} /> Línea manual
              </Button>
            </>
          )
        }
      />

      <div className="overflow-x-auto overflow-y-hidden rounded-md border border-line">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-3 py-1 w-24">Código</th>
              <th className="px-3 py-1">Descripción</th>
              <th className="px-3 py-1 w-24 text-right">Cant.</th>
              <th className="px-3 py-1 w-32 text-right">Precio Unit.</th>
              <th className="px-3 py-1 w-32 text-right">Subtotal</th>
              {editable && <th className="px-3 py-1 w-12"></th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={editable ? 6 : 5} className="px-3 py-4 text-center text-text-soft">
                  Sin renglones cargados.
                </td>
              </tr>
            )}
            {items.map((item, idx) => (
              <tr key={idx} className={cn(
                "h-9 border-b border-line transition-colors",
                idx % 2 === 0 ? "bg-panel-alt" : "bg-panel"
              )}>
                {editable ? (
                  <>
                    {item.articleId ? (
                      <>
                        {/* Renglón de catálogo: código y descripción vienen del artículo */}
                        <td data-primary className="px-3 py-1 font-mono font-semibold text-text-soft">
                          <span className="inline-flex items-center gap-1.5">
                            <Package size={12} className="text-accent-deep" />
                            {item.code}
                          </span>
                        </td>
                        <td data-label="Descripción" className="px-3 py-1">{item.description}</td>
                      </>
                    ) : (
                      <>
                        <td data-label="Cant." className="px-1 py-1">
                          <input value={item.code} onChange={(e) => updateItem(idx, { code: e.target.value })} placeholder="Código" className="w-full bg-transparent px-2 py-1 text-text-soft" />
                        </td>
                        <td data-label="P. unit." className="px-1 py-1">
                          <input value={item.description} onChange={(e) => updateItem(idx, { description: e.target.value })} placeholder="Descripción" className="w-full bg-transparent px-2 py-1" />
                        </td>
                      </>
                    )}
                    <td data-label="Cant." className="px-1 py-1">
                      <input type="number" step="0.01" min="0" value={item.quantity} onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })} className="w-full bg-transparent px-2 py-1 text-right" />
                    </td>
                    <td data-label="P. unit." className="px-1 py-1">
                      <input type="number" step="0.01" min="0" value={item.unitPrice} onChange={(e) => updateItem(idx, { unitPrice: Number(e.target.value) })} className="w-full bg-transparent px-2 py-1 text-right" />
                    </td>
                  </>
                ) : (
                  <>
                    <td data-primary className="px-3 py-1 text-text-soft">{item.code}</td>
                    <td data-label="Descripción" className="px-3 py-1">{item.description}</td>
                    <td data-label="Cant." className="px-3 py-1 text-right">{item.quantity.toFixed(2)}</td>
                    <td data-label="P. unit." className="px-3 py-1 text-right">$ {formatMoney(item.unitPrice)}</td>
                  </>
                )}
                <td data-label="Subtotal" className="px-3 py-1 text-right font-bold">$ {formatMoney(item.quantity * item.unitPrice)}</td>
                {editable && (
                  <td className="px-3 py-1 text-center">
                    <button type="button" onClick={() => removeItem(idx)} aria-label="Quitar renglón" className="text-text-soft transition-colors hover:text-danger">
                      <Trash2 size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot className="h-10 border-t-2 border-line-strong bg-panel-head">
            <tr>
              <td className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft" colSpan={4}>
                Total neto
              </td>
              <td className="px-3 py-2 text-right font-display text-lg font-medium text-text">
                $ {formatMoney(total)}
              </td>
              {editable && <td></td>}
            </tr>
          </tfoot>
        </table>
      </div>

      {totals ?? (
        <div className="flex justify-end">
          <div className="w-full space-y-2 border border-line bg-panel-alt p-4 md:w-1/3">
            <div className="flex justify-between text-xs text-text-soft">
              <span>Subtotal</span>
              <span className="text-text">$ {formatMoney(total)}</span>
            </div>
            <div className="flex justify-between text-xs text-text-soft">
              <span>IVA 21%</span>
              <span className="text-text">$ {formatMoney(iva)}</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</span>
              <span className="font-display text-2xl font-medium text-text">
                $ {formatMoney(total + iva)}
              </span>
            </div>
          </div>
        </div>
      )}

      {showPicker && (
        <ArticlePicker
          articles={allArticles}
          onPick={addArticle}
          onArticleCreated={handleArticleCreated}
          onClose={() => setShowPicker(false)}
          addedCount={items.length}
        />
      )}
    </div>
  );
}

function ArticlePicker({
  articles,
  onPick,
  onArticleCreated,
  onClose,
  addedCount,
}: {
  articles: Article[];
  onPick: (article: Article) => void;
  onArticleCreated: (article: Article) => void;
  onClose: () => void;
  addedCount: number;
}) {
  const [search, setSearch] = React.useState('');
  const [justAdded, setJustAdded] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return articles;
    return articles.filter(
      (a) => a.code.toLowerCase().includes(term) || a.description.toLowerCase().includes(term)
    );
  }, [articles, search]);

  // No se cierra al elegir: se puede seguir cargando renglones sin volver a
  // abrir la ventana. Se limpia la búsqueda y vuelve el foco, como si el
  // artículo elegido ya "saliera de la lista" para pasar al siguiente.
  function handlePick(article: Article) {
    onPick(article);
    setJustAdded(article.description);
    setSearch('');
    searchRef.current?.focus();
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-2xl flex flex-col max-h-[80vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">Agregar artículos del catálogo</h2>
          <button type="button" onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 pb-3 space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
              <input
                ref={searchRef}
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por código o descripción..."
                className="w-full h-9 pl-9 pr-3 border border-line text-sm"
              />
            </div>
            <NewArticleToggle onCreated={(article) => {
              onArticleCreated(article);
              setJustAdded(article.description);
            }} />
          </div>
          {justAdded && (
            <p className="flex items-center gap-1.5 text-xs text-state-done">
              <Check size={13} /> Se agregó "{justAdded}". Podés seguir eligiendo.
            </p>
          )}
        </div>

        <div className="overflow-y-auto px-5 pb-5">
          <table className="table-stack w-full text-left text-[12px]">
            <thead className="text-text-soft border-b border-line bg-panel-alt sticky top-0">
              <tr>
                <th className="p-2 font-bold w-28">Código</th>
                <th className="p-2 font-bold">Descripción</th>
                <th className="p-2 font-bold w-28 text-right">Precio</th>
                <th className="p-2 font-bold w-24 text-center">Stock</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-text-soft">
                    {articles.length === 0
                      ? 'No hay artículos activos en el catálogo. Creá uno con "+ Nuevo artículo", arriba.'
                      : 'Ningún artículo coincide con la búsqueda.'}
                  </td>
                </tr>
              )}
              {filtered.map((article) => (
                <tr
                  key={article.id}
                  onClick={() => handlePick(article)}
                  className="border-b border-line transition-colors hover:bg-panel-alt cursor-pointer"
                >
                  <td data-primary className="p-2 font-bold">{article.code}</td>
                  <td data-label="Descripción" className="p-2">{article.description}</td>
                  <td data-label="Precio" className="p-2 text-right">$ {formatMoney(article.unitPrice)}</td>
                  <td data-label="Stock" className="p-2 text-center">
                    {article.tracksStock ? (
                      <span className={cn(
                        "px-2 py-0.5 text-[10px] font-bold",
                        article.stockQuantity === 0 ? "bg-red-100 text-danger"
                          : article.stockQuantity <= 5 ? "bg-orange-100 text-orange-700"
                          : "bg-green-100 text-green-700"
                      )}>
                        {article.stockQuantity === 0 ? 'Sin stock' : article.stockQuantity}
                      </span>
                    ) : (
                      <span className="text-text-faint text-[10px] uppercase tracking-wider">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <span className="text-xs text-text-soft">
            {addedCount > 0 ? `${addedCount} renglón${addedCount === 1 ? '' : 'es'} cargado${addedCount === 1 ? '' : 's'}` : 'Sin renglones todavía'}
          </span>
          <Button type="button" onClick={onClose} className="px-4">Listo</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Alta de un artículo sin salir de la orden o la cotización.
 *
 * Abre la MISMA ficha que Inventario, no una versión reducida. Antes acá se
 * pedían solo código, descripción y precio, y el artículo nacía sin marca, sin
 * stock y sin proveedor: quien lo cargaba en el apuro de una recepción no
 * volvía después a completarlo, y el catálogo se llenaba de fichas a medias.
 */
function NewArticleToggle({ onCreated }: { onCreated: (article: Article) => void }) {
  const [open, setOpen] = React.useState(false);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [defaultMarkup, setDefaultMarkup] = React.useState(0);

  React.useEffect(() => {
    if (!open) return;
    // Proveedores y utilidad por defecto son ayudas del formulario: si fallan,
    // el artículo se carga igual, solo que sin la vinculación ni el precio
    // sugerido.
    fetchSuppliers(true).then(setSuppliers).catch(() => {});
    fetchDefaultMarkup().then(setDefaultMarkup).catch(() => {});
  }, [open]);

  return (
    <>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)} className="px-3 whitespace-nowrap">
        <PackagePlus size={16} /> Nuevo artículo
      </Button>

      {open && (
        <ArticleModal
          article={null}
          suppliers={suppliers}
          defaultMarkup={defaultMarkup}
          onClose={() => setOpen(false)}
          onSaved={(article) => {
            setOpen(false);
            onCreated(article);
          }}
        />
      )}
    </>
  );
}
