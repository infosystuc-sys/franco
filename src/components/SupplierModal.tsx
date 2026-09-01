import React from 'react';
import { X, Package, CalendarClock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getErrorMessage } from '@/src/lib/workOrders';
import { FiscalFields } from '@/src/components/FiscalFields';
import {
  EMPTY_FISCAL_FORM,
  fiscalEntityToForm,
  isValidCuit,
} from '@/src/lib/fiscal';
import {
  createSupplier,
  describeSupplierError,
  updateSupplier,
  type Supplier,
  type SupplierInput,
} from '@/src/lib/suppliers';

/**
 * Alta/edición de proveedor. Compartido entre la pantalla de Proveedores y
 * la revisión de facturas de compra leídas con IA (que necesita poder
 * cargar un proveedor nuevo sin salir de esa pantalla, igual que
 * CustomerModal para clientes).
 */
export function SupplierModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: (supplier: Supplier) => void;
}) {
  const [form, setForm] = React.useState<SupplierInput>(
    supplier
      ? {
          ...fiscalEntityToForm(supplier),
          paymentTermsDays: supplier.paymentTermsDays,
          codePrefix: supplier.codePrefix,
        }
      : { ...EMPTY_FISCAL_FORM, taxCondition: 'RESPONSABLE_INSCRIPTO', paymentTermsDays: 30, codePrefix: null }
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<SupplierInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre del proveedor es obligatorio.');
      return;
    }
    if (form.taxId.trim() !== '' && !isValidCuit(form.taxId)) {
      setError('El CUIT/CUIL ingresado no es válido.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = supplier ? await updateSupplier(supplier.id, form) : await createSupplier(form);
      onSaved(saved);
    } catch (err) {
      setError(describeSupplierError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">
            {supplier ? 'Editar proveedor' : 'Nuevo proveedor'}
          </h2>
          <button onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5 overflow-y-auto">
          {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

          <FiscalFields
            form={form}
            patch={patch}
            nameLabel="Nombre / Denominación comercial"
            namePlaceholder="Diesel Parts S.A."
            legalNamePlaceholder="Diesel Parts Sociedad Anónima"
            activeLabel="Activo (disponible para asignar a artículos)"
          />

          <div className="space-y-3 border-t border-line pt-4">
            <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-accent-deep">
              <CalendarClock size={14} /> Condiciones comerciales
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
                Plazo de pago (días)
                <input
                  type="number"
                  min="0"
                  max="365"
                  value={form.paymentTermsDays}
                  onChange={(e) => patch({ paymentTermsDays: Number(e.target.value) })}
                  className="mt-1 w-full border border-line bg-panel px-3 py-2 font-mono text-sm normal-case focus:border-accent-deep focus:outline-none"
                />
                <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                  {form.paymentTermsDays === 0
                    ? 'Contado: la factura vence el mismo día que se emite.'
                    : `Las facturas de este proveedor van a proponer vencimiento a ${form.paymentTermsDays} días.`}
                </span>
              </label>
              <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
                Prefijo de código
                <input
                  value={form.codePrefix ?? ''}
                  onChange={(e) => patch({ codePrefix: e.target.value.toUpperCase().slice(0, 2) || null })}
                  maxLength={2}
                  className="mt-1 w-full border border-line bg-panel px-3 py-2 font-mono text-sm uppercase normal-case focus:border-accent-deep focus:outline-none"
                  placeholder="DE"
                />
                <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                  {form.codePrefix
                    ? `Los artículos nuevos de este proveedor van a llevar el código ${form.codePrefix}-00000001, ${form.codePrefix}-00000002...`
                    : 'Sin prefijo no se puede importar el catálogo de este proveedor.'}
                </span>
              </label>
            </div>
          </div>

          {supplier && (
            <div className="border-t border-line pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
                  <Package size={14} /> Artículos que provee
                </h3>
                <Link to="/listas-precios" className="text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline">
                  Importar lista →
                </Link>
              </div>
              {supplier.articles.length === 0 ? (
                <p className="text-xs text-text-soft">
                  Ningún artículo tiene asignado este proveedor. Asignalo desde la sección Inventario.
                </p>
              ) : (
                <ul className="space-y-1 max-h-48 overflow-y-auto">
                  {supplier.articles.map((article) => (
                    <li key={article.id} className="flex items-center justify-between bg-panel-alt border border-line px-3 py-2 text-sm gap-3">
                      <span className="min-w-0">
                        <span className="font-mono font-bold text-accent-deep text-xs">{article.supplierCode}</span>
                        <span className="mx-1.5 text-text-faint">→</span>
                        <span className="font-mono text-text-soft text-xs">{article.code}</span>
                        <span className="ml-2 text-text">{article.description}</span>
                      </span>
                      <span className="text-xs text-text-soft whitespace-nowrap">
                        $ {article.purchasePrice.toFixed(2)}
                        {article.isPreferred && (
                          <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-accent-deep">Preferido</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <button type="button" onClick={onClose} className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt">
              Cancelar
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
