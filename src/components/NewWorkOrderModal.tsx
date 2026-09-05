import React from 'react';
import { Trash2, X } from 'lucide-react';
import { Button, Label, fieldClass } from '@/src/components/ui';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { vehicleLabel } from '@/src/lib/vehicles';
import {
  addReceivedPart,
  createWorkOrder,
  getErrorMessage,
  RECEPTION_KIND_LABELS,
  RECEPTION_KINDS,
  type ReceptionKind,
} from '@/src/lib/workOrders';

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
  // Qué se recibe define si el vehículo es obligatorio: una pieza suelta
  // puede llegar sin que su equipo de origen esté en la playa.
  const [receptionKind, setReceptionKind] = React.useState<ReceptionKind>('VEHICULO');
  const [observations, setObservations] = React.useState('');
  // Las piezas se juntan acá y se guardan recién cuando la OT existe: no hay
  // work_order_id contra el cual insertarlas hasta ese momento.
  const [parts, setParts] = React.useState<{ name: string; serialNumber: string }[]>([]);
  const [partName, setPartName] = React.useState('');
  const [partSerial, setPartSerial] = React.useState('');

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
    // Única validación nueva: el vehículo solo es obligatorio cuando lo que
    // se recibe es el vehículo mismo. Una pieza suelta puede no tener uno
    // (puede no estar en el padrón, o simplemente no importar para el caso).
    if (receptionKind === 'VEHICULO' && !vehicleId) {
      setError('Elegí el vehículo que estás recibiendo, o cambiá "Qué se recibe" a pieza suelta.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const workOrder = await createWorkOrder({
        customerId,
        vehicleId: vehicleId || null,
        component,
        receptionKind,
        observations,
      });
      // Las piezas van después: recién ahora existe la OT contra la cual
      // colgarlas. Si alguna falla, la OT ya está creada y no se pierde la
      // recepción — se avisa y se cargan desde el detalle.
      for (const p of parts) {
        await addReceivedPart(workOrder.id, p.name, p.serialNumber);
      }
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
              Qué se recibe
              <select
                value={receptionKind}
                onChange={(e) => setReceptionKind(e.target.value as ReceptionKind)}
                className={fieldClass(false, 'font-normal normal-case bg-panel')}
              >
                {RECEPTION_KINDS.map((k) => (
                  <option key={k} value={k}>{RECEPTION_KIND_LABELS[k]}</option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Una pieza suelta no ocupa lugar en la playa, aunque se elija de qué equipo salió.
              </span>
            </Label>

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
                className={fieldClass(receptionKind === 'VEHICULO', 'font-normal normal-case disabled:bg-panel-alt')}
              >
                <option value="">
                  {!selectedCustomer
                    ? 'Elegí primero un cliente'
                    : receptionKind === 'PIEZA'
                      ? 'Sin vehículo (opcional)'
                      : 'Elegí un vehículo...'}
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

            <Label>
              Observaciones de la recepción
              <textarea
                value={observations}
                onChange={(e) => setObservations(e.target.value)}
                rows={2}
                placeholder="Estado en que llegó, faltantes, lo que dijo el cliente..."
                className={fieldClass(false, 'font-normal normal-case resize-y')}
              />
            </Label>

            <div className="space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-text-soft">
                Piezas recibidas
              </span>
              {parts.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {parts.map((p, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span>{p.name} — <span className="font-mono text-xs">{p.serialNumber}</span></span>
                      <button
                        type="button"
                        onClick={() => setParts((c) => c.filter((_, j) => j !== i))}
                        aria-label={`Quitar ${p.name}`}
                        className="text-text-soft hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <input
                  value={partName}
                  onChange={(e) => setPartName(e.target.value)}
                  placeholder="Bomba inyectora"
                  className={fieldClass(false, 'font-normal normal-case mt-0 flex-1')}
                />
                <input
                  value={partSerial}
                  onChange={(e) => setPartSerial(e.target.value)}
                  placeholder="N° de serie"
                  className={fieldClass(false, 'font-normal normal-case mt-0 w-40 font-mono')}
                />
                <button
                  type="button"
                  disabled={!partName.trim() || !partSerial.trim()}
                  onClick={() => {
                    setParts((c) => [...c, { name: partName.trim(), serialNumber: partSerial.trim() }]);
                    setPartName('');
                    setPartSerial('');
                  }}
                  className="border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt disabled:opacity-50"
                >
                  Agregar
                </button>
              </div>
            </div>
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
