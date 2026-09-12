import React from 'react';
import { Trash2, X } from 'lucide-react';
import { useAuth } from '@/src/lib/auth';
import { Button, Label, fieldClass } from '@/src/components/ui';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { conElUsuarioIncluido, fetchEmpleadoDelUsuario, fetchOperarios, type Employee } from '@/src/lib/employees';
import { disponibilidad, fetchYardCells, fetchYardOccupancy, type YardAvailability } from '@/src/lib/yardCapacity';
import { vehicleLabel, type Vehicle } from '@/src/lib/vehicles';
import { CustomerModal } from '@/src/components/CustomerModal';
import { VehicleModal } from '@/src/components/VehicleModal';
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
  initialVehicleId,
}: {
  onClose: () => void;
  onCreated: (workOrder: { number: string }) => void;
  /** Vehículo recién recibido en el ingreso: llega elegido, con su dueño. */
  initialVehicleId?: string | null;
}) {
  const { session } = useAuth();
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = React.useState(true);
  const [customerId, setCustomerId] = React.useState('');
  // Quién la toma. Opcional: en la recepción puede no estar decidido todavía.
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = React.useState('');
  const [estimatedDelivery, setEstimatedDelivery] = React.useState('');
  // Cuánto lugar queda, para avisar —nunca para bloquear—. El vehículo ya está
  // en la puerta del taller: un sistema que impide registrarlo solo consigue
  // que el dato deje de cargarse.
  const [lugar, setLugar] = React.useState<YardAvailability | null>(null);
  const [vehicleId, setVehicleId] = React.useState('');
  const [component, setComponent] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Qué se recibe define si el vehículo es obligatorio: una pieza suelta
  // puede llegar sin que su equipo de origen esté en la playa.
  const [receptionKind, setReceptionKind] = React.useState<ReceptionKind>('VEHICULO');

  /**
   * Cambiar qué se recibe invalida lo elegido: un vehículo no puede quedar
   * seleccionado cuando ahora se está recibiendo una pieza. Sin esto el id
   * viejo viajaba igual al guardar.
   */
  function handleReceptionKindChange(kind: ReceptionKind) {
    setReceptionKind(kind);
    setVehicleId('');
  }
  const [observations, setObservations] = React.useState('');
  // Las piezas se juntan acá y se guardan recién cuando la OT existe: no hay
  // work_order_id contra el cual insertarlas hasta ese momento.
  const [parts, setParts] = React.useState<{ name: string; serialNumber: string }[]>([]);
  const [partName, setPartName] = React.useState('');
  const [partSerial, setPartSerial] = React.useState('');
  // Alta al vuelo: el vehículo llega con un cliente que todavía no está
  // cargado, y mandar al usuario a otra pantalla le hace perder la recepción a
  // medio escribir.
  const [creatingCustomer, setCreatingCustomer] = React.useState(false);
  const [creatingVehicle, setCreatingVehicle] = React.useState(false);

  // Se reusa después de dar de alta un cliente o un vehículo: los vehículos
  // vienen anidados en la consulta de clientes, así que un solo refresco
  // actualiza las dos listas.
  const loadCustomers = React.useCallback(async () => {
    const data = await fetchCustomers(true);
    setCustomers(data);
    return data;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    loadCustomers()
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoadingCustomers(false));
    // Sin operarios se puede crear igual la orden, sin asignar. Que falle
    // esta lista no es motivo para trabar una recepción.
    Promise.all([fetchOperarios(), fetchEmpleadoDelUsuario(session?.user?.id)])
      .then(([operarios, propio]) => {
        if (cancelled) return;
        setEmployees(conElUsuarioIncluido(operarios, propio));
        // Queda sugerido quien está cargando la orden: es quien la toma casi
        // siempre. Se puede cambiar antes de guardar.
        if (propio) setEmployeeId((actual) => actual || propio.id);
      })
      .catch(() => {});
    Promise.all([fetchYardCells(), fetchYardOccupancy()])
      .then(([celdas, ocupantes]) => {
        if (!cancelled) setLugar(disponibilidad(celdas, ocupantes));
      })
      .catch(() => {/* informativo: si falla, el alta sigue funcionando igual */});
    return () => {
      cancelled = true;
    };
  }, [loadCustomers]);

  /**
   * El ingreso de vehículo encadena hasta acá con el vehículo ya cargado.
   * Se resuelve recién cuando llegaron los clientes, porque el dueño y el
   * tipo de recepción salen de la ficha: solo con el id no alcanza para
   * saber si es un vehículo o una pieza.
   */
  React.useEffect(() => {
    if (!initialVehicleId || customers.length === 0) return;
    const dueno = customers.find((c) =>
      (c.vehicles ?? []).some((v) => v.id === initialVehicleId)
    );
    const ficha = (dueno?.vehicles ?? []).find((v) => v.id === initialVehicleId);
    if (!dueno || !ficha) return;
    setReceptionKind(ficha.kind);
    setCustomerId(dueno.id);
    setVehicleId(ficha.id);
  }, [initialVehicleId, customers]);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  // Se ofrece lo que coincide con lo que se está recibiendo. Sin este filtro
  // una pieza podía elegirse como vehículo y quedaba ocupando una celda de la
  // playa sin estar ocupando nada.
  const vehicles = (selectedCustomer?.vehicles ?? []).filter(
    (v) => v.active && v.kind === receptionKind
  );

  // Al cambiar de cliente, se preselecciona su vehículo si tiene uno solo.
  function handleCustomerChange(id: string) {
    setCustomerId(id);
    const customer = customers.find((c) => c.id === id);
    const disponibles = (customer?.vehicles ?? []).filter(
      (v) => v.active && v.kind === receptionKind
    );
    setVehicleId(disponibles.length === 1 ? disponibles[0].id : '');
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
    // Solo para vehículos: una pieza sobre el mostrador no ocupa celda, así que
    // pedirle una fecha sería un campo obligatorio sin función — de los que se
    // terminan llenando con cualquier cosa.
    if (receptionKind === 'VEHICULO' && !estimatedDelivery) {
      setError('Poné la entrega estimada: es lo que permite saber cuándo se libera el lugar en la playa.');
      return;
    }
    setSaving(true);
    setError(null);

    // El alta de la OT y el guardado de piezas van en pasos separados a
    // propósito: una vez creada la OT, un trigger de la base ya le mandó el
    // aviso de "Ingresado" al cliente por WhatsApp y el número quedó
    // asignado. Si de acá en más algo falla, NO puede parecer que no se
    // guardó nada — si el usuario reintenta creyendo eso, se crea una
    // segunda OT del mismo vehículo y el cliente recibe un segundo aviso por
    // la misma recepción física.
    let workOrder;
    try {
      workOrder = await createWorkOrder({
        customerId,
        vehicleId: vehicleId || null,
        component,
        receptionKind,
        observations,
        employeeId: employeeId || null,
        estimatedDeliveryDate: receptionKind === 'VEHICULO' ? estimatedDelivery : null,
      });
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
      return;
    }

    // A partir de acá la orden existe. Las piezas que no se pudieron guardar
    // se avisan por separado (no bloquean el alta) y quedan para cargarlas
    // desde el detalle — nunca se vuelve a intentar crear la OT.
    const noGuardadas: string[] = [];
    for (const p of parts) {
      try {
        await addReceivedPart(workOrder.id, p.name, p.serialNumber);
      } catch {
        noGuardadas.push(p.name);
      }
    }
    if (noGuardadas.length > 0) {
      window.alert(
        `La orden ${workOrder.number} se creó, pero no se pudieron guardar estas piezas: ` +
        `${noGuardadas.join(', ')}. Cargalas desde el detalle de la orden.`
      );
    }
    setSaving(false);
    onCreated(workOrder);
  }

  return (
    <>
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col border border-line-strong bg-panel">
        <div className="flex items-center justify-between border-b border-line bg-panel-head px-5 py-3">
          <h2 className="font-display text-xl uppercase tracking-[0.04em] text-text-faint">
            Nueva orden de trabajo
          </h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <div className="grid grid-cols-1 gap-4">
            <Label>
              Qué se recibe
              <select
                value={receptionKind}
                onChange={(e) => handleReceptionKindChange(e.target.value as ReceptionKind)}
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

            {receptionKind === 'VEHICULO' && lugar !== null && (
              <p className={
                lugar.medianos > 0
                  ? 'border border-line bg-panel-alt px-3 py-2 text-[11px] text-text-soft'
                  : 'border border-danger/40 bg-danger-soft px-3 py-2 text-[11px] text-danger'
              }>
                {lugar.medianos > 0
                  ? `En la playa entran ${lugar.grandes} grande${lugar.grandes === 1 ? '' : 's'} o ${lugar.medianos} mediano${lugar.medianos === 1 ? '' : 's'}.`
                  : 'La playa está completa. Se puede recibir igual, pero no queda lugar.'}
              </p>
            )}

            <Label>
              Cliente
              <div className="flex gap-2">
                <select
                  value={customerId}
                  onChange={(e) => handleCustomerChange(e.target.value)}
                  disabled={loadingCustomers}
                  className={fieldClass(true, 'font-normal normal-case flex-1')}
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
                <button
                  type="button"
                  onClick={() => setCreatingCustomer(true)}
                  className="whitespace-nowrap border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt"
                >
                  + Nuevo
                </button>
              </div>
              {!loadingCustomers && customers.length === 0 && (
                <span className="mt-1 block text-[11px] font-normal normal-case text-danger">
                  No hay clientes activos. Cargá uno con el botón "+ Nuevo".
                </span>
              )}
            </Label>

            <Label>
              Vehículo / Equipo
              <div className="flex gap-2">
                <select
                  value={vehicleId}
                  onChange={(e) => setVehicleId(e.target.value)}
                  disabled={!selectedCustomer}
                  className={fieldClass(receptionKind === 'VEHICULO', 'font-normal normal-case flex-1 disabled:bg-panel-alt')}
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
                {/* El vehículo se da de alta contra el cliente elegido, así que
                    sin cliente no hay contra quién crearlo. */}
                <button
                  type="button"
                  disabled={!selectedCustomer}
                  onClick={() => setCreatingVehicle(true)}
                  className="whitespace-nowrap border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  + Nuevo
                </button>
              </div>
              {selectedCustomer && vehicles.length === 0 && (
                <span className="mt-1 block text-[11px] font-normal normal-case text-danger">
                  Este cliente no tiene vehículos activos. Agregale uno con el botón "+ Nuevo".
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
              Empleado
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className={fieldClass(false, 'font-normal normal-case bg-panel')}
              >
                <option value="">Sin asignar</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>{employee.name}</option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                El operario que elijas pasa a ver esta orden en su pantalla; los demás dejan de verla.
              </span>
            </Label>

            {receptionKind === 'VEHICULO' && (
              <Label>
                Entrega estimada
                <input
                  type="date"
                  value={estimatedDelivery}
                  onChange={(e) => setEstimatedDelivery(e.target.value)}
                  className={fieldClass(true, 'font-normal normal-case')}
                />
                <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                  Cuándo se estima entregarlo. Es lo que deja proyectar cuándo se
                  libera su lugar en la playa; se puede corregir después.
                </span>
              </Label>
            )}

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

    {/* Van DESPUÉS del modal de la OT a propósito: los tres comparten z-[60],
        así que con igual z-index manda el orden del DOM y el que va último
        pinta encima. Alternativa era subirle el z a los componentes
        compartidos, que los usan otras tres pantallas. */}
    {creatingCustomer && (
      <CustomerModal
        customer={null}
        onClose={() => setCreatingCustomer(false)}
        onSaved={async (customer) => {
          setCreatingCustomer(false);
          await loadCustomers();
          // No pasa por handleCustomerChange: esa función lee `customers` del
          // render viejo, que todavía no tiene al recién creado. Un cliente
          // nuevo no tiene vehículos, así que la selección arranca vacía.
          setCustomerId(customer.id);
          setVehicleId('');
        }}
      />
    )}

    {creatingVehicle && selectedCustomer && (
      <VehicleModal
        vehicle={null}
        customers={customers}
        fixedCustomerId={selectedCustomer.id}
        fixedKind={receptionKind}
        onClose={() => setCreatingVehicle(false)}
        onSaved={async (vehicle: Vehicle) => {
          setCreatingVehicle(false);
          await loadCustomers();
          setVehicleId(vehicle.id);
        }}
      />
    )}
    </>
  );
}
