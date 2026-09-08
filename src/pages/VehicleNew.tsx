import React from 'react';
import { Truck, Cog, Save, Users, Camera, ChevronDown, ChevronRight } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { CustomerModal } from '@/src/components/CustomerModal';
import {
  createVehicle,
  EMPTY_VEHICLE_FORM,
  fetchVehicles,
  INJECTION_SYSTEMS,
  ODOMETER_UNIT_LABELS,
  SIZE_CLASS_LABELS,
  SIZE_CLASSES,
  VEHICLE_KIND_LABELS,
  VEHICLE_KINDS,
  updateVehicle,
  vehicleToForm,
  type OdometerUnit,
  type SizeClass,
  type Vehicle,
  type VehicleKind,
  type VehicleInput,
} from '@/src/lib/vehicles';
import {
  fetchVehicleBrands,
  fetchVehicleModels,
  modelsOfBrand,
  registerBrandAndModel,
  type VehicleBrand,
  type VehicleModel,
} from '@/src/lib/vehicleCatalog';
import { VehiclePhotos } from '@/src/components/VehiclePhotos';
import { fetchVehiclePhotos, uploadVehiclePhoto, type VehiclePhoto } from '@/src/lib/vehiclePhotos';

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
  /**
   * Los datos del motor y el uso arrancan plegados. En la recepción del día a
   * día alcanza con cliente, patente, marca, modelo y tamaño; el resto se
   * carga cuando hace falta y estorba el 90% de las veces.
   */
  const [verTecnicos, setVerTecnicos] = React.useState(false);
  /**
   * Mientras el equipo no existe no hay id contra el cual guardar una foto, así
   * que se juntan acá y se suben recién después del alta. Mismo criterio que
   * las piezas recibidas del alta de OT.
   */
  const [fotosPendientes, setFotosPendientes] = React.useState<File[]>([]);
  const [fotosGuardadas, setFotosGuardadas] = React.useState<VehiclePhoto[]>([]);

  const [creandoCliente, setCreandoCliente] = React.useState(false);

  const esPieza = form.kind === 'PIEZA';

  const cargarClientes = React.useCallback(async () => {
    setCustomers(await fetchCustomers(true));
  }, []);

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
    const datos = vehicleToForm(encontrado);
    setForm({ ...datos, licensePlate: patente });

    // Si el vehículo ya trae algo del motor o del uso, la sección se abre
    // sola. Plegada, esos datos quedarían escondidos y quien edita no tendría
    // forma de saber que están ahí.
    const tieneTecnicos = !!(
      datos.engineBrand || datos.engineModel || datos.engineNumber ||
      datos.injectionSystem || datos.odometer
    );
    if (tieneTecnicos) setVerTecnicos(true);

    fetchVehiclePhotos(encontrado.id).then(setFotosGuardadas).catch(() => {});
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
    // El tamaño solo se pide al vehículo: una pieza no ocupa lugar en la playa.
    if (form.kind === 'VEHICULO' && !form.sizeClass) {
      setError('Elegí el tamaño del vehículo: define cuánto lugar ocupa en la playa.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const guardado = existente
        ? await updateVehicle(existente.id, form)
        : await createVehicle(form);

      // Después de guardar, nunca antes: si el alta falla, el catálogo no se
      // ensucia con una marca que en realidad no se usó. Y si esto falla, el
      // vehículo ya quedó guardado igual, así que no se interrumpe por algo
      // que no le importa a quien está cargando.
      registerBrandAndModel(form.brand, form.model).catch(() => {});

      // Las fotos van al final, cuando el equipo ya tiene id. Las que fallen se
      // avisan por separado: la ficha ya quedó bien y hacerla fracasar entera
      // por una foto sería peor que decir cuáles no subieron.
      const noSubidas: string[] = [];
      for (const archivo of fotosPendientes) {
        try {
          await uploadVehiclePhoto(guardado.id, archivo);
        } catch {
          noSubidas.push(archivo.name);
        }
      }
      if (noSubidas.length > 0) {
        window.alert(
          `El equipo se guardó, pero no se pudieron subir estas fotos: ${noSubidas.join(', ')}. ` +
          'Podés volver a cargarlas entrando de nuevo por su identificación.'
        );
      }

      navigate('/vehiculos');
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={
          existente
            ? 'Editar equipo'
            : esPieza ? 'Ingreso de pieza' : 'Ingreso de vehículo'
        }
        subtitle={
          existente
            ? 'Esa patente ya estaba cargada: se está editando ese equipo, no creando otro.'
            : esPieza
              ? 'La pieza que queda en el taller. El número de referencia la identifica; el cliente queda vinculado a ella.'
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
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Tipo de ingreso *
              <select
                value={form.kind}
                onChange={(e) => patch({ kind: e.target.value as VehicleKind })}
                className={cn(inputClass, 'bg-panel')}
              >
                {VEHICLE_KINDS.map((k) => (
                  <option key={k} value={k}>{VEHICLE_KIND_LABELS[k]}</option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Una pieza no ocupa lugar en la playa.
              </span>
            </label>

            <label className={cn(labelClass, esPieza ? 'sm:col-span-4' : 'sm:col-span-2')}>
              Cliente propietario *
              <div className="flex gap-2">
                <select
                  value={form.customerId}
                  onChange={(e) => patch({ customerId: e.target.value })}
                  className={cn(inputClass, 'flex-1 bg-panel')}
                >
                  <option value="">Elegí un cliente…</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}{customer.taxId ? ` — ${formatCuit(customer.taxId)}` : ''}
                    </option>
                  ))}
                </select>
                {/* El vehículo llega con un dueño que muchas veces es cliente
                    nuevo: mandarlo a Clientes y volver le haría perder todo lo
                    que ya cargó acá. */}
                <button
                  type="button"
                  onClick={() => setCreandoCliente(true)}
                  className="whitespace-nowrap border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt"
                >
                  + Nuevo
                </button>
              </div>
            </label>

            {/* La patente identifica al vehículo. Una pieza se identifica por
                su número de referencia, que va con el resto de sus datos. */}
            {!esPieza && (
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
            )}
          </div>
        </Panel>

        {/* ── El equipo ──────────────────────────────────────────────
            Una pieza no tiene patente, tamaño ni kilometraje: lo que la
            identifica es el número de referencia. Mostrarle esos campos en
            gris sería peor que no mostrarlos. */}
        <Panel className="p-5">
          <SectionHeader
            title={<><Truck size={15} className="mr-1.5 inline-block align-[-2px]" />{esPieza ? 'Pieza' : 'Vehículo'}</>}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Marca
              <input
                value={form.brand}
                onChange={(e) => patch({ brand: e.target.value })}
                list="catalogo-marcas"
                className={inputClass}
                placeholder={esPieza ? 'Bosch' : 'Volvo'}
              />
              <datalist id="catalogo-marcas">
                {brands.map((b) => <option key={b.id} value={b.name} />)}
              </datalist>
            </label>
            <label className={cn(labelClass, esPieza ? 'sm:col-span-2' : 'sm:col-span-4')}>
              Modelo *
              <input
                value={form.model}
                onChange={(e) => patch({ model: e.target.value })}
                list="catalogo-modelos"
                className={inputClass}
                placeholder={esPieza ? 'VP44' : 'FH16 750'}
              />
              {/* Solo los de la marca elegida: mezclar todos convertiría la
                  ayuda en una lista larguísima de modelos de otras marcas. */}
              <datalist id="catalogo-modelos">
                {modelosDeLaMarca.map((m) => <option key={m.id} value={m.name} />)}
              </datalist>
            </label>

            {esPieza ? (
              <>
                <label className={cn(labelClass, 'sm:col-span-2')}>
                  Número de referencia
                  <input
                    value={form.referenceNumber}
                    onChange={(e) => patch({ referenceNumber: e.target.value })}
                    className={cn(inputClass, 'font-mono')}
                    placeholder="0470504217"
                  />
                </label>

                <div className="sm:col-span-6">
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={form.hasInjectors}
                      onChange={(e) => patch({ hasInjectors: e.target.checked })}
                      className="h-4 w-4 accent-accent-deep"
                    />
                    ¿Viene con inyectores?
                  </label>
                  {/* La cantidad aparece recién al marcar que sí: es el dato
                      que después se discute al devolver el trabajo. */}
                  {form.hasInjectors && (
                    <label className={cn(labelClass, 'mt-3 block sm:max-w-[12rem]')}>
                      Cuántos
                      <input
                        type="number"
                        min="0"
                        value={form.injectorCount}
                        onChange={(e) => patch({ injectorCount: e.target.value })}
                        className={cn(inputClass, 'text-right')}
                        placeholder="6"
                      />
                    </label>
                  )}
                </div>
              </>
            ) : (
              <>
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
                <label className={cn(labelClass, 'sm:col-span-1')}>
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
              </>
            )}
          </div>
        </Panel>

        {/* ── Fotos ──────────────────────────────────────────────────── */}
        <Panel className="p-5">
          <SectionHeader title={<><Camera size={15} className="mr-1.5 inline-block align-[-2px]" />Fotos</>} />
          <VehiclePhotos
            vehicleId={existente?.id ?? null}
            guardadas={fotosGuardadas}
            onGuardadasChange={setFotosGuardadas}
            pendientes={fotosPendientes}
            onPendientesChange={setFotosPendientes}
            onError={setError}
          />
        </Panel>

        {/* ── Motor e inyección (plegada) ─────────────────────────────
            Va plegada porque en la recepción del día a día no se completa:
            alcanza con cliente, patente, marca, modelo y tamaño. Aparece
            desplegada sola cuando el vehículo YA tiene algo cargado, para que
            editando no queden datos escondidos que el usuario no sabe que
            están ahí.

            No aplica a una pieza: una bomba o un inyector no tienen motor. */}
        {!esPieza && (
        <Panel className="p-5">
          <button
            type="button"
            onClick={() => setVerTecnicos((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            {verTecnicos ? <ChevronDown size={16} className="text-text-soft" /> : <ChevronRight size={16} className="text-text-soft" />}
            <span className="font-display text-lg uppercase tracking-[0.08em] leading-none text-text-faint">
              <Cog size={15} className="mr-1.5 inline-block align-[-2px]" />Motor e inyección
            </span>
            <span className="ml-auto text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              {verTecnicos ? 'Ocultar' : 'Completar'}
            </span>
          </button>
          <div className="mt-3 h-px bg-accent" />

          {verTecnicos && (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-6">
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
          )}
        </Panel>
        )}

        {/* Observaciones y estado quedan siempre a la vista: son lo que se
            escribe al recibir, no un dato técnico que se busca. */}
        <Panel className="p-5">
          <label className={labelClass}>
            Observaciones
            <textarea
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              rows={2}
              className={cn(inputClass, 'resize-y')}
              placeholder="Historial, particularidades del equipo…"
            />
          </label>
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

      {creandoCliente && (
        <CustomerModal
          customer={null}
          onClose={() => setCreandoCliente(false)}
          onSaved={async (customer) => {
            setCreandoCliente(false);
            await cargarClientes();
            patch({ customerId: customer.id });
          }}
        />
      )}
    </div>
  );
}
