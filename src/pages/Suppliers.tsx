import React from 'react';
import { Plus, Pencil, Trash2, Search, Package } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  formatCuit,
  TAX_CONDITION_LABELS,
} from '@/src/lib/fiscal';
import {
  deleteSupplier,
  describeSupplierError,
  fetchSuppliers,
  type Supplier,
} from '@/src/lib/suppliers';
import { SupplierModal } from '@/src/components/SupplierModal';

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
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-panel">
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
