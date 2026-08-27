import React from 'react';
import { Upload, AlertTriangle, CheckCircle2, Percent, History } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { ExcelFormatError, parseWithMapping, previewSheet, type ParsedSheet, type RawGrid } from '@/src/lib/excelImport';
import {
  describePriceError,
  fetchDefaultMarkup,
  fetchPriceImports,
  fetchSupplierImportProfile,
  importSupplierPrices,
  saveSupplierImportProfile,
  updateDefaultMarkup,
  type ColumnMapping,
  type ImportResult,
  type PriceImport,
} from '@/src/lib/priceLists';
import { SupplierColumnMapper } from '@/src/components/SupplierColumnMapper';

export function PriceLists() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
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
      const [supplierRows, importRows, defaultMarkup] = await Promise.all([
        fetchSuppliers(true),
        fetchPriceImports(),
        fetchDefaultMarkup(),
      ]);
      setSuppliers(supplierRows);
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
            (result.createdRows > 0
              ? ` y ${result.createdRows} artículo(s) nuevo(s) dado(s) de alta.`
              : '. Todos los códigos ya eran conocidos.')
          );
          setError(null);
          await loadAll();
        }}
        onError={(message) => { setError(message); setNotice(null); }}
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
                <th className="p-3 font-semibold w-28 text-right">Creados</th>
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
                  <td className={cn('p-3 text-right font-bold', row.createdRows > 0 ? 'text-accent-deep' : 'text-text-soft')}>
                    {row.createdRows}
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
  const [mapping, setMapping] = React.useState<ColumnMapping | null>(null);
  const [grid, setGrid] = React.useState<RawGrid | null>(null);
  const [parsed, setParsed] = React.useState<ParsedSheet | null>(null);
  const [savingMapping, setSavingMapping] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;

  async function loadForFile(selected: File, currentSupplierId: string) {
    setParsed(null);
    setGrid(null);
    setMapping(null);
    try {
      const profile = await fetchSupplierImportProfile(currentSupplierId);
      if (profile) {
        setMapping(profile);
        setParsed(await parseWithMapping(selected, profile));
      } else {
        setGrid(await previewSheet(selected));
      }
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

  async function handleFile(selected: File | null) {
    setFile(selected);
    setParsed(null);
    setGrid(null);
    setMapping(null);
    if (!selected || !supplierId) return;
    await loadForFile(selected, supplierId);
  }

  function handleSupplierChange(id: string) {
    setSupplierId(id);
    setParsed(null);
    setGrid(null);
    setMapping(null);
    const nextSupplier = suppliers.find((s) => s.id === id);
    if (file && id && nextSupplier?.codePrefix) loadForFile(file, id);
  }

  async function handleEditMapping() {
    if (!file) return;
    setParsed(null);
    try {
      setGrid(await previewSheet(file));
    } catch (err) {
      onError(getErrorMessage(err));
    }
  }

  async function handleSaveMapping(newMapping: ColumnMapping) {
    if (!file || !supplierId) return;
    setSavingMapping(true);
    try {
      await saveSupplierImportProfile(supplierId, newMapping);
      setMapping(newMapping);
      setGrid(null);
      setParsed(await parseWithMapping(file, newMapping));
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setSavingMapping(false);
    }
  }

  async function handleImport() {
    if (!supplierId || !parsed || !file) return;
    if (!supplier?.codePrefix) {
      onError('Este proveedor no tiene prefijo de código. Definilo en Proveedores antes de importar.');
      return;
    }
    setImporting(true);
    try {
      const result = await importSupplierPrices(supplierId, file.name, parsed.rows);
      const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? 'proveedor';
      onImported(result, supplierName);
      setFile(null);
      setParsed(null);
      setGrid(null);
      setMapping(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      onError(describePriceError(getErrorMessage(err)));
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="bg-panel border border-line p-5 space-y-4">
      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
          <Upload size={14} /> Importar lista de compra
        </h2>
        <p className="text-xs text-text-soft mt-1">
          Subí el Excel tal como lo manda el proveedor. La primera vez se pide indicar en qué
          columna está cada dato; las próximas veces se recuerda solo.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
          Proveedor
          <select
            value={supplierId}
            onChange={(e) => handleSupplierChange(e.target.value)}
            className="mt-1 w-full border border-line px-3 py-2 text-sm font-normal normal-case bg-panel"
          >
            <option value="">Elegí el proveedor de esta lista...</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {supplier && !supplier.codePrefix && (
            <span className="mt-1 block text-[11px] font-normal normal-case text-danger">
              Este proveedor no tiene prefijo de código. Definilo en Proveedores antes de importar.
            </span>
          )}
        </label>

        <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
          Archivo Excel
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={!supplierId || !supplier?.codePrefix}
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            className="mt-1 w-full border border-line px-3 py-[7px] text-sm font-normal normal-case file:mr-3 file:border-0 file:bg-panel-head file:px-2 file:py-1 file:text-xs file:cursor-pointer disabled:opacity-50"
          />
        </label>
      </div>

      {grid && (
        <SupplierColumnMapper
          grid={grid}
          initialMapping={mapping}
          saving={savingMapping}
          onSave={handleSaveMapping}
          onCancel={async () => {
            setGrid(null);
            if (mapping && file) {
              try {
                setParsed(await parseWithMapping(file, mapping));
              } catch (err) {
                onError(getErrorMessage(err));
              }
            } else {
              setFile(null);
              if (inputRef.current) inputRef.current.value = '';
            }
          }}
        />
      )}

      {parsed && !grid && (
        <div className="border border-line overflow-hidden">
          <div className="bg-panel-alt px-3 py-2 text-xs text-text-soft flex items-center justify-between flex-wrap gap-2">
            <span>
              Hoja <strong>{parsed.sheetName}</strong> · <strong>{parsed.rows.length}</strong> fila(s) válidas
              {parsed.skipped.length > 0 && (
                <span className="text-state-wait"> · {parsed.skipped.length} descartada(s)</span>
              )}
            </span>
            <button
              type="button"
              onClick={handleEditMapping}
              className="text-accent-deep hover:underline font-semibold"
            >
              Editar mapeo
            </button>
          </div>
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="bg-panel-head text-text font-bold uppercase tracking-wider">
              <tr>
                <th className="px-3 py-1 w-32">Código prov.</th>
                <th className="px-3 py-1">Descripción</th>
                <th className="px-3 py-1 w-28">Marca</th>
                <th className="px-3 py-1 w-32 text-right">Precio compra</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.slice(0, 5).map((row, i) => (
                <tr key={i} className={cn('border-b border-line', i % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
                  <td className="px-3 py-1 font-mono font-bold">{row.code}</td>
                  <td className="px-3 py-1">{row.description || <span className="text-text-faint">—</span>}</td>
                  <td className="px-3 py-1">{row.brand || <span className="text-text-faint">—</span>}</td>
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
          disabled={!supplierId || !parsed || !!grid || importing}
          className="bg-accent text-accent-ink text-[11px] font-bold uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
          <Upload size={16} />
          {importing ? 'Importando...' : 'Importar precios'}
        </button>
      </div>
    </section>
  );
}
