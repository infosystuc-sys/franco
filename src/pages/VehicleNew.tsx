import React from 'react';
import { Truck, Save, Users, Camera, Plus, Trash2 } from 'lucide-react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import { CustomerModal } from '@/src/components/CustomerModal';
import {
  createVehicle,
  EMPTY_VEHICLE_FORM,
  fetchVehicles,
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
  fetchVehicleParts,
  fetchVehiclePartTypes,
  nuevoRenglon,
  registrarTiposDePieza,
  renglonCargado,
  rotuloDeLaFicha,
  saveVehicleParts,
  type VehiclePart,
  type VehiclePartType,
} from '@/src/lib/vehicleParts';
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
/**
 * Un dato del cliente elegido, solo para mirar. Los datos en blanco se
 * muestran igual, con un guión: que falte el CUIT es información, y esconder
 * el renglón haría creer que ese campo no existe.
 */
function DatoCliente({
  rotulo,
  valor,
  mono,
}: {
  rotulo: string;
  valor: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-soft">{rotulo}</dt>
      <dd className={cn('text-sm text-text', mono && 'font-mono', !valor && 'text-text-soft')}>
        {valor || '—'}
      </dd>
    </div>
  );
}

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
   * Mientras el equipo no existe no hay id contra el cual guardar una foto, así
   * que se juntan acá y se suben recién después del alta. Mismo criterio que
   * las piezas recibidas del alta de OT.
   */
  const [fotosPendientes, setFotosPendientes] = React.useState<File[]>([]);
  const [fotosGuardadas, setFotosGuardadas] = React.useState<VehiclePhoto[]>([]);

  const [creandoCliente, setCreandoCliente] = React.useState(false);

  /**
   * Lo que entra cuando lo que entra son piezas. Arranca con un renglón vacío
   * para que se pueda escribir sin tener que apretar "agregar" primero.
   */
  const [partes, setPartes] = React.useState<VehiclePart[]>(() => [nuevoRenglon()]);
  const [tiposDePieza, setTiposDePieza] = React.useState<VehiclePartType[]>([]);

  // Se entra acá por dos caminos. Desde Vehículos se viene a cargar una ficha
  // y se vuelve al listado. Desde Órdenes de trabajo se viene a recibir un
  // equipo, y ahí guardar la ficha es la mitad del trámite: falta la orden.
  const [searchParams] = useSearchParams();
  const vieneDeOT = searchParams.get('destino') === 'ot';

  const esPieza = form.kind === 'PIEZA';
  const clienteElegido = customers.find((c) => c.id === form.customerId) ?? null;

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
    fetchVehiclePartTypes().then((d) => !cancelado && setTiposDePieza(d)).catch(() => {});
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

    fetchVehiclePhotos(encontrado.id).then(setFotosGuardadas).catch(() => {});
    // Una ficha ya cargada puede traer sus renglones: se editan, no se pierden.
    if (encontrado.kind === 'PIEZA') {
      fetchVehicleParts(encontrado.id)
        .then((filas) => setPartes(filas.length > 0 ? filas : [nuevoRenglon()]))
        .catch(() => {});
    }
  }

  const modelosDeLaMarca = modelsOfBrand(brands, models, form.brand);
  const clienteDelExistente = existente
    ? customers.find((c) => c.id === existente.customerId)?.name ?? null
    : null;

  if (role !== 'admin') return <Navigate to="/" replace />;

  function patchParte(id: string, cambios: Partial<VehiclePart>) {
    setPartes((actuales) => actuales.map((p) => (p.id === id ? { ...p, ...cambios } : p)));
  }

  function agregarParte() {
    setPartes((actuales) => [...actuales, nuevoRenglon()]);
  }

  /**
   * Nunca se queda sin renglones: una tabla vacía no deja escribir y obliga a
   * buscar el botón de agregar para empezar.
   */
  function quitarParte(id: string) {
    setPartes((actuales) => {
      const quedan = actuales.filter((p) => p.id !== id);
      return quedan.length > 0 ? quedan : [nuevoRenglon()];
    });
  }

  const partesCargadas = partes.filter(renglonCargado);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customerId) {
      setError('Elegí el cliente propietario del vehículo.');
      return;
    }
    if (form.kind === 'PIEZA') {
      if (partesCargadas.length === 0) {
        setError('Cargá al menos una pieza: el tipo es lo que la identifica.');
        return;
      }
    } else {
      if (!form.model.trim()) {
        setError('El modelo es obligatorio.');
        return;
      }
      // El tamaño solo se pide al vehículo: una pieza no ocupa lugar en la playa.
      if (!form.sizeClass) {
        setError('Elegí el tamaño del vehículo: define cuánto lugar ocupa en la playa.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      // Un ingreso de piezas se rotula con su primer renglón: es lo que leen
      // el listado, el selector de la OT y los comprobantes para nombrar el
      // equipo. El detalle completo queda en los renglones.
      const aGuardar = form.kind === 'PIEZA' ? { ...form, ...rotuloDeLaFicha(partes) } : form;

      const guardado = existente
        ? await updateVehicle(existente.id, aGuardar)
        : await createVehicle(aGuardar);

      if (form.kind === 'PIEZA') {
        await saveVehicleParts(guardado.id, partes);
      }

      // Después de guardar, nunca antes: si el alta falla, el catálogo no se
      // ensucia con una marca que en realidad no se usó. Y si esto falla, el
      // vehículo ya quedó guardado igual, así que no se interrumpe por algo
      // que no le importa a quien está cargando.
      registerBrandAndModel(aGuardar.brand, aGuardar.model).catch(() => {});
      if (form.kind === 'PIEZA') registrarTiposDePieza(partes).catch(() => {});

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

      // Se vuelve a la pantalla principal del módulo por donde se entró: quien
      // vino a recibir un equipo para una orden queda en el listado de órdenes.
      navigate(vieneDeOT ? '/ordenes' : '/vehiculos');
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

        {/* ── Cliente ─────────────────────────────────────────────────
            Solo el cliente. Qué entra y cómo se identifica son datos del
            equipo, no del dueño, y mezclarlos hacía leer esta sección dos
            veces para encontrar el nombre. */}
        <Panel className="p-5">
          <SectionHeader title={<><Users size={15} className="mr-1.5 inline-block align-[-2px]" />Cliente</>} />
          <label className={cn(labelClass, 'block sm:max-w-2xl')}>
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

          {/* Los datos del elegido, a la vista y sin poder tocarse: sirven
              para confirmar que es ese cliente y no su homónimo, que es
              cuando el error sale caro. Se corrigen en Clientes. */}
          {clienteElegido && (
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-line pt-4 text-sm sm:grid-cols-3">
              <DatoCliente rotulo="Razón social" valor={clienteElegido.legalName} />
              <DatoCliente
                rotulo="CUIT / CUIL"
                valor={clienteElegido.taxId ? formatCuit(clienteElegido.taxId) : null}
                mono
              />
              <DatoCliente rotulo="Condición IVA" valor={TAX_CONDITION_LABELS[clienteElegido.taxCondition]} />
              <DatoCliente rotulo="Teléfono" valor={clienteElegido.phone} mono />
              <DatoCliente rotulo="Email" valor={clienteElegido.email} />
              <DatoCliente
                rotulo="Domicilio"
                valor={[clienteElegido.addressStreet, clienteElegido.addressCity, clienteElegido.addressState]
                  .filter(Boolean)
                  .join(', ') || null}
              />
            </dl>
          )}
        </Panel>

        {/* ── El equipo ───────────────────────────────────
            Qué entra, y con qué se identifica. La patente vive acá y no con
            el cliente porque identifica al vehículo, no a su dueño: el mismo
            camión puede cambiar de manos. */}
        <Panel className="p-5">
          <SectionHeader
            title={<><Truck size={15} className="mr-1.5 inline-block align-[-2px]" />{esPieza ? 'Piezas' : 'Vehículo'}</>}
          />
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

            {/* La patente identifica al vehículo. Un juego de piezas se
                identifica por el número de referencia de cada renglón. */}
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

            {!esPieza && (
              <>
                <label className={cn(labelClass, 'sm:col-span-2')}>
                  Marca
                  <input
                    value={form.brand}
                    onChange={(e) => patch({ brand: e.target.value })}
                    list="catalogo-marcas"
                    className={inputClass}
                    placeholder="Volvo"
                  />
                </label>
                <label className={cn(labelClass, 'sm:col-span-3')}>
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

          {/* ── Renglón por tipo de pieza ────────────────────────
              Al mostrador no llega "una pieza": llega un juego. Seis
              inyectores y además la bomba, cada uno con su referencia. Por eso
              el tipo va en cada renglón y no arriba: es lo que distingue un
              renglón del otro. */}
          {esPieza && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-[10px] font-bold uppercase tracking-[0.08em] text-text-soft">
                      <th className="pb-2 pr-3 font-bold">Tipo de pieza *</th>
                      <th className="pb-2 pr-3 font-bold">Marca</th>
                      <th className="pb-2 pr-3 font-bold">Modelo</th>
                      <th className="pb-2 pr-3 font-bold">N° de referencia</th>
                      <th className="pb-2 pr-3 text-right font-bold">Cantidad</th>
                      <th className="pb-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {partes.map((parte) => (
                      <tr key={parte.id}>
                        <td className="py-2 pr-3">
                          <input
                            value={parte.partType}
                            onChange={(e) => patchParte(parte.id, { partType: e.target.value })}
                            list="catalogo-tipos-pieza"
                            className={cn(inputClass, 'mt-0')}
                            placeholder="Inyector"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={parte.brand}
                            onChange={(e) => patchParte(parte.id, { brand: e.target.value })}
                            list="catalogo-marcas"
                            className={cn(inputClass, 'mt-0')}
                            placeholder="Bosch"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={parte.model}
                            onChange={(e) => patchParte(parte.id, { model: e.target.value })}
                            className={cn(inputClass, 'mt-0')}
                            placeholder="VP44"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            value={parte.referenceNumber}
                            onChange={(e) => patchParte(parte.id, { referenceNumber: e.target.value })}
                            className={cn(inputClass, 'mt-0 font-mono')}
                            placeholder="0470504217"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="number"
                            min="1"
                            value={parte.quantity}
                            onChange={(e) => patchParte(parte.id, { quantity: e.target.value })}
                            className={cn(inputClass, 'mt-0 w-24 text-right')}
                          />
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => quitarParte(parte.id)}
                            aria-label="Quitar este renglón"
                            className="p-1 text-text-soft transition-colors hover:text-danger"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <datalist id="catalogo-tipos-pieza">
                  {tiposDePieza.map((t) => <option key={t.id} value={t.name} />)}
                </datalist>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={agregarParte}
                  className="inline-flex items-center gap-1.5 border border-line px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt"
                >
                  <Plus size={14} /> Agregar pieza
                </button>
                <span className="text-[11px] text-text-soft">
                  Un tipo que no esté en la lista se escribe igual y queda guardado para la próxima.
                </span>
              </div>
            </div>
          )}

          {/* El catálogo de marcas lo comparten el vehículo y los renglones,
              así que la lista vive fuera de los dos. */}
          <datalist id="catalogo-marcas">
            {brands.map((b) => <option key={b.id} value={b.name} />)}
          </datalist>
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
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate(vieneDeOT ? '/ordenes' : '/vehiculos')}
          >
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            <Save size={16} />{' '}
            {saving
              ? 'Guardando…'
              : existente
                ? 'Guardar cambios'
                : esPieza ? 'Guardar ingreso' : 'Guardar vehículo'}
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
