import React from 'react';
import { Plus, Trash2, Package, Search, X } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import { Button, SectionHeader } from '@/src/components/ui';
import type { Article } from '@/src/lib/articles';
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
    setShowPicker(false);
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

      <div className="overflow-x-auto border border-line">
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
        <ArticlePicker articles={articles} onPick={addArticle} onClose={() => setShowPicker(false)} />
      )}
    </div>
  );
}

function ArticlePicker({
  articles,
  onPick,
  onClose,
}: {
  articles: Article[];
  onPick: (article: Article) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return articles;
    return articles.filter(
      (a) => a.code.toLowerCase().includes(term) || a.description.toLowerCase().includes(term)
    );
  }, [articles, search]);

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-2xl flex flex-col max-h-[80vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">Agregar artículo del catálogo</h2>
          <button type="button" onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 pb-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por código o descripción..."
              className="w-full h-9 pl-9 pr-3 border border-line text-sm"
            />
          </div>
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
                      ? 'No hay artículos activos en el catálogo. Cargalos desde Inventario.'
                      : 'Ningún artículo coincide con la búsqueda.'}
                  </td>
                </tr>
              )}
              {filtered.map((article) => (
                <tr
                  key={article.id}
                  onClick={() => onPick(article)}
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
      </div>
    </div>
  );
}
