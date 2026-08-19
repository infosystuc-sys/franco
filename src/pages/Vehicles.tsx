import React from 'react';
import { Plus, Pencil, Trash2, X, Search, Truck, Cog, Gauge } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchCustomers, type Customer } from '@/src/lib/customers';
import {
  createVehicle,
  deleteVehicle,
  describeVehicleError,
  EMPTY_VEHICLE_FORM,
  fetchVehicles,
  INJECTION_SYSTEMS,
  ODOMETER_UNIT_LABELS,
  updateVehicle,
  VEHICLE_TYPE_LABELS,
  VEHICLE_TYPES,
  vehicleToForm,
  type OdometerUnit,
  type Vehicle,
  type VehicleInput,
  type VehicleType,
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
            className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
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

      <div className="border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
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
                  <td className="p-3">
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
                  <td className="p-3">
                    {vehicle.licensePlate ? (
                      <span className="bg-panel-head px-2 py-0.5 border border-line font-mono font-bold text-[11px]">
                        {vehicle.licensePlate}
                      </span>
                    ) : (
                      <span className="text-text-faint">—</span>
                    )}
                  </td>
                  <td className="p-3">{vehicle.customerName}</td>
                  <td className="p-3 text-[11px] text-text-soft">
                    {[vehicle.engineBrand, vehicle.engineModel].filter(Boolean).join(' ') || <span className="text-text-faint">—</span>}
                  </td>
                  <td className="p-3 text-[11px] text-text-soft">
                    {vehicle.injectionSystem || <span className="text-text-faint">—</span>}
                  </td>
                  <td className="p-3 text-right text-[11px] text-text-soft">
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

function VehicleModal({
  vehicle,
  customers,
  onClose,
  onSaved,
}: {
  vehicle: Vehicle | null;
  customers: Customer[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<VehicleInput>(
    vehicle ? vehicleToForm(vehicle) : EMPTY_VEHICLE_FORM
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<VehicleInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customerId) {
      setError('Elegí el cliente propietario del vehículo.');
      return;
    }
    if (!form.model.trim()) {
      setError('El modelo es obligatorio.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (vehicle) await updateVehicle(vehicle.id, form);
      else await createVehicle(form);
      onSaved();
    } catch (err) {
      setError(describeVehicleError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  const labelClass = 'text-xs font-bold uppercase tracking-wider text-text-soft';
  const inputClass = 'mt-1 w-full border border-line px-3 py-2 text-sm font-normal normal-case';
  const sectionTitle = 'text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5';

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">
            {vehicle ? 'Editar vehículo' : 'Nuevo vehículo'}
          </h2>
          <button onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5 overflow-y-auto">
          {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

          {/* Identificación */}
          <div className="space-y-3">
            <h3 className={sectionTitle}><Truck size={14} /> Identificación</h3>
            <div className="grid grid-cols-6 gap-3">
              <label className={cn(labelClass, 'col-span-6')}>
                Cliente propietario *
                <select
                  value={form.customerId}
                  onChange={(e) => patch({ customerId: e.target.value })}
                  className={cn(inputClass, 'bg-panel')}
                >
                  <option value="">Elegí un cliente...</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>{customer.name}</option>
                  ))}
                </select>
              </label>

              <label className={cn(labelClass, 'col-span-2')}>
                Marca
                <input value={form.brand} onChange={(e) => patch({ brand: e.target.value })} className={inputClass} placeholder="Volvo" />
              </label>
              <label className={cn(labelClass, 'col-span-4')}>
                Modelo *
                <input value={form.model} onChange={(e) => patch({ model: e.target.value })} className={inputClass} placeholder="FH16 750" />
              </label>

              <label className={cn(labelClass, 'col-span-3')}>
                Tipo
                <select
                  value={form.vehicleType}
                  onChange={(e) => patch({ vehicleType: e.target.value as VehicleType })}
                  className={cn(inputClass, 'bg-panel')}
                >
                  {VEHICLE_TYPES.map((type) => (
                    <option key={type} value={type}>{VEHICLE_TYPE_LABELS[type]}</option>
                  ))}
                </select>
              </label>
              <label className={cn(labelClass, 'col-span-2')}>
                Patente
                <input
                  value={form.licensePlate}
                  onChange={(e) => patch({ licensePlate: e.target.value.toUpperCase() })}
                  className={cn(inputClass, 'font-mono uppercase')}
                  placeholder="ABC-123"
                />
              </label>
              <label className={labelClass}>
                Año
                <input type="number" value={form.year} onChange={(e) => patch({ year: e.target.value })} className={inputClass} placeholder="2019" />
              </label>

              <label className={cn(labelClass, 'col-span-6')}>
                N° de chasis (VIN)
                <input
                  value={form.vin}
                  onChange={(e) => patch({ vin: e.target.value.toUpperCase() })}
                  className={cn(inputClass, 'font-mono uppercase')}
                  placeholder="YV2RT40A8FB123456"
                />
              </label>
            </div>
          </div>

          {/* Motor e inyección */}
          <div className="border-t border-line pt-4 space-y-3">
            <h3 className={sectionTitle}><Cog size={14} /> Motor e inyección</h3>
            <div className="grid grid-cols-6 gap-3">
              <label className={cn(labelClass, 'col-span-2')}>
                Marca motor
                <input value={form.engineBrand} onChange={(e) => patch({ engineBrand: e.target.value })} className={inputClass} placeholder="Volvo" />
              </label>
              <label className={cn(labelClass, 'col-span-2')}>
                Modelo motor
                <input value={form.engineModel} onChange={(e) => patch({ engineModel: e.target.value })} className={inputClass} placeholder="D16G" />
              </label>
              <label className={cn(labelClass, 'col-span-2')}>
                N° de motor
                <input value={form.engineNumber} onChange={(e) => patch({ engineNumber: e.target.value })} className={cn(inputClass, 'font-mono')} placeholder="D16G123456" />
              </label>
              <label className={cn(labelClass, 'col-span-6')}>
                Sistema de inyección
                <input
                  value={form.injectionSystem}
                  onChange={(e) => patch({ injectionSystem: e.target.value })}
                  list="injection-systems"
                  className={inputClass}
                  placeholder="Bosch Common Rail"
                />
                <datalist id="injection-systems">
                  {INJECTION_SYSTEMS.map((system) => <option key={system} value={system} />)}
                </datalist>
              </label>
            </div>
          </div>

          {/* Uso y estado */}
          <div className="border-t border-line pt-4 space-y-3">
            <h3 className={sectionTitle}><Gauge size={14} /> Uso y estado</h3>
            <div className="grid grid-cols-6 gap-3">
              <label className={cn(labelClass, 'col-span-3')}>
                Kilometraje / Horas
                <input type="number" min="0" value={form.odometer} onChange={(e) => patch({ odometer: e.target.value })} className={cn(inputClass, 'text-right')} placeholder="0" />
              </label>
              <label className={cn(labelClass, 'col-span-3')}>
                Unidad
                <select
                  value={form.odometerUnit}
                  onChange={(e) => patch({ odometerUnit: e.target.value as OdometerUnit })}
                  className={cn(inputClass, 'bg-panel')}
                >
                  {(Object.keys(ODOMETER_UNIT_LABELS) as OdometerUnit[]).map((unit) => (
                    <option key={unit} value={unit}>{ODOMETER_UNIT_LABELS[unit]}</option>
                  ))}
                </select>
              </label>
              <label className={cn(labelClass, 'col-span-6')}>
                Observaciones
                <textarea value={form.notes} onChange={(e) => patch({ notes: e.target.value })} rows={2} className={cn(inputClass, 'resize-y')} placeholder="Historial, particularidades del equipo..." />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
              <input type="checkbox" checked={form.active} onChange={(e) => patch({ active: e.target.checked })} className="w-4 h-4 accent-accent-deep" />
              Activo (disponible para nuevas órdenes de trabajo)
            </label>
          </div>

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
