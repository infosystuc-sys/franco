import React from 'react';
import { X, Truck, Cog, Gauge } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { getErrorMessage } from '@/src/lib/workOrders';
import type { Customer } from '@/src/lib/customers';
import {
  createVehicle,
  describeVehicleError,
  EMPTY_VEHICLE_FORM,
  INJECTION_SYSTEMS,
  ODOMETER_UNIT_LABELS,
  SIZE_BY_VEHICLE_TYPE,
  SIZE_CLASS_LABELS,
  SIZE_CLASSES,
  updateVehicle,
  VEHICLE_TYPE_LABELS,
  VEHICLE_TYPES,
  vehicleToForm,
  type OdometerUnit,
  type SizeClass,
  type Vehicle,
  type VehicleInput,
  type VehicleType,
} from '@/src/lib/vehicles';

/**
 * Alta/edición de vehículo. Compartido entre la pantalla de Vehículos y el
 * ingreso de vehículos (que necesita poder cargar uno nuevo sin salir de
 * esa pantalla).
 */
export function VehicleModal({
  vehicle,
  customers,
  fixedCustomerId,
  onClose,
  onSaved,
}: {
  vehicle: Vehicle | null;
  customers: Customer[];
  /** Si se pasa, el cliente ya viene elegido (el ingreso ya sabe para quién es) y no se puede cambiar. */
  fixedCustomerId?: string;
  onClose: () => void;
  onSaved: (vehicle: Vehicle) => void;
}) {
  const [form, setForm] = React.useState<VehicleInput>(
    vehicle ? vehicleToForm(vehicle) : { ...EMPTY_VEHICLE_FORM, customerId: fixedCustomerId ?? '' }
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
      const saved = vehicle ? await updateVehicle(vehicle.id, form) : await createVehicle(form);
      onSaved(saved);
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
              {!fixedCustomerId && (
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
              )}

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
                  onChange={(e) => {
                    const vehicleType = e.target.value as VehicleType;
                    // Cambiar el tipo repropone el tamaño típico. Pisa lo que
                    // hubiera: es más predecible que adivinar si el usuario ya
                    // lo tocó, y el campo queda al lado para corregirlo.
                    patch({ vehicleType, sizeClass: SIZE_BY_VEHICLE_TYPE[vehicleType] });
                  }}
                  className={cn(inputClass, 'bg-panel')}
                >
                  {VEHICLE_TYPES.map((type) => (
                    <option key={type} value={type}>{VEHICLE_TYPE_LABELS[type]}</option>
                  ))}
                </select>
              </label>
              <label className={cn(labelClass, 'col-span-3')}>
                Tamaño en playa
                <select
                  value={form.sizeClass}
                  onChange={(e) => patch({ sizeClass: e.target.value as SizeClass })}
                  className={cn(inputClass, 'bg-panel')}
                >
                  {SIZE_CLASSES.map((size) => (
                    <option key={size} value={size}>{SIZE_CLASS_LABELS[size]}</option>
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

              <label className={cn(labelClass, 'col-span-3')}>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
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
