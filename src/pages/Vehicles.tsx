import React from 'react';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { VehicleModal } from '@/src/components/VehicleModal';
import { fetchCustomers, type Customer } from '@/src/lib/customers';
import {
  deleteVehicle,
  describeVehicleError,
  fetchVehicles,
  VEHICLE_TYPE_LABELS,
  type Vehicle,
} from '@/src/lib/vehicles';

export function Vehicles() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [customerFilter, setCustomerFilter] = React.useState('');
  const [editing, setEditing] = React.useState<Vehicle | 'new' | null>(null);
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


  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vehicleRows, customerRows] = await Promise.all([fetchVehicles(), fetchCustomers()]);
      setVehicles(vehicleRows);
      setCustomers(customerRows);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadData();
  }, [isAdmin, loadData]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (customerFilter && v.customerId !== customerFilter) return false;
      if (!term) return true;
      return [v.brand, v.model, v.licensePlate, v.vin, v.engineNumber, v.engineModel, v.customerName]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term));
    });
  }, [vehicles, search, customerFilter]);

  async function handleDelete(vehicle: Vehicle) {
    const label = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
    if (!window.confirm(`¿Eliminar el vehículo "${label}"?`)) return;
    setError(null);
    try {
      await deleteVehicle(vehicle.id);
      loadData();
    } catch (err) {
      setError(describeVehicleError(getErrorMessage(err)));
    }
  }

  // El padrón de vehículos es gestión: solo admin.
  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Vehículos y equipos"
        subtitle="Ficha técnica de cada unidad: motor, sistema de inyección y uso."
        actions={
          <Button
            onClick={() => setEditing('new')}
            disabled={customers.length === 0}
            title={customers.length === 0 ? 'Primero cargá un cliente' : undefined}
          >
            <Plus size={16} /> Nuevo vehículo
          </Button>
        }
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}

      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por patente, modelo, VIN, motor..."
            className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>
        <select
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="h-9 border border-line bg-panel px-3 text-sm focus:border-accent-deep focus:outline-none max-w-xs"
        >
          <option value="">Todos los clientes</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>{customer.name}</option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="p-3 font-semibold">Vehículo / Equipo</th>
                <th className="p-3 font-semibold w-32">Patente</th>
                <th className="p-3 font-semibold w-44">Cliente</th>
                <th className="p-3 font-semibold w-40">Motor</th>
                <th className="p-3 font-semibold w-36">Inyección</th>
                <th className="p-3 font-semibold w-28 text-right">Uso</th>
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
                    {search || customerFilter
                      ? 'Ningún vehículo coincide con el filtro.'
                      : 'No hay vehículos cargados.'}
                  </td>
                </tr>
              )}
              {filtered.map((vehicle) => (
                <tr key={vehicle.id} className={cn(
                  "border-b border-line hover:bg-panel-alt transition-colors",
                  !vehicle.active && "opacity-55"
                )}>
                  <td data-primary className="p-3">
                    <div className="font-bold text-text">
                      {[vehicle.brand, vehicle.model].filter(Boolean).join(' ')}
                      {!vehicle.active && (
                        <span className="ml-2 text-[9px] font-bold uppercase tracking-wider text-text-faint">Inactivo</span>
                      )}
                    </div>
                    <div className="text-[11px] text-text-soft">
                      {VEHICLE_TYPE_LABELS[vehicle.vehicleType]}
                      {vehicle.year ? ` · ${vehicle.year}` : ''}
                    </div>
                  </td>
                  <td data-label="Patente" className="p-3">
                    {vehicle.licensePlate ? (
                      <span className="bg-panel-head px-2 py-0.5 border border-line font-mono font-bold text-[11px]">
                        {vehicle.licensePlate}
                      </span>
                    ) : (
                      <span className="text-text-faint">—</span>
                    )}
                  </td>
                  <td data-label="Cliente" className="p-3">{vehicle.customerName}</td>
                  <td data-label="Motor" className="p-3 text-[11px] text-text-soft">
                    {[vehicle.engineBrand, vehicle.engineModel].filter(Boolean).join(' ') || <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Inyección" className="p-3 text-[11px] text-text-soft">
                    {vehicle.injectionSystem || <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Uso" className="p-3 text-right text-[11px] text-text-soft">
                    {vehicle.odometer === null
                      ? <span className="text-text-faint">—</span>
                      : `${vehicle.odometer.toLocaleString('es-AR')} ${vehicle.odometerUnit === 'KM' ? 'km' : 'hs'}`}
                  </td>
                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => setEditing(vehicle)} title="Editar" className="text-text-soft hover:text-text p-1">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(vehicle)} title="Eliminar" className="text-text-soft hover:text-danger p-1">
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
        <VehicleModal
          vehicle={editing === 'new' ? null : editing}
          customers={customers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadData();
          }}
        />
      )}
    </div>
  );
}

