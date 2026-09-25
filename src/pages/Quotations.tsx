import React from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { VAT_RATE } from '@/src/lib/invoices';
import {
  deleteQuotation,
  describeQuotationError,
  duplicateQuotation,
  fetchQuotations,
  isExpired,
  QUOTATION_STATUS_LABELS,
  type QuotationListRow,
} from '@/src/lib/quotations';
import { siNo } from '@/src/lib/comprobantes';
import { urlDeAccion } from '@/src/lib/accionDesdeListado';
import {
  ComprobantesListado,
  ETIQUETAR,
  type AccionListado,
  type ColumnaListado,
} from '@/src/components/ComprobantesListado';

const COLUMNAS: ColumnaListado<QuotationListRow>[] = [
  { label: 'Comprobante', valor: (f) => f.number },
  { label: 'Cliente', valor: (f) => f.customerName, ancho: 'w-full' },
  { label: 'Vehículo', valor: (f) => f.vehicleLabel },
  { label: 'Emisión', valor: (f) => formatDate(f.createdAt.slice(0, 10)) },
  { label: 'Válido hasta', valor: (f) => (f.validUntil ? formatDate(f.validUntil) : '—') },
  // Mandarlo a autorizar también es mandarlo, aunque no pase por el modal.
  { label: 'Enviado', valor: (f) => siNo(!!f.enviadoAt || f.status !== 'EMITIDA') },
  // Con IVA, como el total del presupuesto que recibe el cliente.
  { label: 'Total', valor: (f) => `$ ${formatMoney(f.total * (1 + VAT_RATE))}`, derecha: true },
  {
    label: 'Estado',
    valor: (f) =>
      isExpired(f.validUntil, f.status) ? 'Vencido' : QUOTATION_STATUS_LABELS[f.status],
  },
  { label: 'Orden', valor: (f) => f.workOrderNumber ?? '—' },
];

/**
 * Cotizaciones (presupuestos), con el listado y las acciones del de Tango. Nacen en la orden
 * de trabajo (Cotizar): por eso Nuevo lleva a las órdenes.
 */
export function Quotations() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [quotations, setQuotations] = React.useState<QuotationListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      setQuotations(await fetchQuotations());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  const getId = React.useCallback((f: QuotationListRow) => f.id, []);

  const isAdmin = role === 'admin';
  const soloAdmin = () => (isAdmin ? null : 'Solo un administrador puede hacerlo.');

  const ficha = (f: QuotationListRow) => `/cotizacion/${f.number}`;

  async function copiar(f: QuotationListRow) {
    setError(null);
    try {
      const creada = await duplicateQuotation(f.id);
      navigate(`/cotizacion/${creada.number}`);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function eliminar(f: QuotationListRow) {
    if (!window.confirm(`¿Eliminar el presupuesto ${f.number}?`)) return;
    setError(null);
    try {
      await deleteQuotation(f.id);
      await cargar();
    } catch (err) {
      setError(describeQuotationError(getErrorMessage(err)));
    }
  }

  const botones: AccionListado<QuotationListRow>[] = [
    { label: 'Ver', onClick: (f) => f && navigate(ficha(f)) },
    { label: 'Imprimir', onClick: (f) => f && navigate(urlDeAccion(ficha(f), 'imprimir')) },
  ];

  const masAcciones = [
    {
      label: 'Descargar comprobante',
      onClick: (f: QuotationListRow | null) => f && navigate(urlDeAccion(ficha(f), 'descargar')),
    },
    { label: 'Copiar comprobante', bloqueo: soloAdmin, onClick: (f: QuotationListRow | null) => f && copiar(f) },
    ...(isAdmin ? [ETIQUETAR] : []),
    {
      label: 'Enviar comprobante por WhatsApp',
      onClick: (f: QuotationListRow | null) => f && navigate(urlDeAccion(ficha(f), 'whatsapp')),
    },
    {
      label: 'Enviar comprobante por correo',
      onClick: (f: QuotationListRow | null) => f && navigate(urlDeAccion(ficha(f), 'email')),
    },
    {
      label: 'Ver orden de trabajo',
      bloqueo: (f: QuotationListRow) => (f.workOrderNumber ? null : 'Este presupuesto no está en ninguna orden.'),
      onClick: (f: QuotationListRow | null) => f?.workOrderNumber && navigate(`/orden/${f.workOrderNumber}`),
    },
    {
      label: 'Eliminar comprobante',
      bloqueo: (f: QuotationListRow) =>
        soloAdmin() ??
        (f.workOrderNumber ? `No se puede eliminar: está enganchado a la orden ${f.workOrderNumber}.` : null),
      onClick: (f: QuotationListRow | null) => f && eliminar(f),
    },
    { label: 'Nuevo cliente', sinSeleccion: true, onClick: () => navigate('/clientes?nuevo=1') },
    { label: 'Nuevo producto/servicio', sinSeleccion: true, onClick: () => navigate('/inventario?nuevo=1') },
  ];

  return (
    <ComprobantesListado
      titulo="Cotizaciones"
      tipo="presupuesto"
      filas={quotations}
      loading={loading}
      error={error}
      getId={getId}
      columnas={COLUMNAS}
      nuevo={{
        to: '/ordenes',
        title: 'Los presupuestos se arman desde la orden de trabajo, con el botón Cotizar.',
      }}
      onAbrir={(f) => navigate(ficha(f))}
      botones={botones}
      masAcciones={masAcciones}
      etiquetasDe={(f) => f.etiquetas}
      onEtiquetasGuardadas={(id, etiquetas) =>
        setQuotations((rows) => rows.map((r) => (r.id === id ? { ...r, etiquetas } : r)))
      }
      vacio="Todavía no hay presupuestos."
    />
  );
}
