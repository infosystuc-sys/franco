import React from 'react';
import { Plus, X, Search, ClipboardList, Camera } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader, Panel, StateStrip } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { CustomerModal } from '@/src/components/CustomerModal';
import { VehicleModal } from '@/src/components/VehicleModal';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { vehicleLabel, type Vehicle } from '@/src/lib/vehicles';
import {
  createVehicleIntake,
  describeVehicleIntakeError,
  fetchVehicleIntakes,
  VEHICLE_INTAKE_STATUS_LABELS,
  VEHICLE_INTAKE_STATUS_STRIP,
  type VehicleIntakeListRow,
} from '@/src/lib/vehicleIntakes';

export function VehicleIntakes() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const navigate = useNavigate();

  const [intakes, setIntakes] = React.useState<VehicleIntakeListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  const loadIntakes = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setIntakes(await fetchVehicleIntakes());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadIntakes();
  }, [isAdmin, loadIntakes]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return intakes;
    return intakes.filter((i) =>
      [i.number, i.customerName, i.vehicleLabel, i.component]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(term))
    );
  }, [intakes, search]);

  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Ingreso de vehículos"
        subtitle="Se registra cuándo entra un vehículo al taller, antes de cotizar."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Nuevo ingreso
          </Button>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Número, cliente, vehículo, componente..."
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <Panel className="overflow-x-auto overflow-y-hidden">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1 w-32">Ingreso</th>
              <th className="px-3 py-1">Cliente</th>
              <th className="px-3 py-1">Vehículo / Equipo</th>
              <th className="px-3 py-1">Componente</th>
              <th className="px-3 py-1 w-20 text-center">Fotos</th>
              <th className="px-3 py-1 w-40">Estado</th>
              <th className="px-3 py-1 w-28">Fecha</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-text-soft">Cargando ingresos…</td></tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-text-soft">
                  {intakes.length === 0 ? (
                    <span className="flex flex-col items-center gap-2">
                      <ClipboardList size={24} className="text-text-faint" />
                      Todavía no hay ingresos registrados.
                    </span>
                  ) : (
                    'Ningún ingreso coincide con la búsqueda.'
                  )}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((intake) => (
                <tr
                  key={intake.id}
                  onClick={() => navigate(`/ingresos/${intake.id}`)}
                  className="relative h-11 border-b border-line transition-colors hover:bg-panel-alt cursor-pointer"
                >
                  <td data-primary className="relative px-4 py-1">
                    <StateStrip color={VEHICLE_INTAKE_STATUS_STRIP[intake.status]} />
                    <span className="font-mono font-semibold text-text">{intake.number}</span>
                  </td>
                  <td data-label="Cliente" className="px-3 py-1">{intake.customerName}</td>
                  <td data-label="Vehículo" className="px-3 py-1 text-text-soft">{intake.vehicleLabel}</td>
                  <td data-label="Componente" className="px-3 py-1 text-text-soft">
                    {intake.component || <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Fotos" className="px-3 py-1 text-center text-text-soft">
                    {intake.photoCount > 0 ? (
                      <span className="inline-flex items-center gap-1"><Camera size={13} /> {intake.photoCount}</span>
                    ) : (
                      <span className="text-text-faint">—</span>
                    )}
                  </td>
                  <td data-label="Estado" className="px-3 py-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                      {VEHICLE_INTAKE_STATUS_LABELS[intake.status]}
                    </span>
                    {intake.quotationNumber && (
                      <Link
                        to={`/cotizacion/${intake.quotationNumber}`}
                        onClick={(e) => e.stopPropagation()}
                        className="ml-2 text-[11px] text-accent-deep hover:underline"
                      >
                        {intake.quotationNumber}
                      </Link>
                    )}
                  </td>
                  <td data-label="Fecha" className="px-3 py-1 text-text-soft">
                    {new Date(intake.createdAt).toLocaleDateString('es-AR')}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>

      {creating && (
        <NewVehicleIntakeModal
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/ingresos/${id}`)}
        />
      )}
    </div>
  );
}

function NewVehicleIntakeModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = React.useState(true);
  const [customerId, setCustomerId] = React.useState('');
  const [vehicleId, setVehicleId] = React.useState('');
  const [component, setComponent] = React.useState('');
  const [observations, setObservations] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [creatingCustomer, setCreatingCustomer] = React.useState(false);
  const [creatingVehicle, setCreatingVehicle] = React.useState(false);

  const loadCustomers = React.useCallback(() => {
    setLoadingCustomers(true);
    return fetchCustomers(true)
      .then((data) => setCustomers(data))
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoadingCustomers(false));
  }, []);

  React.useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  const vehicles = (selectedCustomer?.vehicles ?? []).filter((v) => v.active);

  function handleCustomerChange(id: string) {
    setCustomerId(id);
    const customer = customers.find((c) => c.id === id);
    const activeVehicles = (customer?.vehicles ?? []).filter((v) => v.active);
    setVehicleId(activeVehicles.length === 1 ? activeVehicles[0].id : '');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!customerId) { setError('Elegí un cliente.'); return; }
    if (!vehicleId) { setError('Elegí un vehículo.'); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await createVehicleIntake({ customerId, vehicleId, component, observations });
      onCreated(created.id);
    } catch (err) {
      setError(describeVehicleIntakeError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  const labelClass = 'text-xs font-bold uppercase tracking-wider text-text-soft';
  const inputClass = 'mt-1 w-full border border-line px-3 py-2 text-sm font-normal normal-case';

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
        <div className="bg-panel w-full max-w-md">
          <div className="flex justify-between items-center px-5 py-4 border-b border-line">
            <h2 className="text-base font-bold text-text">Nuevo ingreso</h2>
            <button onClick={onClose} className="text-text-soft hover:text-text">
              <X size={18} />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

            <label className={cn(labelClass, 'block')}>
              Cliente
              <div className="mt-1 flex gap-2">
                <select
                  value={customerId}
                  onChange={(e) => handleCustomerChange(e.target.value)}
                  disabled={loadingCustomers}
                  className={cn(inputClass, 'bg-panel mt-0 flex-1')}
                >
                  <option value="">{loadingCustomers ? 'Cargando clientes...' : 'Elegí un cliente...'}</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}{customer.taxId ? ` — ${formatCuit(customer.taxId)}` : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setCreatingCustomer(true)}
                  className="border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt whitespace-nowrap"
                >
                  + Nuevo
                </button>
              </div>
            </label>

            <label className={cn(labelClass, 'block')}>
              Vehículo / Equipo
              <div className="mt-1 flex gap-2">
                <select
                  value={vehicleId}
                  onChange={(e) => setVehicleId(e.target.value)}
                  disabled={!selectedCustomer}
                  className={cn(inputClass, 'bg-panel disabled:bg-panel-alt mt-0 flex-1')}
                >
                  <option value="">{!selectedCustomer ? 'Elegí primero un cliente...' : 'Elegí un vehículo...'}</option>
                  {vehicles.map((vehicle) => (
                    <option key={vehicle.id} value={vehicle.id}>{vehicleLabel(vehicle)}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setCreatingVehicle(true)}
                  disabled={!selectedCustomer}
                  className="border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt disabled:opacity-50 whitespace-nowrap"
                >
                  + Nuevo
                </button>
              </div>
            </label>

            <label className={cn(labelClass, 'block')}>
              Componente
              <input value={component} onChange={(e) => setComponent(e.target.value)} className={inputClass} placeholder="Ej: Bomba de Inyección Common Rail" />
            </label>

            <label className={cn(labelClass, 'block')}>
              Observaciones
              <textarea
                value={observations}
                onChange={(e) => setObservations(e.target.value)}
                rows={3}
                className={cn(inputClass, 'resize-y')}
                placeholder="Estado del vehículo al ingresar, lo que cuenta el cliente, etc."
              />
            </label>

            <p className="text-[10px] font-normal normal-case text-text-soft">
              Las fotos se agregan en la pantalla del ingreso, después de guardar.
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="bg-accent text-accent-ink font-semibold text-[11px] uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
              >
                {saving ? 'Creando...' : 'Crear ingreso'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {creatingCustomer && (
        <CustomerModal
          customer={null}
          onClose={() => setCreatingCustomer(false)}
          onSaved={async (customer) => {
            setCreatingCustomer(false);
            await loadCustomers();
            handleCustomerChange(customer.id);
          }}
        />
      )}

      {creatingVehicle && selectedCustomer && (
        <VehicleModal
          vehicle={null}
          customers={customers}
          fixedCustomerId={selectedCustomer.id}
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
