import React from 'react';
import { Plus, Pencil, Trash2, X, Search, Package, CalendarClock } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { FiscalFields } from '@/src/components/FiscalFields';
import {
  EMPTY_FISCAL_FORM,
  fiscalEntityToForm,
  formatCuit,
  isValidCuit,
  TAX_CONDITION_LABELS,
} from '@/src/lib/fiscal';
import {
  createSupplier,
  deleteSupplier,
  describeSupplierError,
  fetchSuppliers,
  updateSupplier,
  type Supplier,
  type SupplierInput,
} from '@/src/lib/suppliers';

export function Suppliers() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<Supplier | 'new' | null>(null);

  const loadSuppliers = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSuppliers(await fetchSuppliers());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadSuppliers();
  }, [isAdmin, loadSuppliers]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return suppliers;
    return suppliers.filter((s) =>
      [s.name, s.legalName, s.taxId, s.email, s.phone]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term))
    );
  }, [suppliers, search]);

  async function handleDelete(supplier: Supplier) {
    const warning = supplier.articles.length > 0
      ? `\n\nSus ${supplier.articles.length} artículo(s) quedarán sin proveedor asignado (no se eliminan).`
      : '';
    if (!window.confirm(`¿Eliminar el proveedor "${supplier.name}"?${warning}`)) return;
    setError(null);
    try {
      await deleteSupplier(supplier.id);
      loadSuppliers();
    } catch (err) {
      setError(describeSupplierError(getErrorMessage(err)));
    }
  }

  // El padrón de proveedores es gestión: solo admin.
  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Proveedores"
        subtitle="Datos fiscales y artículos que provee cada uno."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus size={16} /> Nuevo proveedor
          </Button>
        }
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}

      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, CUIT, email..."
          className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <div className="border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="p-3 font-semibold">Proveedor</th>
                <th className="p-3 font-semibold w-36">CUIT / CUIL</th>
                <th className="p-3 font-semibold w-44">Cond. IVA</th>
                <th className="p-3 font-semibold w-48">Contacto</th>
                <th className="p-3 font-semibold w-24 text-center">Artículos</th>
                <th className="p-3 font-semibold w-20 text-center">Estado</th>
                <th className="p-3 font-semibold w-24 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="p-6 text-center text-text-soft">Cargando...</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-text-soft">
                    {search ? 'Ningún proveedor coincide con la búsqueda.' : 'No hay proveedores cargados.'}
                  </td>
                </tr>
              )}
              {filtered.map((supplier) => (
                <tr key={supplier.id} className={cn(
                  "border-b border-line hover:bg-panel-alt transition-colors",
                  !supplier.active && "opacity-55"
                )}>
                  <td data-primary className="p-3">
                    <div className="font-bold text-text">{supplier.name}</div>
                    {supplier.legalName && supplier.legalName !== supplier.name && (
                      <div className="text-[11px] text-text-soft">{supplier.legalName}</div>
                    )}
                  </td>
                  <td data-label="CUIT" className="p-3 font-mono">
                    {formatCuit(supplier.taxId) || <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Cond. IVA" className="p-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-accent-deep">
                      {TAX_CONDITION_LABELS[supplier.taxCondition]}
                    </span>
                  </td>
                  <td data-label="Contacto" className="p-3 text-[11px] text-text-soft">
                    {supplier.email && <div>{supplier.email}</div>}
                    {supplier.phone && <div>{supplier.phone}</div>}
                    {!supplier.email && !supplier.phone && <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Artículos" className="p-3 text-center">
                    <span className="inline-flex items-center gap-1 text-text-soft">
                      <Package size={13} />
                      {supplier.articles.length}
                    </span>
                  </td>
                  <td data-label="Estado" className="p-3 text-center">
                    <span className={cn(
                      "text-[10px] font-bold uppercase tracking-wider",
                      supplier.active ? "text-state-done" : "text-text-faint"
                    )}>
                      {supplier.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => setEditing(supplier)} title="Editar" className="text-text-soft hover:text-text p-1">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(supplier)} title="Eliminar" className="text-text-soft hover:text-danger p-1">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <SupplierModal
          supplier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadSuppliers();
          }}
        />
      )}
    </div>
  );
}

function SupplierModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<SupplierInput>(
    supplier
      ? {
          ...fiscalEntityToForm(supplier),
          paymentTermsDays: supplier.paymentTermsDays,
          codePrefix: supplier.codePrefix,
        }
      // Un proveedor normalmente factura, así que por defecto es Resp. Inscripto.
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
      if (supplier) await updateSupplier(supplier.id, form);
      else await createSupplier(form);
      onSaved();
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

          {/* Condiciones comerciales: de acá sale el vencimiento que se
              propone al cargar una factura de compra, y el prefijo con el
              que se numeran los artículos que se dan de alta solos al
              importar la lista de precios de este proveedor. */}
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

          {supplier && <SupplierArticlesSection supplier={supplier} />}

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

/**
 * Listado de solo lectura: el proveedor de cada artículo se asigna desde el
 * ABM de Inventario, así que acá solo se muestran y se enlaza a esa sección.
 */
function SupplierArticlesSection({ supplier }: { supplier: Supplier }) {
  return (
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
  );
}
