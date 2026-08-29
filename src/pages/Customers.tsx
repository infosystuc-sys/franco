import React from 'react';
import { Plus, Pencil, Trash2, Search, Truck } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { CustomerModal } from '@/src/components/CustomerModal';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import {
  deleteCustomer,
  describeCustomerError,
  fetchCustomers,
  type Customer,
} from '@/src/lib/customers';

export function Customers() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<Customer | 'new' | null>(null);

  const loadCustomers = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCustomers(await fetchCustomers());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadCustomers();
  }, [isAdmin, loadCustomers]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return customers;
    return customers.filter((c) =>
      [c.name, c.legalName, c.taxId, c.email, c.phone]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term))
    );
  }, [customers, search]);

  async function handleDelete(customer: Customer) {
    if (!window.confirm(`¿Eliminar el cliente "${customer.name}"? También se eliminarán sus vehículos.`)) return;
    setError(null);
    try {
      await deleteCustomer(customer.id);
      loadCustomers();
    } catch (err) {
      // Un cliente con órdenes de trabajo no se puede borrar (FK). Se sugiere desactivarlo.
      setError(describeCustomerError(getErrorMessage(err), customer.name));
    }
  }

  // El padrón de clientes es gestión: solo admin.
  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Clientes"
        subtitle="Datos fiscales y vehículos de cada cliente del taller."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus size={16} /> Nuevo cliente
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
                <th className="p-3 font-semibold">Cliente</th>
                <th className="p-3 font-semibold w-36">CUIT / CUIL</th>
                <th className="p-3 font-semibold w-44">Cond. IVA</th>
                <th className="p-3 font-semibold w-48">Contacto</th>
                <th className="p-3 font-semibold w-20 text-center">Vehíc.</th>
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
                    {search ? 'Ningún cliente coincide con la búsqueda.' : 'No hay clientes cargados.'}
                  </td>
                </tr>
              )}
              {filtered.map((customer) => (
                <tr key={customer.id} className="border-b border-line hover:bg-panel-alt transition-colors">
                  <td data-primary className="p-3">
                    <div className="font-bold text-text">{customer.name}</div>
                    {customer.legalName && customer.legalName !== customer.name && (
                      <div className="text-[11px] text-text-soft">{customer.legalName}</div>
                    )}
                  </td>
                  <td data-label="CUIT" className="p-3 font-mono">{formatCuit(customer.taxId) || <span className="text-text-faint">—</span>}</td>
                  <td data-label="Cond. IVA" className="p-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-accent-deep">
                      {TAX_CONDITION_LABELS[customer.taxCondition]}
                    </span>
                  </td>
                  <td data-label="Contacto" className="p-3 text-[11px] text-text-soft">
                    {customer.email && <div>{customer.email}</div>}
                    {customer.phone && <div>{customer.phone}</div>}
                    {!customer.email && !customer.phone && <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Vehículos" className="p-3 text-center">
                    <span className="inline-flex items-center gap-1 text-text-soft">
                      <Truck size={13} />
                      {customer.vehicles.length}
                    </span>
                  </td>
                  <td data-label="Estado" className="p-3 text-center">
                    <span className={cn(
                      "text-[10px] font-bold uppercase tracking-wider",
                      customer.active ? "text-state-done" : "text-text-faint"
                    )}>
                      {customer.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => setEditing(customer)} title="Editar" className="text-text-soft hover:text-text p-1">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(customer)} title="Eliminar" className="text-text-soft hover:text-danger p-1">
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
        <CustomerModal
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadCustomers();
          }}
        />
      )}
    </div>
  );
}

