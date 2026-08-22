import React from 'react';
import { Search, X } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import type { Article } from '@/src/lib/articles';

/**
 * Buscador de artículos para cargar una compra.
 *
 * No reutiliza el de ItemsEditor a propósito: aquél muestra el precio de
 * VENTA, que es lo que importa al armar una orden. Acá lo que se necesita
 * saber antes de elegir es a cuánto se venía comprando y cuánto stock queda
 * —para detectar un aumento raro o una compra que no hacía falta—, así que
 * las columnas son otras.
 */
export function PurchaseArticlePicker({
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-bold text-text">Agregar artículo a la compra</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
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
              placeholder="Buscar por código o descripción…"
              className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
            />
          </div>
        </div>

        <div className="overflow-y-auto px-5 pb-5">
          <table className="table-stack w-full text-left text-[12px]">
            <thead className="sticky top-0 border-b border-line bg-panel-alt text-text-soft">
              <tr>
                <th className="w-28 p-2 font-bold">Código</th>
                <th className="p-2 font-bold">Descripción</th>
                <th className="w-28 p-2 text-right font-bold">Últ. compra</th>
                <th className="w-20 p-2 text-center font-bold">Stock</th>
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
                  className="cursor-pointer border-b border-line transition-colors hover:bg-panel-alt"
                >
                  <td data-primary className="p-2 font-bold">{article.code}</td>
                  <td data-label="Descripción" className="p-2">
                    {article.description}
                    {article.preferredSupplierName && (
                      <span className="block text-[10px] text-text-faint">
                        Preferido: {article.preferredSupplierName}
                      </span>
                    )}
                  </td>
                  <td data-label="Últ. compra" className="p-2 text-right">
                    {article.purchasePrice === null ? (
                      <span className="text-text-faint">sin precio</span>
                    ) : (
                      `$ ${formatMoney(article.purchasePrice)}`
                    )}
                  </td>
                  <td data-label="Stock" className="p-2 text-center">
                    {article.tracksStock ? (
                      <span
                        className={cn(
                          'px-2 py-0.5 text-[10px] font-bold',
                          article.stockQuantity === 0
                            ? 'bg-red-100 text-danger'
                            : article.stockQuantity <= 5
                              ? 'bg-orange-100 text-orange-700'
                              : 'bg-green-100 text-green-700'
                        )}
                      >
                        {article.stockQuantity === 0 ? 'Sin stock' : article.stockQuantity}
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wider text-text-faint">
                        no controla
                      </span>
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
