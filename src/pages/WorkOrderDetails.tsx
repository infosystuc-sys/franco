import React, { useState } from 'react';
import { XCircle, Save, Check, FileText, ArrowRight, History, Receipt, Camera, ImageOff, Trash2, AlertTriangle, Send } from 'lucide-react';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, inputClass, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/customers';
import {
  conElUsuarioIncluido,
  fetchEmpleadoDelUsuario,
  fetchOperarios,
  type Employee,
} from '@/src/lib/employees';
import {
  fetchInvoiceForWorkOrder,
  INVOICE_TYPE_LABELS,
  type WorkOrderInvoiceRef,
} from '@/src/lib/invoices';
import {
  quoteFromWorkOrder,
  defaultValidUntil,
  fetchUnlinkedQuotations,
  linkQuotationToWorkOrder,
  type QuotationListRow,
  describirEnvioCotizacion,
  enviarCotizacionParaAutorizar,
} from '@/src/lib/quotations';
import { VEHICLE_TYPE_LABELS } from '@/src/lib/vehicles';
import {
  addReceivedPart,
  assignEmployee,
  deleteReceivedPart,
  deleteWorkOrderPhoto,
  fetchStatusHistory,
  fetchWorkOrderByNumber,
  fetchWorkOrderStatuses,
  getErrorMessage,
  getWorkOrderPhotoUrl,
  RECEPTION_KIND_LABELS,
  requestPriceAuthorization,
  saveWorkOrderItems,
  setEstimatedDeliveryDate,
  setWorkOrderStatus,
  updateWorkOrderObservations,
  uploadWorkOrderPhoto,
  type StatusChange,
  type WorkOrderDetail,
  type WorkOrderItemInput,
  type WorkOrderPhoto,
  type WorkOrderStatusDef,
} from '@/src/lib/workOrders';

