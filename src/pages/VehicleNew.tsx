import React from 'react';
import { Truck, Cog, Gauge, Save, Users } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import {
  createVehicle,
  EMPTY_VEHICLE_FORM,
  fetchVehicles,
  INJECTION_SYSTEMS,
  ODOMETER_UNIT_LABELS,
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
import {
  fetchVehicleBrands,
  fetchVehicleModels,
  modelsOfBrand,
  registerBrandAndModel,
  type VehicleBrand,
  type VehicleModel,
} from '@/src/lib/vehicleCatalog';

const labelClass = 'text-xs font-bold uppercase tracking-wider text-text-soft';
const inputClass =
  'mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none';

/**
 * Ingreso de vehículos, a pantalla completa.
 *
 * Antes era una ventana emergente y quedaba apretada: son veinte campos entre
 * identificación, motor y uso. Acá entra con el mismo ancho que la orden de
 * trabajo y las secciones se separan como en ella.
 *
 * La ventana emergente NO desaparece: sigue viva donde el alta ocurre en medio
 * de otra carga (el "+ Nuevo" del alta de OT y el de cotizaciones). Ahí irse a
 * otra pantalla haría perder la recepción a medio escribir.
 */
export function VehicleNew() {
  const { role } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = React.useState<VehicleInput>(EMPTY_VEHICLE_FORM);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [brands, setBrands] = React.useState<VehicleBrand[]>([]);
  const [models, setModels] = React.useState<VehicleModel[]>([]);
  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /**
   * Cuando la patente tipeada coincide con un vehículo ya cargado, se pasa a
   * editar ESE vehículo en vez de crear un duplicado. Guarda su id.
   */
  const [existente, setExistente] = React.useState<Vehicle | null>(null);

  React.useEffect(() => {
    let cancelado = false;
    fetchCustomers(true)
      .then((data) => !cancelado && setCustomers(data))
      .catch((err) => !cancelado && setError(getErrorMessage(err)));
    // El catálogo y el padrón son sugerencias: si fallan, el alta sigue
    // andando, solo que sin autocompletado.
    fetchVehicleBrands().then((d) => !cancelado && setBrands(d)).catch(() => {});
    fetchVehicleModels().then((d) => !cancelado && setModels(d)).catch(() => {});
    fetchVehicles().then((d) => !cancelado && setVehicles(d)).catch(() => {});
    return () => { cancelado = true; };
  }, []);

  function patch(changes: Partial<VehicleInput>) {
    setForm((current) => ({ ...current, ...changes }));
  }

  /**
   * La patente identifica al vehículo, y el vehículo ya sabe de quién es. Si
   * la que se tipea coincide con una cargada, se trae todo —cliente incluido—
   * en vez de dejar que se cargue el mismo vehículo dos veces con dueños
   * distintos.
   */
  function handlePatente(valor: string) {
    const patente = valor.toUpperCase();
    patch({ licensePlate: patente });

    const limpia = patente.replace(/[\s-]/g, '');
    if (limpia.length < 5) {
      if (existente) setExistente(null);
      return;
    }

    const encontrado = vehicles.find(
      (v) => (v.licensePlate ?? '').replace(/[\s-]/g, '').toUpperCase() === limpia
    );
    if (!encontrado) {
      if (existente) setExistente(null);
      return;
    }
    if (existente?.id === encontrado.id) return;

    setExistente(encontrado);
    setForm({ ...vehicleToForm(encontrado), licensePlate: patente });
  }

  const modelosDeLaMarca = modelsOfBrand(brands, models, form.brand);
  const clienteDelExistente = existente
    ? customers.find((c) => c.id === existente.customerId)?.name ?? null
    : null;

  if (role !== 'admin') return <Navigate to="/" replace />;

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
    if (!form.sizeClass) {
      setError('Elegí el tamaño del vehículo: define cuánto lugar ocupa en la playa.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (existente) await updateVehicle(existente.id, form);
      else await createVehicle(form);

      // Después de guardar, nunca antes: si el alta falla, el catálogo no se
      // ensucia con una marca que en realidad no se usó. Y si esto falla, el
      // vehículo ya quedó guardado igual, así que no se interrumpe por algo
      // que no le importa a quien está cargando.
      registerBrandAndModel(form.brand, form.model).catch(() => {});

      navigate('/vehiculos');
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={existente ? 'Editar vehículo' : 'Ingreso de vehículo'}
        subtitle={
          existente
            ? 'Esa patente ya estaba cargada: se está editando ese vehículo, no creando otro.'
            : 'Ficha del equipo que entra al taller. La patente lo identifica; el cliente queda vinculado a él.'
        }
      />

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
        )}

        {existente && (
          <div className="rounded-md border border-state-wait/40 bg-state-wait/10 px-4 py-3 text-sm text-state-wait">
            La patente <span className="font-mono font-semibold">{form.licensePlate}</span> ya
            pertenece a un vehículo{clienteDelExistente ? ` de ${clienteDelExistente}` : ''}. Los
            campos se completaron con sus datos: si guardás, lo estás modificando.
          </div>
        )}

        {/* ── Cliente ─────────────────────────────────────────────────── */}
        <Panel className="p-5">
          <SectionHeader title={<><Users size={15} className="mr-1.5 inline-block align-[-2px]" />Cliente</>} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <label className={cn(labelClass, 'sm:col-span-4')}>
              Cliente propietario *
              <select
                value={form.customerId}
                onChange={(e) => patch({ customerId: e.target.value })}
                className={cn(inputClass, 'bg-panel')}
              >
                <option value="">Elegí un cliente…</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}{customer.taxId ? ` — ${formatCuit(customer.taxId)}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Patente
              <input
                value={form.licensePlate}
                onChange={(e) => handlePatente(e.target.value)}
                className={cn(inputClass, 'font-mono uppercase')}
                placeholder="ABC-123"
              />
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Si ya está cargada, se traen sus datos y su cliente.
              </span>
            </label>
          </div>
        </Panel>

        {/* ── Vehículo ────────────────────────────────────────────────── */}
        <Panel className="p-5">
          <SectionHeader title={<><Truck size={15} className="mr-1.5 inline-block align-[-2px]" />Vehículo</>} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Marca
              <input
                value={form.brand}
                onChange={(e) => patch({ brand: e.target.value })}
                list="catalogo-marcas"
                className={inputClass}
                placeholder="Volvo"
              />
              <datalist id="catalogo-marcas">
                {brands.map((b) => <option key={b.id} value={b.name} />)}
              </datalist>
            </label>
            <label className={cn(labelClass, 'sm:col-span-4')}>
              Modelo *
              <input
                value={form.model}
                onChange={(e) => patch({ model: e.target.value })}
                list="catalogo-modelos"
                className={inputClass}
                placeholder="FH16 750"
              />
              {/* Solo los de la marca elegida: mezclar todos convertiría la
                  ayuda en una lista larguísima de modelos de otras marcas. */}
              <datalist id="catalogo-modelos">
                {modelosDeLaMarca.map((m) => <option key={m.id} value={m.name} />)}
              </datalist>
            </label>

            <label className={cn(labelClass, 'sm:col-span-3')}>
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
            <label className={cn(labelClass, 'sm:col-span-3')}>
              Tamaño en playa *
              <select
                value={form.sizeClass}
                onChange={(e) => patch({ sizeClass: e.target.value as SizeClass })}
                className={cn(inputClass, 'bg-panel')}
              >
                <option value="">Elegí el tamaño…</option>
                {SIZE_CLASSES.map((size) => (
                  <option key={size} value={size}>{SIZE_CLASS_LABELS[size]}</option>
                ))}
              </select>
            </label>

            <label className={cn(labelClass, 'sm:col-span-2')}>
              Año
              <input
                type="number"
                value={form.year}
                onChange={(e) => patch({ year: e.target.value })}
                className={inputClass}
                placeholder="2019"
              />
            </label>
            <label className={cn(labelClass, 'sm:col-span-4')}>
              N° de chasis (VIN)
              <input
                value={form.vin}
                onChange={(e) => patch({ vin: e.target.value })}
                className={cn(inputClass, 'font-mono')}
                placeholder="9BM958..."
              />
            </label>
          </div>
        </Panel>

        {/* ── Motor e inyección ───────────────────────────────────────── */}
        <Panel className="p-5">
          <SectionHeader title={<><Cog size={15} className="mr-1.5 inline-block align-[-2px]" />Motor e inyección</>} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Marca motor
              <input value={form.engineBrand} onChange={(e) => patch({ engineBrand: e.target.value })} className={inputClass} placeholder="Volvo" />
            </label>
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Modelo motor
              <input value={form.engineModel} onChange={(e) => patch({ engineModel: e.target.value })} className={inputClass} placeholder="D16G" />
            </label>
            <label className={cn(labelClass, 'sm:col-span-2')}>
              N° de motor
              <input value={form.engineNumber} onChange={(e) => patch({ engineNumber: e.target.value })} className={cn(inputClass, 'font-mono')} placeholder="D16G123456" />
            </label>
            <label className={cn(labelClass, 'sm:col-span-6')}>
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
        </Panel>

        {/* ── Uso y estado ────────────────────────────────────────────── */}
        <Panel className="p-5">
          <SectionHeader title={<><Gauge size={15} className="mr-1.5 inline-block align-[-2px]" />Uso y estado</>} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <label className={cn(labelClass, 'sm:col-span-3')}>
              Kilometraje / Horas
              <input
                type="number"
                min="0"
                value={form.odometer}
                onChange={(e) => patch({ odometer: e.target.value })}
                className={cn(inputClass, 'text-right')}
                placeholder="0"
              />
            </label>
            <label className={cn(labelClass, 'sm:col-span-3')}>
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
            <label className={cn(labelClass, 'sm:col-span-6')}>
              Observaciones
              <textarea
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
                rows={2}
                className={cn(inputClass, 'resize-y')}
                placeholder="Historial, particularidades del equipo…"
              />
            </label>
          </div>
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => patch({ active: e.target.checked })}
              className="h-4 w-4 accent-accent-deep"
            />
            Activo (disponible para nuevas órdenes de trabajo)
          </label>
        </Panel>

        <div className="flex justify-end gap-2 pb-6">
          <Button type="button" variant="ghost" onClick={() => navigate('/vehiculos')}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            <Save size={16} /> {saving ? 'Guardando…' : existente ? 'Guardar cambios' : 'Guardar vehículo'}
          </Button>
        </div>
      </form>
    </div>
  );
}
