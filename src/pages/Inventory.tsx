import React from 'react';
import { Plus, Pencil, Trash2, X, Search, PackageX, Star, Factory } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
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

const EMPTY_FORM: ArticleInput = {
  code: '',
  description: '',
  brand: null,
  tracksStock: false,
  stockQuantity: 0,
  active: true,
  markupPercent: null,
  unitPrice: 0,
};

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
    <div className="max-w-7xl mx-auto space-y-6">
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

function ArticleModal({
  article,
  suppliers,
  defaultMarkup,
  onClose,
  onSaved,
}: {
  article: Article | null;
  suppliers: Supplier[];
  defaultMarkup: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<ArticleInput>(
    article
      ? {
          code: article.code,
          description: article.description,
          brand: article.brand,
          tracksStock: article.tracksStock,
          stockQuantity: article.stockQuantity,
          active: article.active,
          markupPercent: article.markupPercent,
          unitPrice: article.unitPrice,
        }
      : EMPTY_FORM
  );
  const [links, setLinks] = React.useState<ArticleSupplier[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadLinks = React.useCallback(async () => {
    if (!article) return;
    try {
      setLinks(await fetchArticleSuppliers(article.id));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [article]);

  React.useEffect(() => { loadLinks(); }, [loadLinks]);

  const preferred = links.find((l) => l.isPreferred) ?? null;
  const effectiveMarkup = form.markupPercent ?? defaultMarkup;
  const previewSalePrice = preferred
    ? computeSalePrice(preferred.purchasePrice, effectiveMarkup)
    : null;

  function patch(changes: Partial<ArticleInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code.trim() || !form.description.trim()) {
      setError('Código y descripción son obligatorios.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (article) await updateArticle(article.id, form);
      else await createArticle(form);
      onSaved();
    } catch (err) {
      setError(describePriceError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  const labelClass = 'text-xs font-bold uppercase tracking-wider text-text-soft';
  const inputClass = 'mt-1 w-full border border-line px-3 py-2 text-sm font-normal normal-case';

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">
            {article ? `Editar ${article.code}` : 'Nuevo artículo'}
          </h2>
          <button onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5 overflow-y-auto">
          {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

          {/* Identificación */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
            <label className={cn(labelClass, 'col-span-2')}>
              Nuestro código
              <input value={form.code} onChange={(e) => patch({ code: e.target.value })} className={cn(inputClass, 'font-mono')} placeholder="BOS-093" />
            </label>
            <label className={cn(labelClass, 'col-span-2')}>
              Descripción
              <input value={form.description} onChange={(e) => patch({ description: e.target.value })} className={inputClass} placeholder="Tobera Inyector Common Rail" />
            </label>
            <label className={cn(labelClass, 'col-span-2')}>
              Marca
              <input
                value={form.brand ?? ''}
                onChange={(e) => patch({ brand: e.target.value.trim() === '' ? null : e.target.value })}
                className={inputClass}
                placeholder="DENSO"
              />
            </label>
          </div>

          {/* Precios */}
          <div className="border-t border-line pt-4 space-y-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep">Precio de venta</h3>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-6 sm:items-start">
              <label className={cn(labelClass, 'col-span-2')}>
                Utilidad %
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.markupPercent ?? ''}
                  onChange={(e) => patch({ markupPercent: e.target.value === '' ? null : Number(e.target.value) })}
                  className={cn(inputClass, 'text-right')}
                  placeholder={`${defaultMarkup} (global)`}
                />
                <span className="block mt-1 text-[10px] font-normal normal-case text-text-soft">
                  Vacío = usa el global ({defaultMarkup}%)
                </span>
              </label>

              {preferred ? (
                <div className="col-span-4 bg-panel-alt border border-line p-3 text-sm">
                  <div className="flex justify-between text-xs text-text-soft">
                    <span>Precio de compra ({preferred.supplierName}):</span>
                    <span className="text-text">$ {preferred.purchasePrice.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-text-soft mt-1">
                    <span>+ Utilidad {effectiveMarkup}%:</span>
                    <span className="text-text">
                      $ {(previewSalePrice! - preferred.purchasePrice).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-line pt-2 mt-2">
                    <span className="font-bold text-[11px] uppercase tracking-wider text-text">Precio de venta:</span>
                    <span className="text-base font-bold text-accent-deep">$ {previewSalePrice!.toFixed(2)}</span>
                  </div>
                </div>
              ) : (
                <label className={cn(labelClass, 'col-span-4')}>
                  Precio de venta (manual)
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.unitPrice}
                    onChange={(e) => patch({ unitPrice: Number(e.target.value) })}
                    className={cn(inputClass, 'text-right')}
                  />
                  <span className="block mt-1 text-[10px] font-normal normal-case text-text-soft">
                    Sin proveedor preferido no hay precio de compra del que calcularlo (ej. mano de obra).
                  </span>
                </label>
              )}
            </div>
          </div>

          {/* Stock */}
          <div className="border-t border-line pt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
              <input type="checkbox" checked={form.tracksStock} onChange={(e) => patch({ tracksStock: e.target.checked })} className="w-4 h-4 accent-accent-deep" />
              Controlar stock de este artículo
            </label>

            {form.tracksStock ? (
              <label className={cn(labelClass, 'block max-w-[200px]')}>
                Cantidad en stock
                <input type="number" step="1" min="0" value={form.stockQuantity} onChange={(e) => patch({ stockQuantity: Number(e.target.value) })} className={cn(inputClass, 'text-right')} />
              </label>
            ) : (
              <p className="text-xs text-text-soft flex items-center gap-1.5">
                <PackageX size={14} />
                Sin control de stock (ej. mano de obra, servicios).
              </p>
            )}

            <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
              <input type="checkbox" checked={form.active} onChange={(e) => patch({ active: e.target.checked })} className="w-4 h-4 accent-accent-deep" />
              Activo (disponible para cargar en cotizaciones y OT)
            </label>
          </div>

          {/* Proveedores: solo al editar, necesitan un artículo existente */}
          {article && (
            <SuppliersSection
              articleId={article.id}
              links={links}
              suppliers={suppliers}
              onChanged={loadLinks}
            />
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <button type="button" onClick={onClose} className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt">
              Cerrar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-accent text-accent-ink font-semibold text-[11px] uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
            >
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Códigos y precios de compra por proveedor. El código del proveedor es lo que
 * permite reconocer el artículo al importar su Excel.
 */
function SuppliersSection({
  articleId,
  links,
  suppliers,
  onChanged,
}: {
  articleId: string;
  links: ArticleSupplier[];
  suppliers: Supplier[];
  onChanged: () => void;
}) {
  const [supplierId, setSupplierId] = React.useState('');
  const [code, setCode] = React.useState('');
  const [price, setPrice] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const available = suppliers.filter((s) => !links.some((l) => l.supplierId === s.id));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(describePriceError(getErrorMessage(err)));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    if (!supplierId) { setError('Elegí un proveedor.'); return; }
    if (!code.trim()) { setError('Cargá el código con el que el proveedor identifica el artículo.'); return; }
    await run(async () => {
      await addArticleSupplier(
        articleId,
        { supplierId, supplierCode: code, purchasePrice: Number(price || 0) },
        links.length === 0 // el primero queda como preferido
      );
      setSupplierId('');
      setCode('');
      setPrice('');
    });
  }

  return (
    <div className="border-t border-line pt-4 space-y-3">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
        <Factory size={14} /> Proveedores y precios de compra
      </h3>
      <p className="text-[11px] text-text-soft">
        Cada proveedor usa su propio código. Ese código es el que permite reconocer el artículo
        al importar su lista de precios. La estrella marca el proveedor cuyo precio define la venta.
      </p>

      {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

      {links.length === 0 ? (
        <p className="text-xs text-text-soft">Este artículo todavía no tiene proveedores vinculados.</p>
      ) : (
        <ul className="space-y-1">
          {links.map((link) => (
            <li key={link.id} className="grid grid-cols-12 gap-2 items-center bg-panel-alt border border-line px-2 py-2">
              <button
                type="button"
                title={link.isPreferred ? 'Proveedor preferido' : 'Marcar como preferido'}
                onClick={() => !link.isPreferred && run(() => setPreferredSupplier(articleId, link.supplierId))}
                disabled={busy}
                className={cn(
                  'col-span-1 flex justify-center',
                  link.isPreferred ? 'text-accent' : 'text-text-faint hover:text-accent-deep'
                )}
              >
                <Star size={18} fill={link.isPreferred ? 'currentColor' : 'none'} />
              </button>
              <span className="col-span-4 text-sm font-semibold text-text truncate" title={link.supplierName}>
                {link.supplierName}
              </span>
              <input
                defaultValue={link.supplierCode}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== link.supplierCode) {
                    run(() => updateArticleSupplier(link.id, { supplierCode: value, purchasePrice: link.purchasePrice }));
                  }
                }}
                title="Código del proveedor"
                className="col-span-3 border border-line px-2 py-1 text-xs font-mono"
              />
              <input
                type="number"
                step="0.01"
                min="0"
                defaultValue={link.purchasePrice}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value !== link.purchasePrice) {
                    run(() => updateArticleSupplier(link.id, { supplierCode: link.supplierCode, purchasePrice: value }));
                  }
                }}
                title="Precio de compra"
                className="col-span-3 border border-line px-2 py-1 text-xs text-right"
              />
              <button
                type="button"
                onClick={() => run(() => removeArticleSupplier(link.id))}
                disabled={busy}
                title="Desvincular"
                className="col-span-1 flex justify-center text-text-soft hover:text-danger"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-12 sm:items-center">
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="col-span-5 border border-line px-2 py-2 text-sm bg-panel"
          >
            <option value="">Agregar proveedor...</option>
            {available.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Código proveedor"
            className="col-span-3 border border-line px-2 py-2 text-xs font-mono"
          />
          <input
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="P. compra"
            className="col-span-3 border border-line px-2 py-2 text-xs text-right"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy}
            title="Vincular proveedor"
            className="col-span-1 bg-accent text-accent-ink h-[38px] flex items-center justify-center hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
          >
            <Plus size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
