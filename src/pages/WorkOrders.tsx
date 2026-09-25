import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { NewWorkOrderModal } from '@/src/components/NewWorkOrderModal';
import { DeleteWorkOrdersModal } from '@/src/components/DeleteWorkOrdersModal';
import {
  describirReenvioLink,
  fetchAllWorkOrders,
  fetchWorkOrderStatuses,
  getErrorMessage,
  reenviarLinkSeguimiento,
  type WorkOrderDeletionResult,
  type WorkOrderRow,
  type WorkOrderStatusDef,
} from '@/src/lib/workOrders';
import {
  ComprobantesListado,
  ETIQUETAR,
  type AccionListado,
  type ColumnaListado,
} from '@/src/components/ComprobantesListado';

const COLUMNAS: ColumnaListado<WorkOrderRow>[] = [
  {
    label: 'Comprobante',
    valor: (f) => (
      <span className="inline-flex items-center gap-1.5">
        {f.number}
        {f.priceDiffers && (
          <span title="El monto de la OT difiere de la cotización original">
            <AlertTriangle size={14} className="text-state-wait" />
          </span>
        )}
      </span>
    ),
  },
  { label: 'Cliente', valor: (f) => f.customerName, ancho: 'w-full' },
  {
    label: 'Vehículo / Equipo',
    valor: (f) => (f.component ? `${f.vehicleLabel} · ${f.component}` : f.vehicleLabel),
  },
  {
    label: 'Estado',
    valor: (f) => (
      <span className="inline-flex items-center gap-2">
        <span aria-hidden className="inline-block h-2.5 w-2.5" style={{ backgroundColor: f.status.color }} />
        {f.status.label}
      </span>
    ),
  },
  { label: 'Factura', valor: (f) => f.invoiceNumber ?? '—' },
  { label: 'Empleado', valor: (f) => f.employeeName ?? '—' },
  { label: 'Fecha', valor: (f) => formatDate(f.createdAt.slice(0, 10)) },
];

/**
 * Órdenes de trabajo, con el listado y las acciones del de Tango.
 *
 * El Panel es una cola de trabajo y solo muestra lo pendiente; acá está todo,
 * para poder encontrar una orden terminada hace tres semanas. Un operario ve
 * únicamente sus propias órdenes: lo decide el RLS de work_orders.
 */