export function WorkOrderDetails() {
  const { role, session } = useAuth();
  const isAdmin = role === 'admin';
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState<WorkOrderDetail | null>(null);
  const [items, setItems] = useState<WorkOrderItemInput[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [history, setHistory] = useState<StatusChange[]>([]);
  const [changingStatus, setChangingStatus] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [assigningEmployee, setAssigningEmployee] = useState(false);
  const [invoice, setInvoice] = useState<WorkOrderInvoiceRef | null>(null);
  const [statuses, setStatuses] = useState<WorkOrderStatusDef[]>([]);
  const [requestingPriceAuth, setRequestingPriceAuth] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [observations, setObservations] = useState('');
  const [partName, setPartName] = useState('');
  const [partSerial, setPartSerial] = useState('');
  const [cotizando, setCotizando] = useState(false);
  const [enviandoCotizacion, setEnviandoCotizacion] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Cotizaciones del cliente de esta OT que todavía no están enganchadas a
  // ninguna orden: el presupuesto hecho por teléfono, antes de que llegara
  // el vehículo. Solo tiene sentido buscarlas mientras la OT no tenga ya
  // una cotización propia.
  const [candidatas, setCandidatas] = useState<QuotationListRow[]>([]);

  // Qué OT ya sincronizó `items` desde la base — no un booleano, porque el
  // mismo componente sigue vivo al navegar de una OT a otra (useParams solo
  // cambia `id`, no remonta).
  const itemsLoadedForRef = React.useRef<string | null>(null);

  function mapItems(data: WorkOrderDetail | null): WorkOrderItemInput[] {
    return (
      data?.items.map((i) => ({
        articleId: i.articleId ?? null,
        code: i.code,
        description: i.description,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })) ?? []
    );
  }

  const loadOrder = React.useCallback(async (): Promise<WorkOrderDetail | null> => {
    if (!id) return null;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkOrderByNumber(id);
      setOrder(data);
      // Los renglones son un borrador local (ver ItemsEditor/handleSave): un
      // refresco disparado por otra acción (cambiar estado, asignar
      // empleado, fecha estimada, fotos...) no debe pisar una edición sin
      // guardar. Solo se sincronizan acá la primera vez que se carga esta
      // OT — después de un guardado exitoso, handleSave los actualiza por
      // su cuenta con la respuesta fresca.
      if (itemsLoadedForRef.current !== id) {
        setItems(mapItems(data));
        itemsLoadedForRef.current = id;
      }
      setHistory(data ? await fetchStatusHistory(data.id) : []);

      // La factura se consulta aparte y sin propagar el error: el operario no
      // tiene permiso de lectura sobre facturas, y si la migracion todavia no
      // se aplico la tabla no existe. En ninguno de los dos casos deberia
      // caerse la pantalla de la orden: simplemente no hay boton.
      setInvoice(data ? await fetchInvoiceForWorkOrder(data.id).catch(() => null) : null);
      return data;
    } catch (err) {
      setError(getErrorMessage(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  // Mientras el usuario está escribiendo, el campo es suyo: cualquier
  // recarga de la orden —agregar una pieza, cambiar el estado, subir una
  // foto, o el propio guardado de observaciones al perder el foco— trae el
  // valor de la base y, si se resincroniza a ciegas, le borra lo que sigue
  // tipeando después de haber vuelto a entrar al campo. Por eso la
  // resincronización se salta mientras el textarea tiene el foco.
  const editandoObservaciones = React.useRef(false);

  // Sobre qué orden se sincronizó el campo por última vez. Cambiar de orden
  // manda siempre, aunque el foco siga puesto: este componente no se remonta
  // al navegar entre órdenes (useParams solo cambia el id — ver el mismo
  // patrón en itemsLoadedForRef), así que sin esto el texto de una OT
  // quedaría mostrado sobre otra, y al salir del campo se guardaría en la
  // equivocada.
  const ordenSincronizada = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    const cambioDeOrden = ordenSincronizada.current !== order?.id;
    if (!cambioDeOrden && editandoObservaciones.current) return;
    ordenSincronizada.current = order?.id;
    editandoObservaciones.current = false;
    setObservations(order?.observations ?? '');
  }, [order?.id, order?.observations]);

  // El avance visual y el desplegable de cambio de estado los ve cualquiera
  // que entra a la ficha, no solo el admin (que además puede cambiarlo).
  React.useEffect(() => {
    let cancelled = false;
    fetchWorkOrderStatuses(true)
      .then((data) => !cancelled && setStatuses(data))
      .catch(() => {/* si falla, el avance queda vacío; el resto de la ficha sigue andando */});
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetchArticles(false)
      .then((data) => !cancelled && setArticles(data))
      .catch(() => {/* el catálogo es opcional: si falla, se puede seguir cargando líneas manuales */});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // Solo el admin asigna: al operario le alcanza con ver el nombre, así que
  // no vale la pena traer la lista de empleados para su sesión. Solo se
  // ofrecen operarios: el dueño o un administrativo no se asignan a una OT.
  React.useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    // El propio usuario entra a la lista aunque su cargo no sea "operario":
    // si tomó la orden desde la recepción, el desplegable tiene que poder
    // mostrarlo. Sin él, el select quedaría con un valor que no existe entre
    // sus opciones y el navegador lo dibuja en blanco.
    Promise.all([fetchOperarios(), fetchEmpleadoDelUsuario(session?.user?.id)])
      .then(([operarios, propio]) => {
        if (!cancelled) setEmployees(conElUsuarioIncluido(operarios, propio));
      })
      .catch(() => {/* si falla, el selector queda vacío y se puede reintentar recargando */});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // Se cargan apenas se conoce el cliente de la orden. Si la OT ya tiene
  // cotización propia no hace falta buscar candidatas: no hay dónde
  // engancharlas.
  React.useEffect(() => {
    if (!order?.customer?.id || order.quotationNumber) { setCandidatas([]); return; }
    fetchUnlinkedQuotations(order.customer.id).then(setCandidatas).catch(() => setCandidatas([]));
  }, [order?.customer?.id, order?.quotationNumber]);

  async function handleStatusChange(statusId: string) {
    if (!order) return;
    setChangingStatus(true);
    setError(null);
    try {
      await setWorkOrderStatus(order.id, statusId);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setChangingStatus(false);
    }
  }

  async function handleAssignEmployee(employeeId: string | null) {
    if (!order) return;
    setAssigningEmployee(true);
    setError(null);
    try {
      await assignEmployee(order.id, employeeId);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAssigningEmployee(false);
    }
  }

  async function handleEstimatedDeliveryChange(date: string) {
    if (!order) return;
    setError(null);
    try {
      await setEstimatedDeliveryDate(order.id, date || null);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleRequestPriceAuth() {
    if (!order) return;
    setRequestingPriceAuth(true);
    setError(null);
    try {
      await requestPriceAuthorization(order.id);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRequestingPriceAuth(false);
    }
  }

  /**
   * Se guarda al salir del campo: es una nota larga, no ameritaba un botón
   * de guardado propio para un único textarea. Si falla, no basta con
   * mostrar el error: hay que devolver el campo al valor que quedó
   * realmente guardado en la base, porque si no el usuario ve su texto en
   * pantalla y cree que se guardó cuando en realidad se perdió.
   */
  async function handleSaveObservations() {
    if (!order || observations === (order.observations ?? '')) return;
    try {
      await updateWorkOrderObservations(order.id, observations);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
      setObservations(order.observations ?? '');
    }
  }

  async function handleAddPart() {
    if (!order) return;
    try {
      await addReceivedPart(order.id, partName, partSerial);
      setPartName('');
      setPartSerial('');
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleDeletePart(id: string, nombre: string) {
    // El número de serie es un dato de trazabilidad, no algo que se
    // reconstruye de memoria si se borra sin querer: mismo resguardo que
    // usa PhotoThumb.handleDelete para las fotos.
    if (!window.confirm(`¿Quitar "${nombre}" de las piezas recibidas?`)) return;
    try {
      await deleteReceivedPart(id);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  /**
   * Arma la cotización de esta OT y la deja enganchada. Se lleva la cabecera
   * —incluidas las observaciones de la recepción, que son el contexto que
   * necesita quien arma el precio— y los renglones que la orden ya tenga
   * cargados. La aceptación y el rechazo siguen viviendo en el módulo de
   * cotizaciones.
   *
   * Los renglones se leen de la base, pero en pantalla son un borrador local
   * (ver handleSave). Sin guardarlo primero, cotizar con una edición sin
   * guardar se llevaría los renglones viejos y perdería lo tipeado sin avisar
   * —que es exactamente el problema que esto vino a arreglar—.
   */
  async function handleCotizar() {
    if (!order || !order.customer) return;
    setCotizando(true);
    setError(null);
    setAviso(null);
    try {
      await saveWorkOrderItems(order.id, items);
      const creada = await quoteFromWorkOrder(order.id, defaultValidUntil());

      // Se pregunta después de crearla, no antes: si el alta falla no hay nada
      // que mandar, y preguntar primero habría hecho decidir sobre algo que
      // todavía no existe.
      const mandar = window.confirm(
        `Se creó el presupuesto ${creada.number}.` +
          '\n\n¿Enviarlo ahora al cliente para que lo autorice?' +
          '\n\nSi no, queda listo y se manda cuando quieras desde acá o desde la cotización.'
      );

      let mensaje = `Se creó el presupuesto ${creada.number}.`;
      if (mandar) {
        const resultado = await enviarCotizacionParaAutorizar(creada.id);
        mensaje = `${creada.number}: ${describirEnvioCotizacion(resultado)}`;
      }

      // Se queda en la orden: cotizar es un paso del trabajo, no el final.
      // Desde acá se sigue cargando renglones o se manda el presupuesto.
      await loadOrder();
      setAviso(mensaje);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCotizando(false);
    }
  }

  /**
   * El presupuesto ya existía y el vehículo recién llega: se asocia en vez de
   * crear uno nuevo. El selector solo aparece si hay candidatas, para no
   * ensuciar el encabezado de las OT que no lo necesitan.
   */
  async function handleEnganchar(quotationId: string) {
    if (!order) return;
    try {
      await linkQuotationToWorkOrder(quotationId, order.id);
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  /**
   * Mandar el presupuesto a autorizar sin salir de la orden.
   *
   * Es el mismo acto que desde la cotización, y desde acá es donde más se
   * necesita: quien recibe el vehículo cotiza y manda en la misma pasada, sin
   * tener que ir a buscar el presupuesto a otra pantalla.
   */
  async function handleEnviarAutorizar() {
    if (!order?.quotationId) return;
    setEnviandoCotizacion(true);
    setError(null);
    setAviso(null);
    try {
      const resultado = await enviarCotizacionParaAutorizar(order.quotationId);
      setAviso(describirEnvioCotizacion(resultado));
      await loadOrder();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setEnviandoCotizacion(false);
    }
  }

  async function handleSave() {
    if (!order) return;
    setSaving(true);
    setError(null);
    try {
      await saveWorkOrderItems(order.id, items);
      // Guardar cierra la edición y vuelve al listado, como el resto de los
      // módulos. Ya no se recarga la orden ni el catálogo: esta pantalla se
      // va, y el listado trae sus propios datos frescos.
      //
      // setSaving(false) queda solo en el catch a propósito: mientras navega,
      // el botón sigue diciendo "Guardando…" y no admite un segundo clic que
      // volvería a descontar stock.
      navigate('/ordenes');
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="max-w-[1600px] mx-auto p-8 text-center text-text-soft">Cargando orden...</div>;
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-[1600px] p-8 text-center text-text-soft">
        No se encontró la orden {id}.{' '}
        <Link to="/" className="text-accent-deep underline">Volver al panel</Link>
      </div>
    );
  }

  // Con factura emitida la OT queda congelada: lo único que la desbloquea es
  // anular esa factura (fuera de esta pantalla, desde Facturación).
  const locked = !!invoice;

  /**
   * La línea de tiempo de ESTA orden: los estados por los que pasó, en el
   * orden en que se los fue eligiendo.
   *
   * No hay un circuito único para todas las órdenes. Un inyector que se manda
   * a laboratorio y vuelve no recorre lo mismo que una bomba que se repara en
   * el taller, y forzar a las dos por una secuencia fija obligaba a inventar
   * un orden global que después no describía a ninguna. Cada orden arma el
   * suyo: el historial ES la línea de tiempo.
   *
   * Si una orden vuelve sobre un estado —de Cotizado a Ingresado y otra vez a
   * Cotizado— aparece las dos veces, porque eso fue lo que pasó. Esconder la
   * repetición sería dibujar un recorrido que la orden no hizo.
   */
  /**
   * Quién está mirando la orden, si es empleado.
   *
   * Acá NO se preselecciona: este desplegable guarda al instante, así que
   * sugerir por defecto reasignaría la orden con solo abrirla —y el RLS filtra
   * por empleado, o sea que cambiaría quién la ve—. Se marca la opción propia
   * para que tomarla sea un clic, y la sugerencia automática vive donde la
   * orden se está creando: la recepción y el alta.
   */
  const propioId = employees.find((e) => e.profileId === session?.user?.id)?.id ?? null;

  const recorrido = (() => {
    // Sin useMemo a propósito: esto se calcula después de los returns tempranos
    // de "cargando" y "no existe", y un hook ahí adentro corre en unos renders
    // y en otros no. Recorrer unos pocos cambios no necesita memoria.
    const pasos = [...history]
      .sort((a, b) => a.changedAt.localeCompare(b.changedAt))
      .map((cambio) => cambio.toStatus);

    // Las órdenes anteriores al registro de historial no tienen pasos: al menos
    // se muestra dónde están paradas hoy.
    if (pasos.length === 0) return order.status ? [order.status] : [];

    // El estado actual cierra la línea aunque el cambio no haya quedado
    // registrado, para que la punta coincida siempre con lo que dice arriba.
    if (order.status && pasos[pasos.length - 1].id !== order.status.id) {
      pasos.push(order.status);
    }
    return pasos;
  })();
  const currentTotal = order.items.reduce((sum, i) => sum + i.subtotal, 0);
  // Una orden sin renglones y con presupuesto es una que todavía espera la
  // respuesta del cliente: los renglones se copian recién al aceptar. Sin esta
  // condición, toda orden recién cotizada avisaría que su monto ($0) difiere
  // del presupuesto, y ofrecería pedirle al cliente que autorice cero pesos.
  const esperandoRespuesta = order.items.length === 0;
  const priceDiffers =
    !esperandoRespuesta &&
    order.quotedTotal !== null && Math.abs(currentTotal - order.quotedTotal) > 0.005;
  const priceAuthCoversCurrent =
    order.priceAuth.status === 'AUTORIZADO' &&
    order.priceAuth.requestedTotal !== null &&
    Math.abs(order.priceAuth.requestedTotal - currentTotal) < 0.005;

  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader
        title={<span className="font-mono text-3xl font-medium tracking-normal text-text">{order.number}</span>}
        meta={
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-soft">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5"
              style={{ backgroundColor: order.status.color }}
            />
            {order.status.label}
          </span>
        }
        subtitle={
          order.quotationNumber ? (
            <Link
              to={`/cotizacion/${order.quotationNumber}`}
              className="inline-flex items-center gap-1.5 text-accent-deep hover:underline"
            >
              <FileText size={14} /> Presupuestada en {order.quotationNumber}
            </Link>
          ) : (
            'Orden cargada directamente, sin cotización previa.'
          )
        }
        actions={
          <>
            <Link to="/ordenes">
              <Button variant="ghost" type="button">
                <XCircle size={16} /> Volver
              </Button>
            </Link>
            {isAdmin && !order.quotationNumber && candidatas.length > 0 && (
              <select
                value=""
                onChange={(e) => e.target.value && handleEnganchar(e.target.value)}
                className={cn(inputClass, 'mt-0 w-56 bg-panel')}
              >
                <option value="">Enganchar una cotización ya hecha…</option>
                {candidatas.map((c) => (
                  <option key={c.id} value={c.id}>{c.number} — $ {formatMoney(c.total)}</option>
                ))}
              </select>
            )}
            {isAdmin && !order.quotationNumber && (
              <Button
                type="button"
                variant="secondary"
                disabled={cotizando}
                onClick={handleCotizar}
              >
                <Receipt size={16} /> {cotizando ? 'Creando…' : 'Cotizar'}
              </Button>
            )}
            {isAdmin && order.quotationId &&
              (order.quotationStatus === 'EMITIDA' || order.quotationStatus === 'ENVIADA') && (
              <Button
                type="button"
                variant="secondary"
                disabled={enviandoCotizacion}
                onClick={handleEnviarAutorizar}
              >
                <Send size={16} />{' '}
                {enviandoCotizacion
                  ? 'Enviando…'
                  : order.quotationStatus === 'ENVIADA'
                    ? 'Reenviar a autorizar'
                    : 'Enviar a autorizar'}
              </Button>
            )}
            {isAdmin && <InvoiceAction order={order} invoice={invoice} />}
            {isAdmin && !locked && (
              <Button onClick={handleSave} disabled={saving}>
                <Save size={16} /> {saving ? 'Guardando…' : 'Guardar'}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {aviso && !error && (
        <div className="mb-6 rounded-md border border-line-strong bg-panel-alt px-4 py-3 text-sm text-text">{aviso}</div>
      )}

      {order.quotedTotal !== null && priceDiffers && !priceAuthCoversCurrent && (
        <div className="mb-6 flex flex-col gap-2 rounded-md border border-state-wait/40 bg-state-wait/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2 text-text">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-state-wait" />
            <span>
              El monto de la OT ({formatMoney(currentTotal)}) difiere del presupuesto original
              ({formatMoney(order.quotedTotal)}).
              {order.priceAuth.status === 'PENDIENTE' && (
                <>
                  {' '}Esperando la respuesta del cliente
                  {order.priceAuth.requestedAt ? ` (pedida el ${new Date(order.priceAuth.requestedAt).toLocaleDateString('es-AR')})` : ''}.
                  No se puede cerrar la OT hasta que autorice.
                </>
              )}
              {order.priceAuth.status === 'RECHAZADO' && (
                <>
                  {' '}El cliente no autorizó el cambio
                  {order.priceAuth.reason ? `: "${order.priceAuth.reason}"` : '.'} No se puede cerrar la OT así.
                </>
              )}
            </span>
          </span>
          {isAdmin && order.priceAuth.status !== 'PENDIENTE' && (
            <Button variant="ghost" onClick={handleRequestPriceAuth} disabled={requestingPriceAuth}>
              <Send size={15} /> {requestingPriceAuth ? 'Enviando…' : 'Solicitar autorización'}
            </Button>
          )}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-5">
        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Cliente
          </span>
          <span className="block text-sm font-semibold text-text">{order.customer?.name ?? '—'}</span>
          {order.customer?.legal_name && order.customer.legal_name !== order.customer.name && (
            <span className="block text-xs text-text-soft">{order.customer.legal_name}</span>
          )}
          {order.customer && (
            <span className="mt-1.5 block text-xs text-text-soft">
              {order.customer.tax_id && (
                <span className="font-mono">{formatCuit(order.customer.tax_id)} · </span>
              )}
              {TAX_CONDITION_LABELS[order.customer.tax_condition]}
            </span>
          )}
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Vehículo / Equipo
          </span>
          <span className="block text-sm font-semibold text-text">
            {[order.vehicle?.brand, order.vehicle?.model].filter(Boolean).join(' ') || '—'}
          </span>
          {order.vehicle?.license_plate && (
            <span className="mt-1 inline-block border border-line bg-panel-alt px-2 py-0.5 font-mono text-xs font-semibold">
              {order.vehicle.license_plate}
            </span>
          )}
          {order.vehicle && (
            <span className="mt-1.5 block text-xs text-text-soft">
              {[
                VEHICLE_TYPE_LABELS[order.vehicle.vehicle_type],
                order.vehicle.year ? String(order.vehicle.year) : null,
                [order.vehicle.engine_brand, order.vehicle.engine_model].filter(Boolean).join(' ') || null,
                order.vehicle.injection_system,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Componente
          </span>
          <span className="text-sm font-semibold text-text">{order.component ?? '—'}</span>
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Empleado
          </span>
          {isAdmin && !locked ? (
            <select
              value={order.employee?.id ?? ''}
              onChange={(e) => handleAssignEmployee(e.target.value || null)}
              disabled={assigningEmployee}
              className="w-full rounded border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
            >
              <option value="">Sin asignar</option>
              {/* Quien ya tiene la orden aparece siempre, aunque no esté en la
                  lista de asignables: puede ser un dueño que la tomó, o un
                  operario dado de baja después. Si no figurara, el select
                  mostraría un valor inexistente —en blanco— y el primer
                  cambio le borraría la asignación sin que nadie lo pida. */}
              {order.employee && !employees.some((e) => e.id === order.employee?.id) && (
                <option value={order.employee.id}>{order.employee.name}</option>
              )}
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                  {employee.id === propioId ? ' (vos)' : ''}
                  {employee.workplace ? ` — ${employee.workplace}` : ''}
                </option>
              ))}
            </select>
          ) : (
            // El operario solo consulta quién quedó a cargo: la asignación es tarea del admin.
            <span className="block text-sm font-semibold text-text">{order.employee?.name ?? 'Sin asignar'}</span>
          )}
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Entrega estimada
          </span>
          {isAdmin && !locked ? (
            <input
              type="date"
              value={order.estimatedDeliveryDate ?? ''}
              onChange={(e) => handleEstimatedDeliveryChange(e.target.value)}
              className="w-full rounded border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
            />
          ) : (
            <span className="block text-sm font-semibold text-text">
              {order.estimatedDeliveryDate ? formatDate(order.estimatedDeliveryDate) : 'Sin definir'}
            </span>
          )}
        </Panel>
      </div>

      {/* Avance del trabajo */}
      {recorrido.length > 0 && (
        <Panel className="mb-6 px-5 py-6">
          {/* La línea se dibuja con las etapas por las que la orden PASÓ, no
              con el circuito completo. Mostrar en gris las que faltan promete
              pasos que quizás nunca ocurran —una orden rechazada no llega a
              terminada— y con estados que el taller agrega y saca, la fila se
              llenaba de casilleros que esa orden nunca iba a tocar. */}
          {/* Los casilleros se llenan de izquierda a derecha, uno al lado del
              otro. Estirados a todo el ancho, una orden con dos estados los
              mostraba en los extremos con un metro de línea en el medio, como
              si faltaran pasos que en realidad no existen. */}
          <div className="relative flex items-start justify-start overflow-x-auto pb-1">
            {recorrido.map((status, idx) => {
              const esActual = idx === recorrido.length - 1;
              const esUltimo = idx === recorrido.length - 1;
              return (
                // La clave lleva la posición además del id: un estado puede
                // repetirse en el recorrido, y con solo el id React vería dos
                // nodos iguales.
                <div key={`${status.id}-${idx}`} className="relative z-10 flex w-24 shrink-0 flex-col items-center gap-2">
                  {/* El tramo de línea va de este casillero al siguiente, en
                      vez de una línea única de punta a punta: así termina
                      donde termina el recorrido. */}
                  {!esUltimo && (
                    <div className="absolute left-1/2 top-3 -z-10 h-[3px] w-full bg-accent" />
                  )}
                  {esActual ? (
                    <span className="flex h-[26px] w-[26px] -mt-[6px] items-center justify-center border-[3px] border-accent bg-panel">
                      <span className="h-2 w-2 bg-accent" />
                    </span>
                  ) : (
                    <span className="flex h-[26px] w-[26px] -mt-[6px] items-center justify-center bg-accent text-accent-ink">
                      <Check size={14} strokeWidth={3} />
                    </span>
                  )}
                  <span
                    className={cn(
                      'text-center text-[11px] font-semibold uppercase leading-tight tracking-[0.05em]',
                      esActual ? 'text-text' : 'text-text-faint'
                    )}
                  >
                    {status.label}
                  </span>
                </div>
              );
            })}
          </div>

          {isAdmin && (
            <StatusControls
              order={order}
              statuses={statuses}
              invoice={invoice}
              busy={changingStatus}
              onChange={handleStatusChange}
            />
          )}
        </Panel>
      )}

      {history.length > 1 && (
        <div className="mb-6">
          {showHistory ? (
            <>
              <StatusHistory history={history} />
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="mt-2 text-xs font-semibold text-text-soft hover:text-text"
              >
                Ocultar historial
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowHistory(true)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-text-soft hover:text-text"
            >
              <History size={14} /> Ver historial de estados ({history.length})
            </button>
          )}
        </div>
      )}

      {/* Mismo editor de renglones que usan las cotizaciones */}
      <Panel className="p-5">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable={isAdmin && !locked}
        />
      </Panel>

      {/* Lo que se dejó asentado al recibir: piezas sueltas y cualquier
          observación del cliente o de quien recibió. */}
      <div className="mt-6">
        <Panel className="space-y-4 p-5">
          <SectionHeader title={`Recepción · ${RECEPTION_KIND_LABELS[order.receptionKind]}`} />

          <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
            Observaciones
            <textarea
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              onFocus={() => { editandoObservaciones.current = true; }}
              onBlur={() => {
                // Soltar la marca antes de guardar: así, si el guardado
                // dispara loadOrder(), la resincronización sí corre después
                // y el campo termina mostrando lo que quedó en la base.
                editandoObservaciones.current = false;
                handleSaveObservations();
              }}
              disabled={!isAdmin || locked}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none disabled:bg-panel-alt"
            />
          </label>

          <div className="space-y-2">
            <span className="text-xs font-bold uppercase tracking-wider text-text-soft">
              Piezas recibidas{order.receivedParts.length > 0 && ` (${order.receivedParts.length})`}
            </span>
            {order.receivedParts.length === 0 ? (
              <p className="text-sm text-text-soft">No se registraron piezas al recibir.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {order.receivedParts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span>{p.name} — <span className="font-mono text-xs">{p.serialNumber}</span></span>
                    {isAdmin && !locked && (
                      <button
                        type="button"
                        onClick={() => handleDeletePart(p.id, p.name)}
                        aria-label={`Quitar ${p.name}`}
                        className="text-text-soft transition-colors hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {isAdmin && !locked && (
              <div className="flex gap-2">
                <input
                  value={partName}
                  onChange={(e) => setPartName(e.target.value)}
                  placeholder="Bomba inyectora"
                  className="mt-0 flex-1 rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
                />
                <input
                  value={partSerial}
                  onChange={(e) => setPartSerial(e.target.value)}
                  placeholder="N° de serie"
                  className="mt-0 w-40 rounded-md border border-line bg-panel px-3 py-2 font-mono text-sm focus:border-accent-deep focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!partName.trim() || !partSerial.trim()}
                  onClick={handleAddPart}
                  className="border border-line px-3 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt disabled:opacity-50"
                >
                  Agregar
                </button>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {order && (
        <div className="mt-6">
          {/* Facturada, las fotos también quedan congeladas: la orden es el
              respaldo de un comprobante emitido. */}
          <PhotosSection order={order} isAdmin={isAdmin && !locked} onChanged={loadOrder} onError={setError} />
        </div>
      )}
    </div>
  );
}

/**
 * Fotos del estado de las piezas durante la reparación. Mismo patrón que
 * las fotos de Ingreso de vehículos: se pueden agregar en cualquier
 * momento, no solo al terminar, y se sacan directo con la cámara del
 * celular o tablet.
 */
function PhotosSection({
  order,
  isAdmin,
  onChanged,
  onError,
}: {
  order: WorkOrderDetail;
  isAdmin: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    onError('');
    try {
      for (const file of Array.from(files)) {
        await uploadWorkOrderPhoto(order.id, file);
      }
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <Panel className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeader title={`Fotos${order.photos.length > 0 ? ` (${order.photos.length})` : ''}`} />
        {isAdmin && (
          <label className="cursor-pointer">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(e) => handleFiles(e.target.files)}
              disabled={uploading}
              className="hidden"
            />
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-accent-ink hover:bg-accent-deep hover:text-white transition-colors">
              <Camera size={15} /> {uploading ? 'Subiendo...' : 'Agregar foto'}
            </span>
          </label>
        )}
      </div>

      {order.photos.length === 0 ? (
        <p className="flex flex-col items-center gap-2 py-8 text-sm text-text-soft">
          <ImageOff size={22} className="text-text-faint" />
          Todavía no hay fotos cargadas.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {order.photos.map((photo) => (
            <PhotoThumb key={photo.id} photo={photo} isAdmin={isAdmin} onChanged={onChanged} onError={onError} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function PhotoThumb({
  photo,
  isAdmin,
  onChanged,
  onError,
}: {
  photo: WorkOrderPhoto;
  isAdmin: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    getWorkOrderPhotoUrl(photo.storagePath)
      .then((signed) => !cancelled && setUrl(signed))
      .catch(() => {/* la miniatura queda vacía; no vale la pena cortar el resto de la pantalla */});
    return () => { cancelled = true; };
  }, [photo.storagePath]);

  async function handleDelete() {
    if (!window.confirm('¿Eliminar esta foto?')) return;
    setDeleting(true);
    try {
      await deleteWorkOrderPhoto(photo);
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <div className="group relative aspect-square overflow-hidden rounded-md border border-line bg-panel-alt">
      {url ? (
        <img src={url} alt="Foto de la orden" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-text-faint">
          <Camera size={20} />
        </div>
      )}
      {isAdmin && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          title="Eliminar foto"
          className="absolute right-1 top-1 bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-danger group-hover:opacity-100 disabled:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * El acceso a la facturación desde la orden.
 *
 * Ya facturada deja de ser un botón y pasa a ser un link al comprobante:
 * ofrecer "Facturar" sobre una orden que ya tiene factura sería prometer algo
 * que la base va a rechazar. Sin terminar queda deshabilitado explicando por
 * qué, que es más útil que esconderlo.
 */
function InvoiceAction({
  order,
  invoice,
}: {
  order: WorkOrderDetail;
  invoice: WorkOrderInvoiceRef | null;
}) {
  if (invoice) {
    return (
      <Link to={`/factura/${invoice.id}`}>
        <Button variant="secondary" type="button">
          <Receipt size={16} /> {INVOICE_TYPE_LABELS[invoice.invoiceType]} {invoice.fullNumber}
        </Button>
      </Link>
    );
  }

  if (!order.status.isTerminal) {
    return (
      <Button
        type="button"
        variant="ghost"
        disabled
        title={`Se factura cuando la orden está terminada. Ahora está en ${order.status.label}.`}
      >
        <Receipt size={16} /> Facturar
      </Button>
    );
  }

  return (
    <Link to={`/facturar/${order.number}`}>
      <Button variant="secondary" type="button">
        <Receipt size={16} /> Facturar
      </Button>
    </Link>
  );
}

/**
 * Cambio de estado de la OT: un desplegable único con todos los estados,
 * aplica apenas se elige uno distinto. Reemplaza al viejo botón de "avanzar
 * al siguiente paso" — cualquier salto, adelante o atrás, es la misma
 * acción. Si la orden ya está terminada y facturada, avisa que cambiar el
 * estado no anula ni actualiza esa factura, pero no lo bloquea.
 */
function StatusControls({
  order,
  statuses,
  invoice,
  busy,
  onChange,
}: {
  order: WorkOrderDetail;
  statuses: WorkOrderStatusDef[];
  invoice: WorkOrderInvoiceRef | null;
  busy: boolean;
  onChange: (statusId: string) => void;
}) {
  const isDone = order.status.isTerminal;
  // Si el estado actual de la OT se desactivó desde el ABM después de
  // asignarse, igual tiene que aparecer en la lista — si no, el
  // desplegable arranca mostrando otra cosa distinta de lo que la OT
  // realmente tiene.
  const todos = statuses.some((s) => s.id === order.status.id)
    ? statuses
    : [order.status, ...statuses];

  // Una OT facturada queda bloqueada, pero con una única salida: Retirado. El
  // vehículo se entrega DESPUÉS de facturar, y sin ese paso la orden seguiría
  // ocupando lugar en la playa para siempre.
  //
  // Se reconoce por clave y no por su nombre: el ABM deja renombrar los
  // estados, y comparar contra el texto dejaría a la orden facturada sin
  // salida en cuanto alguien lo tocara, sin que nada avise.
  const retirado = statuses.find((s) => s.systemKey === 'RETIRADO') ?? null;
  const options = invoice
    ? todos.filter((s) => s.id === order.status.id || s.id === retirado?.id)
    : todos;

  // Con factura, el desplegable sirve solo si hay algún destino además del
  // estado actual: ya retirada —o sin ese estado en el ABM— no hay nada que
  // ofrecer y vuelve a quedar bloqueado como antes.
  const puedeRetirar = !!invoice && options.length > 1;

  return (
    <div className="mt-7 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
          Estado
        </span>
        <select
          value={order.status.id}
          onChange={(e) => onChange(e.target.value)}
          disabled={busy || (!!invoice && !puedeRetirar)}
          className="rounded border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none disabled:opacity-60"
        >
          {options.map((status) => (
            <option key={status.id} value={status.id}>{status.label}</option>
          ))}
        </select>
        {busy && (
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            Actualizando…
          </span>
        )}
      </div>

      {invoice && (
        <p className="mt-3 rounded-md border border-state-wait/40 bg-state-wait/10 px-3 py-2 text-xs text-state-wait">
          Esta orden ya tiene la {INVOICE_TYPE_LABELS[invoice.invoiceType]} {invoice.fullNumber} emitida
          {puedeRetirar && retirado ? (
            <>
              : lo único que admite es pasarla a {retirado.label}, cuando el cliente
              se lleve el vehículo. Para cualquier otra corrección, anulá esa factura primero.
            </>
          ) : (
            <>: queda bloqueada, no se puede modificar. Para corregir algo, anulá esa factura primero.</>
          )}
        </p>
      )}
    </div>
  );
}

function StatusHistory({ history }: { history: StatusChange[] }) {
  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line bg-panel-head px-5 py-2.5">
        <h2 className="flex items-center gap-1.5 font-display text-base uppercase tracking-[0.08em] text-text-faint">
          <History size={15} /> Historial de estados
        </h2>
      </div>
      <ul className="divide-y divide-line">
        {[...history].reverse().map((change) => (
          <li
            key={change.id}
            className="relative flex flex-wrap items-center justify-between gap-3 py-2.5 pl-5 pr-5 text-[13px]"
          >
            <StateStrip color={change.toStatus.color} />
            <span className="flex items-center gap-2">
              {change.fromStatus && (
                <>
                  <span className="text-text-soft">{change.fromStatus.label}</span>
                  <ArrowRight size={13} className="text-text-faint" />
                </>
              )}
              <span className="font-semibold text-text">{change.toStatus.label}</span>
              {!change.fromStatus && (
                <span className="text-[10px] uppercase tracking-[0.08em] text-text-faint">apertura</span>
              )}
            </span>
            <span className="font-mono text-[11px] text-text-soft">
              {new Date(change.changedAt).toLocaleString('es-AR')}
              {change.changedByEmail && ` · ${change.changedByEmail}`}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
