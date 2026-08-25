import React from 'react';
import { X } from 'lucide-react';
import { Button, Label, fieldClass } from '@/src/components/ui';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { vehicleLabel } from '@/src/lib/vehicles';
import { createWorkOrder, getErrorMessage } from '@/src/lib/workOrders';

/**
 * Alta de una OT directa, sin cotización previa.
 *
 * Vive en su propio archivo porque la usan dos pantallas: el Panel (donde
 * nació) y el listado de Órdenes de Trabajo. Antes de esta extracción estaba
 * duplicada en ambas, y era cuestión de tiempo que se despegaran.
 */
export function NewWorkOrderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (workOrder: { number: string }) => void;
}) {
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = React.useState(true);
  const [customerId, setCustomerId] = React.useState('');
  const [vehicleId, setVehicleId] = React.useState('');
  const [component, setComponent] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchCustomers(true)
      .then((data) => !cancelled && setCustomers(data))
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoadingCustomers(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  // Solo se ofrecen vehículos activos para nuevas órdenes.
  const vehicles = (selectedCustomer?.vehicles ?? []).filter((v) => v.active);

  // Al cambiar de cliente, se preselecciona su vehículo si tiene uno solo.
  function handleCustomerChange(id: string) {
    setCustomerId(id);
    const customer = customers.find((c) => c.id === id);
    const activeVehicles = (customer?.vehicles ?? []).filter((v) => v.active);
    setVehicleId(activeVehicles.length === 1 ? activeVehicles[0].id : '');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!customerId) {
      setError('Elegí un cliente.');
      return;
    }
    if (!vehicleId) {
      setError('Elegí un vehículo. Si el cliente no tiene ninguno cargado, agregalo desde Clientes.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const workOrder = await createWorkOrder({ customerId, vehicleId, component });
      onCreated(workOrder);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md border border-line-strong bg-panel">
        <div className="flex items-center justify-between border-b border-line bg-panel-head px-5 py-3">
          <h2 className="font-display text-xl uppercase tracking-[0.04em] text-text-faint">
            Nueva orden de trabajo
          </h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <div className="grid grid-cols-1 gap-4">
            <Label>
              Cliente
              <select
                value={customerId}
                onChange={(e) => handleCustomerChange(e.target.value)}
                disabled={loadingCustomers}
                className={fieldClass(true, 'font-normal normal-case')}
              >
                <option value="">
                  {loadingCustomers ? 'Cargando clientes…' : 'Elegí un cliente'}
                </option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                    {customer.taxId ? ` — ${formatCuit(customer.taxId)}` : ''}
                  </option>
                ))}
              </select>
              {!loadingCustomers && customers.length === 0 && (
                <span className="mt-1 block text-[11px] font-normal normal-case text-danger">
                  No hay clientes activos. Cargá uno en Clientes.
                </span>
              )}
            </Label>

            <Label>
              Vehículo / Equipo
              <select
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                disabled={!selectedCustomer}
                className={fieldClass(true, 'font-normal normal-case disabled:bg-panel-alt')}
              >
                <option value="">
                  {!selectedCustomer ? 'Elegí primero un cliente' : 'Elegí un vehículo'}
                </option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicleLabel(vehicle)}
                  </option>
                ))}
              </select>
              {selectedCustomer && vehicles.length === 0 && (
                <span className="mt-1 block text-[11px] font-normal normal-case text-danger">
                  Este cliente no tiene vehículos activos. Agregale uno en Vehículos.
                </span>
              )}
            </Label>

            <Label>
              Componente
              <input
                value={component}
                onChange={(e) => setComponent(e.target.value)}
                className={fieldClass(false, 'font-normal normal-case')}
                placeholder="Bomba de inyección Common Rail"
              />
            </Label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Creando…' : 'Crear orden'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