export function WorkOrders() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const navigate = useNavigate();

  const [orders, setOrders] = React.useState<WorkOrderRow[]>([]);
  const [statuses, setStatuses] = React.useState<WorkOrderStatusDef[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);
  const [showNewOrder, setShowNewOrder] = React.useState(false);
  const [borrando, setBorrando] = React.useState<WorkOrderRow | null>(null);
  /**
   * Las retiradas se esconden por defecto: con el tiempo son la mayoría —toda
   * orden termina retirada— y son justamente las que ya no piden nada.
   */
  const [verRetirados, setVerRetirados] = React.useState(false);

  // Una orden arranca por el vehículo: el ingreso manda de vuelta acá con
  // ?nuevo=1 y el vehículo ya recibido, y recién ahí se abre el alta con ese
  // vehículo puesto. Se limpian los parámetros para que recargar no vuelva a
  // abrirla, y solo se atiende si es admin: el alta es suya.
  const [searchParams, setSearchParams] = useSearchParams();
  const [vehiculoRecibido, setVehiculoRecibido] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (searchParams.get('nuevo') !== '1') return;
    if (isAdmin) {
      setVehiculoRecibido(searchParams.get('vehiculo'));
      setShowNewOrder(true);
    }
    setSearchParams((actuales) => {
      const proximos = new URLSearchParams(actuales);
      proximos.delete('nuevo');
      proximos.delete('vehiculo');
      return proximos;
    }, { replace: true });
  }, [searchParams, setSearchParams, isAdmin]);

  const cargar = React.useCallback(async () => {
    try {
      const [orderRows, statusDefs] = await Promise.all([fetchAllWorkOrders(), fetchWorkOrderStatuses(true)]);
      setOrders(orderRows);
      setStatuses(statusDefs);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  const getId = React.useCallback((f: WorkOrderRow) => f.id, []);

  // El estado se busca por system_key: la etiqueta la renombra el taller.
  const retiradoId = statuses.find((s) => s.systemKey === 'RETIRADO')?.id ?? null;
  const visibles = verRetirados || !retiradoId ? orders : orders.filter((o) => o.status.id !== retiradoId);

  const ficha = (f: WorkOrderRow) => `/orden/${f.number}`;
  const soloAdmin = () => (isAdmin ? null : 'Solo un administrador puede hacerlo.');

  async function reenviarSeguimiento(f: WorkOrderRow) {
    setError(null);
    setAviso(null);
    try {
      setAviso(`${f.number}: ${describirReenvioLink(await reenviarLinkSeguimiento(f.id))}`);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  function handleDeleted(results: WorkOrderDeletionResult[]) {
    // La base revalida: entre que se armó la confirmación y se aceptó, alguien
    // pudo haber facturado la orden. Eso hay que decirlo.
    setAviso(
      results
        .map((r) => (r.deleted ? `Se eliminó la orden ${r.orderNumber}.` : `No se pudo eliminar ${r.orderNumber}: ${r.reason}.`))
        .join(' ') || null
    );
    setBorrando(null);
    cargar();
  }

  const botones: AccionListado<WorkOrderRow>[] = [
    { label: 'Ver', onClick: (f) => f && navigate(ficha(f)) },
    {
      label: 'Imprimir',
      onClick: (f) => f && navigate(`/orden/${f.number}/imprimir-blanco?imprimir=1&desde=listado`),
    },
  ];

  const masAcciones = [
    {
      label: 'Imprimir presupuesto',
      bloqueo: (f: WorkOrderRow) =>
        soloAdmin() ?? (f.quotationNumber ? null : 'Esta orden no tiene presupuesto.'),
      onClick: (f: WorkOrderRow | null) =>
        f?.quotationNumber && navigate(`/cotizacion/${f.quotationNumber}?imprimir=1&volver=${f.number}`),
    },
    ...(isAdmin ? [ETIQUETAR] : []),
    {
      label: 'Facturar',
      bloqueo: (f: WorkOrderRow) =>
        soloAdmin() ?? (f.invoiceNumber ? `Ya está facturada en la ${f.invoiceNumber}.` : null),
      onClick: (f: WorkOrderRow | null) => f && navigate(`/facturar/${f.number}`),
    },
    {
      label: 'Ver factura',
      bloqueo: (f: WorkOrderRow) =>
        soloAdmin() ?? (f.invoiceId ? null : 'Esta orden no tiene factura emitida.'),
      onClick: (f: WorkOrderRow | null) => f?.invoiceId && navigate(`/factura/${f.invoiceId}`),
    },
    {
      label: 'Ver como lo ve el cliente',
      onClick: (f: WorkOrderRow | null) => f && navigate(`/seguimiento/${f.publicToken}`),
    },
    {
      label: 'Reenviar seguimiento por WhatsApp',
      bloqueo: soloAdmin,
      onClick: (f: WorkOrderRow | null) => f && reenviarSeguimiento(f),
    },
    {
      label: 'Eliminar orden',
      bloqueo: (f: WorkOrderRow) =>
        soloAdmin() ?? (f.invoiceNumber ? 'Una orden facturada no se puede eliminar.' : null),
      onClick: (f: WorkOrderRow | null) => f && setBorrando(f),
    },
    {
      label: verRetirados ? 'Ocultar retirados' : 'Mostrar retirados',
      sinSeleccion: true,
      onClick: () => setVerRetirados((v) => !v),
    },
    {
      label: 'Órdenes para facturar',
      sinSeleccion: true,
      bloqueo: soloAdmin,
      onClick: () => navigate('/facturas/pendientes'),
    },
    {
      label: 'Nuevo cliente',
      sinSeleccion: true,
      bloqueo: soloAdmin,
      onClick: () => navigate('/clientes?nuevo=1'),
    },
  ];

  return (
    <>
      <ComprobantesListado
        titulo="Órdenes de trabajo"
        tipo="orden_trabajo"
        filas={visibles}
        loading={loading}
        error={error}
        getId={getId}
        columnas={COLUMNAS}
        // Igual que el "+" de la tarjeta del menú: una orden empieza
        // recibiendo el vehículo, no en la ventana de alta.
        nuevo={isAdmin ? { to: '/vehiculos/nuevo?destino=ot' } : undefined}
        onAbrir={(f) => navigate(ficha(f))}
        botones={botones}
        masAcciones={masAcciones}
        etiquetasDe={(f) => f.etiquetas}
        onEtiquetasGuardadas={(id, etiquetas) =>
          setOrders((rows) => rows.map((r) => (r.id === id ? { ...r, etiquetas } : r)))
        }
        vacio={orders.length === 0 ? 'No hay órdenes cargadas todavía.' : 'No hay órdenes sin retirar.'}
        aviso={aviso}
        onCerrarAviso={() => setAviso(null)}
      />

      {showNewOrder && (
        <NewWorkOrderModal
          initialVehicleId={vehiculoRecibido}
          onClose={() => {
            setShowNewOrder(false);
            setVehiculoRecibido(null);
          }}
          onCreated={() => {
            setShowNewOrder(false);
            setVehiculoRecibido(null);
            cargar();
          }}
        />
      )}

      {borrando && (
        <DeleteWorkOrdersModal
          orders={[{ id: borrando.id, number: borrando.number, customerName: borrando.customerName }]}
          onClose={() => setBorrando(null)}
          onDeleted={handleDeleted}
        />
      )}
    </>
  );
}
