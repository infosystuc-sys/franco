import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describePaymentOrderError,
  fetchPaymentOrders,
  PURCHASE_DOC_TYPE_SHORT,
  type PaymentOrder,
} from '@/src/lib/paymentOrders';
import { siNo } from '@/src/lib/comprobantes';
import { urlDeAccion } from '@/src/lib/accionDesdeListado';
import {
  ComprobantesListado,
  ETIQUETAR,
  type AccionListado,
  type ColumnaListado,
} from '@/src/components/ComprobantesListado';

const SOLO_REGISTRADA = (f: PaymentOrder) =>
  f.status === 'REGISTRADA' ? null : 'Esta orden de pago está anulada.';

const COLUMNAS: ColumnaListado<PaymentOrder>[] = [
  { label: 'Comprobante', valor: (f) => f.fullNumber },
  { label: 'Proveedor', valor: (f) => f.supplierName, ancho: 'w-full' },
  { label: 'Fecha', valor: (f) => formatDate(f.paymentDate) },
  {
    label: 'Imputado a',
    valor: (f) =>
      f.allocations.length === 0
        ? 'A cuenta'
        : f.allocations
            .map((a) => (a.isProvisional ? a.fullNumber : `${PURCHASE_DOC_TYPE_SHORT[a.docType]} ${a.letter} ${a.fullNumber}`))
            .join(', '),
  },
  { label: 'Enviado', valor: (f) => siNo(!!f.enviadoAt) },
  { label: 'Total', valor: (f) => `$ ${formatMoney(f.totalAmount)}`, derecha: true },
  {
    label: 'A cuenta',
    valor: (f) => (f.onAccountAmount > 0 ? `$ ${formatMoney(f.onAccountAmount)}` : '—'),
    derecha: true,
  },
  { label: 'Estado', valor: (f) => (f.status === 'ANULADA' ? 'Anulado' : 'Emitido') },
];

/** Órdenes de pago a proveedores, con el listado y las acciones del de Tango. */
export function PaymentOrders() {
  const { role, canViewHistory } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = React.useState<PaymentOrder[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchPaymentOrders()
      .then((o) => !cancelled && setOrders(o))
      .catch((err) => !cancelled && setError(describePaymentOrderError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const getId = React.useCallback((f: PaymentOrder) => f.id, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const ficha = (f: PaymentOrder) => `/pago/${f.id}`;

  const botones: AccionListado<PaymentOrder>[] = [
    { label: 'Ver', onClick: (f) => f && navigate(ficha(f)) },
    { label: 'Imprimir', bloqueo: SOLO_REGISTRADA, onClick: (f) => f && navigate(urlDeAccion(ficha(f), 'imprimir')) },
  ];

  const masAcciones = [
    {
      label: 'Descargar comprobante',
      bloqueo: SOLO_REGISTRADA,
      onClick: (f: PaymentOrder | null) => f && navigate(urlDeAccion(ficha(f), 'descargar')),
    },
    ETIQUETAR,
    {
      label: 'Enviar comprobante por WhatsApp',
      bloqueo: SOLO_REGISTRADA,
      onClick: (f: PaymentOrder | null) => f && navigate(urlDeAccion(ficha(f), 'whatsapp')),
    },
    {
      label: 'Enviar comprobante por correo',
      bloqueo: SOLO_REGISTRADA,
      onClick: (f: PaymentOrder | null) => f && navigate(urlDeAccion(ficha(f), 'email')),
    },
    {
      label: 'Nueva orden para este proveedor',
      onClick: (f: PaymentOrder | null) => f && navigate(`/pagos/nueva?proveedor=${f.supplierId}`),
    },
    {
      label: 'Cuenta corriente de proveedores',
      sinSeleccion: true,
      onClick: () => navigate('/cuenta-corriente-proveedores'),
    },
    { label: 'Nuevo proveedor', sinSeleccion: true, onClick: () => navigate('/proveedores?nuevo=1') },
  ];

  return (
    <ComprobantesListado
      titulo="Órdenes de pago"
      tipo="orden_pago"
      filas={orders}
      loading={loading}
      error={error}
      getId={getId}
      columnas={COLUMNAS}
      nuevo={{ to: '/pagos/nueva' }}
      onAbrir={(f) => navigate(ficha(f))}
      botones={botones}
      masAcciones={masAcciones}
      etiquetasDe={(f) => f.etiquetas}
      onEtiquetasGuardadas={(id, etiquetas) =>
        setOrders((rows) => rows.map((r) => (r.id === id ? { ...r, etiquetas } : r)))
      }
      ocultarListado={!canViewHistory}
      vacio="Todavía no hay órdenes de pago."
    />
  );
}
