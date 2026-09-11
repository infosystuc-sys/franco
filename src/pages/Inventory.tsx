import React from 'react';
import { Plus, Pencil, Trash2, X, Search, PackageX, Star, Factory } from 'lucide-react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  computeSalePrice,
  createArticle,
  deleteArticle,
  fetchArticles,
  updateArticle,
  type Article,
  type ArticleInput,
} from '@/src/lib/articles';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { ArticleModal } from '@/src/components/ArticleModal';
import {
  addArticleSupplier,
  describePriceError,
  fetchArticleSuppliers,
  fetchDefaultMarkup,
  removeArticleSupplier,
  setPreferredSupplier,
  updateArticleSupplier,
  type ArticleSupplier,
} from '@/src/lib/priceLists';


export function Inventory() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [articles, setArticles] = React.useState<Article[]>([]);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [defaultMarkup, setDefaultMarkup] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<Article | 'new' | null>(null);
  // El "+" del menu entra con ?nuevo=1 y abre el alta directo. Se limpia el
  // parametro para que recargar la pagina no vuelva a abrir el modal.
  const [searchParams, setSearchParams] = useSearchParams();
  React.useEffect(() => {
    if (searchParams.get('nuevo') !== '1') return;
    setEditing('new');
    setSearchParams((actuales) => {
      const proximos = new URLSearchParams(actuales);
      proximos.delete('nuevo');
      return proximos;
    }, { replace: true });
  }, [searchParams, setSearchParams]);


  const loadArticles = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [articleRows, supplierRows, markup] = await Promise.all([
        fetchArticles(),
        fetchSuppliers(true),
        fetchDefaultMarkup(),
      ]);
      setArticles(articleRows);
      setSuppliers(supplierRows);
      setDefaultMarkup(markup);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadArticles();
  }, [isAdmin, loadArticles]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return articles;
    return articles.filter((a) =>
      [a.code, a.description, a.preferredSupplierName, a.preferredSupplierCode]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term))
    );
  }, [articles, search]);

  async function handleDelete(article: Article) {
    if (!window.confirm(`¿Eliminar el artículo ${article.code}?`)) return;
    setError(null);
    try {
      await deleteArticle(article.id);
      loadArticles();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-[1600px] mx-auto space-y-6">
      <PageHeader
        title="Inventario"
        subtitle="El precio de venta sale del precio de compra del proveedor preferido más la utilidad."
        actions={
          <>
            <Link to="/listas-precios">
              <Button variant="ghost" type="button">
                <Factory size={16} /> Listas de precios
              </Button>
            </Link>
            <Button onClick={() => setEditing('new')}>
              <Plus size={16} /> Nuevo artículo
            </Button>
          </>
        }
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="relative max-w-sm flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por código, descripción, proveedor..."
            className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>
        <span className="text-[11px] text-text-soft">
          Utilidad por defecto: <strong className="text-accent-deep">{defaultMarkup}%</strong>
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="p-3 font-semibold w-28">Código</th>
                <th className="p-3 font-semibold">Descripción</th>
                <th className="p-3 font-semibold w-44">Proveedor preferido</th>
                <th className="p-3 font-semibold w-28 text-right">P. Compra</th>
                <th className="p-3 font-semibold w-20 text-right">Util.</th>
                <th className="p-3 font-semibold w-28 text-right">P. Venta</th>
                <th className="p-3 font-semibold w-24 text-center">Stock</th>
                <th className="p-3 font-semibold w-24 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="p-6 text-center text-text-soft">Cargando...</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-text-soft">
                    {search ? 'Ningún artículo coincide con la búsqueda.' : 'No hay artículos cargados.'}
                  </td>
                </tr>
              )}
              {filtered.map((article) => (
                <tr key={article.id} className={cn(
                  "border-b border-line hover:bg-panel-alt transition-colors",
                  !article.active && "opacity-55"
                )}>
                  <td data-primary className="p-3 font-semibold">{article.code}</td>
                  <td data-label="Descripción" className="p-3">
                    {article.description}
                    {article.brand && (
                      <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-text-soft">{article.brand}</span>
                    )}
                    {!article.active && (
                      <span className="ml-2 text-[9px] font-bold uppercase tracking-wider text-text-faint">Inactivo</span>
                    )}
                  </td>
                  <td data-label="Proveedor" className="p-3 text-[11px]">
                    {article.preferredSupplierName ? (
                      <>
                        <div className="text-text">{article.preferredSupplierName}</div>
                        <div className="text-text-soft font-mono">{article.preferredSupplierCode}</div>
                        {article.supplierCount > 1 && (
                          <div className="text-[10px] text-accent-deep">
                            +{article.supplierCount - 1} proveedor{article.supplierCount > 2 ? 'es' : ''} más
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-text-faint">Sin asignar</span>
                    )}
                  </td>
                  <td data-label="P. compra" className="p-3 text-right text-text-soft">
                    {article.purchasePrice === null
                      ? <span className="text-text-faint">—</span>
                      : `$ ${article.purchasePrice.toFixed(2)}`}
                  </td>
                  <td data-label="Utilidad" className="p-3 text-right">
                    {article.markupPercent === null ? (
                      <span className="text-text-faint" title={`Usa el global (${defaultMarkup}%)`}>
                        {defaultMarkup}%*
                      </span>
                    ) : (
                      `${article.markupPercent}%`
                    )}
                  </td>
                  <td data-label="P. venta" className="p-3 text-right font-bold text-accent-deep">$ {article.unitPrice.toFixed(2)}</td>
                  <td data-label="Stock" className="p-3 text-center">
                    {article.tracksStock ? (
                      <span className={cn(
                        "px-2 py-0.5 text-[10px] font-bold",
                        article.stockQuantity === 0 ? "bg-red-100 text-danger"
                          : article.stockQuantity <= 5 ? "bg-orange-100 text-orange-700"
                          : "bg-green-100 text-green-700"
                      )}>
                        {article.stockQuantity}
                      </span>
                    ) : (
                      <span className="text-text-faint text-[10px] uppercase tracking-wider">Sin control</span>
                    )}
                  </td>
                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => setEditing(article)} title="Editar" className="text-text-soft hover:text-text p-1">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(article)} title="Eliminar" className="text-text-soft hover:text-danger p-1">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[11px] text-text-soft">
        * Utilidad heredada del valor global. Se cambia desde Listas de precios.
      </p>

      {editing && (
        <ArticleModal
          article={editing === 'new' ? null : editing}
          suppliers={suppliers}
          defaultMarkup={defaultMarkup}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadArticles();
          }}
        />
      )}
    </div>
  );
}
