import React from 'react';
import { columnLetter, type RawGrid } from '@/src/lib/excelImport';
import type { ColumnMapping } from '@/src/lib/priceLists';

type Field = 'codeColumn' | 'priceColumn' | 'descriptionColumn' | 'brandColumn';

const REQUIRED_FIELDS: { field: 'codeColumn' | 'priceColumn'; label: string }[] = [
  { field: 'codeColumn', label: 'Código' },
  { field: 'priceColumn', label: 'Precio' },
];

const OPTIONAL_FIELDS: { field: 'descriptionColumn' | 'brandColumn'; label: string }[] = [
  { field: 'descriptionColumn', label: 'Descripción' },
  { field: 'brandColumn', label: 'Marca' },
];

/**
 * Grilla cruda del Excel para que el admin indique a mano qué columna es
 * cada dato. No se adivina por nombre de encabezado: cada proveedor arma
 * su lista distinto (encabezado en cualquier fila, títulos de sección,
 * columnas en otro orden).
 */
export function SupplierColumnMapper({
  grid,
  initialMapping,
  saving,
  onSave,
  onCancel,
}: {
  grid: RawGrid;
  initialMapping: ColumnMapping | null;
  saving: boolean;
  onSave: (mapping: ColumnMapping) => void;
  onCancel: () => void;
}) {
  const [codeColumn, setCodeColumn] = React.useState<number | null>(initialMapping?.codeColumn ?? null);
  const [priceColumn, setPriceColumn] = React.useState<number | null>(initialMapping?.priceColumn ?? null);
  const [descriptionColumn, setDescriptionColumn] = React.useState<number | null>(
    initialMapping?.descriptionColumn ?? null
  );
  const [brandColumn, setBrandColumn] = React.useState<number | null>(initialMapping?.brandColumn ?? null);

  // Fila más cercana al final de la vista previa: en un archivo real, las
  // primeras suelen ser título/encabezado y las últimas ya son datos.
  const sample = grid.rows[grid.rows.length - 1] ?? [];

  const values: Record<Field, number | null> = { codeColumn, priceColumn, descriptionColumn, brandColumn };
  const setters: Record<Field, (v: number | null) => void> = {
    codeColumn: setCodeColumn,
    priceColumn: setPriceColumn,
    descriptionColumn: setDescriptionColumn,
    brandColumn: setBrandColumn,
  };

  const chosen = [codeColumn, priceColumn, descriptionColumn, brandColumn].filter(
    (c): c is number => c !== null
  );
  const hasDuplicates = new Set(chosen).size !== chosen.length;
  const canSave = codeColumn !== null && priceColumn !== null && !hasDuplicates;

  function optionLabel(i: number) {
    const preview = sample[i] ? ` — "${sample[i]}"` : '';
    return `Columna ${columnLetter(i)}${preview}`;
  }

  function renderSelect(field: Field, required: boolean) {
    return (
      <select
        value={values[field] ?? ''}
        onChange={(e) => setters[field](e.target.value === '' ? null : Number(e.target.value))}
        className="mt-1 w-full rounded border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
      >
        <option value="">{required ? 'Elegí una columna...' : '— sin mapear —'}</option>
        {Array.from({ length: grid.columnCount }, (_, i) => (
          <option key={i} value={i}>{optionLabel(i)}</option>
        ))}
      </select>
    );
  }

  return (
    <div className="rounded-md border border-line overflow-hidden">
      <div className="bg-panel-alt px-3 py-2 text-xs text-text-soft">
        Hoja <strong>{grid.sheetName}</strong> · indicá en qué columna está cada dato. Se guarda para
        que las próximas importaciones de este proveedor lo reconozcan solas.
      </div>

      <div className="overflow-x-auto max-h-64">
        <table className="w-full text-left text-[12px] font-mono">
          <thead className="bg-panel-head sticky top-0">
            <tr>
              {Array.from({ length: grid.columnCount }, (_, i) => (
                <th key={i} className="px-2 py-1 border-b border-line font-bold">{columnLetter(i)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, r) => (
              <tr key={r} className={r % 2 === 0 ? 'bg-panel-alt' : 'bg-panel'}>
                {Array.from({ length: grid.columnCount }, (_, i) => (
                  <td key={i} className="px-2 py-1 whitespace-nowrap">
                    {row[i] || <span className="text-text-faint">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 p-3 border-t border-line">
        {REQUIRED_FIELDS.map(({ field, label }) => (
          <label key={field} className="text-xs font-bold uppercase tracking-wider text-text-soft">
            {label} <span className="text-danger">*</span>
            {renderSelect(field, true)}
          </label>
        ))}
        {OPTIONAL_FIELDS.map(({ field, label }) => (
          <label key={field} className="text-xs font-bold uppercase tracking-wider text-text-soft">
            {label}
            {renderSelect(field, false)}
          </label>
        ))}
      </div>

      {hasDuplicates && (
        <div className="px-3 pb-2 text-[11px] text-danger">
          Cada campo tiene que apuntar a una columna distinta.
        </div>
      )}

      <div className="flex justify-end gap-2 p-3 border-t border-line">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={!canSave || saving}
          onClick={() =>
            canSave &&
            onSave({ codeColumn: codeColumn!, priceColumn: priceColumn!, descriptionColumn, brandColumn })
          }
          className="bg-accent text-accent-ink text-[11px] font-bold uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
        >
          {saving ? 'Guardando...' : 'Guardar mapeo y continuar'}
        </button>
      </div>
    </div>
  );
}
