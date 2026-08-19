import React from 'react';
import { Plus, Pencil, Trash2, X, Search, Truck } from 'lucide-react';
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
  createCustomer,
  deleteCustomer,
  describeCustomerError,
  fetchCustomers,
  updateCustomer,
  type Customer,
  type CustomerInput,
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
          className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <div className="border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
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
                  <td className="p-3">
                    <div className="font-bold text-text">{customer.name}</div>
                    {customer.legalName && customer.legalName !== customer.name && (
                      <div className="text-[11px] text-text-soft">{customer.legalName}</div>
                    )}
                  </td>
                  <td className="p-3 font-mono">{formatCuit(customer.taxId) || <span className="text-text-faint">—</span>}</td>
                  <td className="p-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-accent-deep">
                      {TAX_CONDITION_LABELS[customer.taxCondition]}
                    </span>
                  </td>
                  <td className="p-3 text-[11px] text-text-soft">
                    {customer.email && <div>{customer.email}</div>}
                    {customer.phone && <div>{customer.phone}</div>}
                    {!customer.email && !customer.phone && <span className="text-text-faint">—</span>}
                  </td>
                  <td className="p-3 text-center">
                    <span className="inline-flex items-center gap-1 text-text-soft">
                      <Truck size={13} />
                      {customer.vehicles.length}
                    </span>
                  </td>
                  <td className="p-3 text-center">
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

function CustomerModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: Customer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<CustomerInput>(
    customer ? fiscalEntityToForm(customer) : EMPTY_FISCAL_FORM
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<CustomerInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre del cliente es obligatorio.');
      return;
    }
    if (form.taxId.trim() !== '' && !isValidCuit(form.taxId)) {
      setError('El CUIT/CUIL ingresado no es válido.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (customer) await updateCustomer(customer.id, form);
      else await createCustomer(form);
      onSaved();
    } catch (err) {
      setError(describeCustomerError(getErrorMessage(err), form.name));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">
            {customer ? `Editar cliente` : 'Nuevo cliente'}
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
            namePlaceholder="Transportes G&M"
            legalNamePlaceholder="Transportes G&M S.R.L."
            activeLabel="Activo (disponible para nuevas órdenes de trabajo)"
          />

          {/* Vehículos: solo al editar, porque necesitan un cliente ya existente */}
          {customer && <VehiclesSection customer={customer} />}

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
 * Listado de solo lectura: la ficha técnica completa se administra en el ABM
 * de Vehículos, así que acá solo se muestran y se enlaza a esa sección.
 */
function VehiclesSection({ customer }: { customer: Customer }) {
  return (
    <div className="border-t border-line pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
          <Truck size={14} /> Vehículos / Equipos
        </h3>
        <Link to="/vehiculos" className="text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline">
          Administrar →
        </Link>
      </div>

      {customer.vehicles.length === 0 ? (
        <p className="text-xs text-text-soft">
          Este cliente todavía no tiene vehículos cargados. Agregalos desde la sección Vehículos.
        </p>
      ) : (
        <ul className="space-y-1">
          {customer.vehicles.map((vehicle) => (
            <li key={vehicle.id} className={cn(
              "flex items-center justify-between bg-panel-alt border border-line px-3 py-2 text-sm",
              !vehicle.active && "opacity-55"
            )}>
              <span>
                <span className="font-semibold text-text">
                  {[vehicle.brand, vehicle.model].filter(Boolean).join(' ')}
                </span>
                {vehicle.licensePlate && <span className="ml-2 font-mono text-xs text-text-soft">{vehicle.licensePlate}</span>}
                {vehicle.year && <span className="ml-2 text-xs text-text-soft">({vehicle.year})</span>}
              </span>
              {!vehicle.active && (
                <span className="text-[9px] font-bold uppercase tracking-wider text-text-faint">Inactivo</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
