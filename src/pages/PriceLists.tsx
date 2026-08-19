import React from 'react';
import {
  Upload,
  Download,
  Link2,
  Trash2,
  Search,
  AlertTriangle,
  CheckCircle2,
  Percent,
  History,
  X,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { downloadTemplate, ExcelFormatError, parsePriceListFile, type ParsedSheet } from '@/src/lib/excelImport';
import {
  describePriceError,
  discardUnmatchedPrice,
  fetchDefaultMarkup,
  fetchPriceImports,
  fetchUnmatchedPrices,
  importSupplierPrices,
  linkUnmatchedPrice,
  updateDefaultMarkup,
  type ImportResult,
  type PriceImport,
  type UnmatchedPrice,
} from '@/src/lib/priceLists';

export function PriceLists() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [unmatched, setUnmatched] = React.useState<UnmatchedPrice[]>([]);
  const [imports, setImports] = React.useState<PriceImport[]>([]);
  const [markup, setMarkup] = React.useState(0);
  const [markupDraft, setMarkupDraft] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const loadAll = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [supplierRows, articleRows, unmatchedRows, importRows, defaultMarkup] = await Promise.all([
        fetchSuppliers(true),
        fetchArticles(),
        fetchUnmatchedPrices(),
        fetchPriceImports(),
        fetchDefaultMarkup(),
      ]);
      setSuppliers(supplierRows);
      setArticles(articleRows);
      setUnmatched(unmatchedRows);
      setImports(importRows);
      setMarkup(defaultMarkup);
      setMarkupDraft(String(defaultMarkup));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadAll();
  }, [isAdmin, loadAll]);

  async function handleSaveMarkup() {
    const value = Number(markupDraft);
    if (!Number.isFinite(value) || value < 0) {
      setError('La utilidad debe ser un número mayor o igual a 0.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateDefaultMarkup(value);
      setNotice(
        `Utilidad global actualizada a ${value}%. Se recalcularon ${updated} precio(s) de venta ` +
        'de los artículos que heredan este valor.'
      );
      await loadAll();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Listas de precios"
        subtitle="Importá la lista de compra de cada proveedor. El precio de venta se recalcula solo."
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}
      {notice && (
        <div className="bg-panel-alt border border-state-done/40 text-state-done text-sm px-4 py-3 flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* Utilidad global */}
      <section className="bg-panel border border-line p-5 space-y-3">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
          <Percent size={14} /> Utilidad por defecto
        </h2>
        <p className="text-xs text-text-soft">
          Se aplica a los artículos que no tienen una utilidad propia cargada.
          Al cambiarla se recalculan sus precios de venta.
        </p>
        <div className="flex items-end gap-2">
          <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
            Porcentaje
            <div className="mt-1 flex items-center">
              <input
                type="number"
                step="0.01"
                min="0"
                value={markupDraft}
                onChange={(e) => setMarkupDraft(e.target.value)}
                className="w-28 border border-line px-3 py-2 text-sm text-right"
              />
              <span className="bg-panel-head border border-l-0 border-line px-3 py-2 text-sm text-text-soft">%</span>
            </div>
          </label>
          <button
            onClick={handleSaveMarkup}
            disabled={busy || Number(markupDraft) === markup}
            className="bg-accent-deep text-white text-[11px] font-bold uppercase tracking-wider px-4 py-2 hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {busy ? 'Aplicando...' : 'Guardar y recalcular'}
          </button>
        </div>
      </section>

      {/* Importación */}
      <ImportSection
        suppliers={suppliers}
        onImported={async (result, supplierName) => {
          setNotice(
            `Lista de ${supplierName} importada: ${result.matchedRows} precio(s) actualizado(s)` +
            (result.unmatchedRows > 0
              ? ` y ${result.unmatchedRows} código(s) sin vincular, más abajo.`
              : '. Todos los códigos estaban vinculados.')
          );
          setError(null);
          await loadAll();
        }}
        onError={(message) => { setError(message); setNotice(null); }}
      />

      {/* Pendientes de vincular */}
      <UnmatchedSection
        rows={unmatched}
        articles={articles}
        loading={loading}
        onChanged={loadAll}
        onError={setError}
      />

      {/* Historial */}
      <section className="border border-line bg-panel">
        <div className="p-4 border-b border-line bg-panel-head">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
            <History size={14} /> Últimas importaciones
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="p-3 font-semibold w-40">Fecha</th>
                <th className="p-3 font-semibold">Proveedor</th>
                <th className="p-3 font-semibold">Archivo</th>
                <th className="p-3 font-semibold w-24 text-right">Filas</th>
                <th className="p-3 font-semibold w-28 text-right">Actualizadas</th>
                <th className="p-3 font-semibold w-28 text-right">Sin vincular</th>
              </tr>
            </thead>
            <tbody>
              {imports.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-text-soft">Todavía no se importó ninguna lista.</td></tr>
              )}
              {imports.map((row) => (
                <tr key={row.id} className="border-b border-line">
                  <td data-primary className="p-3">{new Date(row.importedAt).toLocaleString('es-AR')}</td>
                  <td data-label="Proveedor" className="p-3 font-semibold">{row.supplierName}</td>
                  <td data-label="Archivo" className="p-3 text-text-soft">{row.fileName ?? '—'}</td>
                  <td data-label="Filas" className="p-3 text-right">{row.totalRows}</td>
                  <td data-label="Actualizadas" className="p-3 text-right text-state-done font-bold">{row.matchedRows}</td>
                  <td className={cn('p-3 text-right font-bold', row.unmatchedRows > 0 ? 'text-state-wait' : 'text-text-soft')}>
                    {row.unmatchedRows}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ImportSection({
  suppliers,
  onImported,
  onError,
}: {
  suppliers: Supplier[];
  onImported: (result: ImportResult, supplierName: string) => void;
  onError: (message: string) => void;
}) {
  const [supplierId, setSupplierId] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [parsed, setParsed] = React.useState<ParsedSheet | null>(null);
  const [importing, setImporting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function handleFile(selected: File | null) {
    setFile(selected);
    setParsed(null);
    if (!selected) return;
    try {
      setParsed(await parsePriceListFile(selected));
    } catch (err) {
      onError(
        err instanceof ExcelFormatError
          ? `No se pudo leer el archivo: ${err.message}`
          : getErrorMessage(err)
      );
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleImport() {
    if (!supplierId || !parsed || !file) return;
    setImporting(true);
    try {
      const result = await importSupplierPrices(supplierId, file.name, parsed.rows);
      const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? 'proveedor';
      onImported(result, supplierName);
      setFile(null);
      setParsed(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      onError(describePriceError(getErrorMessage(err)));
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="bg-panel border border-line p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
            <Upload size={14} /> Importar lista de compra
          </h2>
          <p className="text-xs text-text-soft mt-1">
            El Excel debe tener en la primera fila los encabezados{' '}
            <code className="bg-panel-alt px-1 font-mono">codigo</code>,{' '}
            <code className="bg-panel-alt px-1 font-mono">descripcion</code> y{' '}
            <code className="bg-panel-alt px-1 font-mono">precio</code> (netos, sin IVA).
          </p>
        </div>
        <button
          onClick={downloadTemplate}
          className="border border-line text-text-soft text-[11px] font-bold uppercase tracking-wider px-3 py-2 hover:bg-panel-alt transition-colors flex items-center gap-1.5"
        >
          <Download size={16} /> Descargar plantilla
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
          Proveedor
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="mt-1 w-full border border-line px-3 py-2 text-sm font-normal normal-case bg-panel"
          >
            <option value="">Elegí el proveedor de esta lista...</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
        </label>

        <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
          Archivo Excel
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            className="mt-1 w-full border border-line px-3 py-[7px] text-sm font-normal normal-case file:mr-3 file:border-0 file:bg-panel-head file:px-2 file:py-1 file:text-xs file:cursor-pointer"
          />
        </label>
      </div>

      {parsed && (
        <div className="border border-line overflow-hidden">
          <div className="bg-panel-alt px-3 py-2 text-xs text-text-soft flex items-center justify-between flex-wrap gap-2">
            <span>
              Hoja <strong>{parsed.sheetName}</strong> · <strong>{parsed.rows.length}</strong> fila(s) válidas
              {parsed.skipped.length > 0 && (
                <span className="text-state-wait"> · {parsed.skipped.length} descartada(s)</span>
              )}
            </span>
            <span>Vista previa de las primeras 5:</span>
          </div>
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="bg-panel-head text-text font-bold uppercase tracking-wider">
              <tr>
                <th className="px-3 py-1 w-32">Código prov.</th>
                <th className="px-3 py-1">Descripción</th>
                <th className="px-3 py-1 w-32 text-right">Precio compra</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.slice(0, 5).map((row, i) => (
                <tr key={i} className={cn('border-b border-line', i % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
                  <td className="px-3 py-1 font-mono font-bold">{row.code}</td>
                  <td className="px-3 py-1">{row.description || <span className="text-text-faint">—</span>}</td>
                  <td className="px-3 py-1 text-right">$ {row.price.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {parsed.skipped.length > 0 && (
            <div className="bg-orange-50 border-t border-orange-200 px-3 py-2 text-[11px] text-state-wait">
              <AlertTriangle size={12} className="inline mr-1" />
              Filas descartadas:{' '}
              {parsed.skipped.slice(0, 5).map((s) => `fila ${s.row} (${s.reason})`).join(', ')}
              {parsed.skipped.length > 5 && ` y ${parsed.skipped.length - 5} más`}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleImport}
          disabled={!supplierId || !parsed || importing}
          className="bg-accent text-accent-ink text-[11px] font-bold uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
          <Upload size={16} />
          {importing ? 'Importando...' : 'Importar precios'}
        </button>
      </div>
    </section>
  );
}

/**
 * Códigos del proveedor que todavía no corresponden a ningún artículo nuestro.
 * Acá se los vincula a mano; la próxima importación ya los reconoce solos.
 */
function UnmatchedSection({
  rows,
  articles,
  loading,
  onChanged,
  onError,
}: {
  rows: UnmatchedPrice[];
  articles: Article[];
  loading: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [linking, setLinking] = React.useState<UnmatchedPrice | null>(null);

  async function handleDiscard(row: UnmatchedPrice) {
    if (!window.confirm(`¿Descartar el código ${row.supplierCode} de ${row.supplierName}?`)) return;
    onError(null);
    try {
      await discardUnmatchedPrice(row.id);
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
    }
  }

  return (
    <section className="border border-line bg-panel">
      <div className="p-4 border-b border-line bg-panel-head flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
          <Link2 size={14} /> Códigos pendientes de vincular
          {rows.length > 0 && (
            <span className="ml-1 bg-orange-100 text-orange-700 px-2 py-0.5 text-[10px]">
              {rows.length}
            </span>
          )}
        </h2>
        <p className="text-[11px] text-text-soft">
          Vinculalos a un artículo nuestro para que la próxima importación los reconozca sola.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="table-stack w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
              <th className="p-3 font-semibold w-40">Proveedor</th>
              <th className="p-3 font-semibold w-32">Su código</th>
              <th className="p-3 font-semibold">Su descripción</th>
              <th className="p-3 font-semibold w-28 text-right">P. compra</th>
              <th className="p-3 font-semibold w-32 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="p-6 text-center text-text-soft">Cargando...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-text-soft">
                  No hay códigos pendientes. Todas las filas importadas quedaron vinculadas.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line hover:bg-panel-alt transition-colors">
                <td data-label="Proveedor" className="p-3">{row.supplierName}</td>
                <td data-primary className="p-3 font-mono font-bold">{row.supplierCode}</td>
                <td data-label="Descripción" className="p-3">{row.description ?? <span className="text-text-faint">—</span>}</td>
                <td data-label="P. compra" className="p-3 text-right">$ {row.purchasePrice.toFixed(2)}</td>
                <td className="p-3 text-right space-x-1">
                  <button
                    onClick={() => setLinking(row)}
                    className="bg-accent text-accent-ink text-[10px] font-bold uppercase tracking-wider px-2 py-1 hover:bg-accent-deep hover:text-white transition-colors inline-flex items-center gap-1"
                  >
                    <Link2 size={13} /> Vincular
                  </button>
                  <button
                    onClick={() => handleDiscard(row)}
                    title="Descartar"
                    className="text-text-soft hover:text-danger p-1"
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {linking && (
        <LinkModal
          row={linking}
          articles={articles}
          onClose={() => setLinking(null)}
          onLinked={() => {
            setLinking(null);
            onChanged();
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

function LinkModal({
  row,
  articles,
  onClose,
  onLinked,
  onError,
}: {
  row: UnmatchedPrice;
  articles: Article[];
  onClose: () => void;
  onLinked: () => void;
  onError: (message: string) => void;
}) {
  const [search, setSearch] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return articles.slice(0, 30);
    return articles
      .filter((a) => `${a.code} ${a.description}`.toLowerCase().includes(term))
      .slice(0, 30);
  }, [articles, search]);

  async function handleLink(articleId: string) {
    setBusy(true);
    try {
      await linkUnmatchedPrice(row.id, articleId);
      onLinked();
    } catch (err) {
      onError(describePriceError(getErrorMessage(err)));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-2xl flex flex-col max-h-[80vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <div>
            <h2 className="text-base font-bold text-text">Vincular código del proveedor</h2>
            <p className="text-xs text-text-soft mt-0.5">
              {row.supplierName} · <span className="font-mono font-bold">{row.supplierCode}</span> ·
              {row.description ? ` ${row.description} · ` : ' '}
              $ {row.purchasePrice.toFixed(2)}
            </p>
          </div>
          <button onClick={onClose} className="text-text-soft hover:text-text">
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
              placeholder="Buscar nuestro artículo por código o descripción..."
              className="w-full h-9 pl-9 pr-3 border border-line text-sm"
            />
          </div>
        </div>

        <div className="overflow-y-auto px-5 pb-5">
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="text-text-soft border-b border-line bg-panel-alt sticky top-0">
              <tr>
                <th className="p-2 font-bold w-28">Nuestro cód.</th>
                <th className="p-2 font-bold">Descripción</th>
                <th className="p-2 font-bold w-28 text-right">P. venta actual</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={3} className="p-6 text-center text-text-soft">Ningún artículo coincide.</td></tr>
              )}
              {filtered.map((article) => (
                <tr
                  key={article.id}
                  onClick={() => !busy && handleLink(article.id)}
                  className="border-b border-line hover:bg-panel-alt cursor-pointer transition-colors"
                >
                  <td data-primary className="p-2 font-mono font-bold">{article.code}</td>
                  <td data-label="Descripción" className="p-2">{article.description}</td>
                  <td data-label="P. venta" className="p-2 text-right">$ {article.unitPrice.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
