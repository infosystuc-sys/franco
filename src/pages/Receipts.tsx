import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { describeReceiptError, fetchReceipts, type Receipt } from '@/src/lib/receipts';
import { siNo } from '@/src/lib/comprobantes';
import { urlDeAccion } from '@/src/lib/accionDesdeListado';
import {
  ComprobantesListado,
  ETIQUETAR,
  type AccionListado,
  type ColumnaListado,
} from '@/src/components/ComprobantesListado';

const SOLO_REGISTRADO = (f: Receipt) =>
  f.status === 'REGISTRADO' ? null : 'Este recibo está anulado.';

const COLUMNAS: ColumnaListado<Receipt>[] = [
  { label: 'Comprobante', valor: (f) => f.fullNumber },
  { label: 'Cliente', valor: (f) => f.customerName, ancho: 'w-full' },
  { label: 'Fecha', valor: (f) => formatDate(f.receiptDate) },
  {
    label: 'Imputado a',
    valor: (f) =>
      f.allocations.length === 0
        ? 'A cuenta'
        : f.allocations.map((a) => `${a.invoiceType} ${a.invoiceFullNumber}`).join(', '),
  },
  { label: 'Enviado', valor: (f) => siNo(!!f.enviadoAt) },
  { label: 'Total', valor: (f) => `$ ${formatMoney(f.totalAmount)}`, derecha: true },
  {
    label: 'A cuenta',
    valor: (f) => (f.onAccountAmount > 0 ? `$ ${formatMoney(f.onAccountAmount)}` : '—'),
    derecha: true,
  },
  { label: 'Estado', valor: (f) => (f.status === 'ANULADO' ? 'Anulado' : 'Emitido') },
];

/**
 * Cobranzas: los recibos emitidos, con el listado y las acciones del de Tango.
 * Lo ven todos los administradores, también los que tienen el historial
 * restringido en otras pantallas: así lo pidió el taller.
 */
export function Receipts() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchReceipts()
      .then((r) => !cancelled && setReceipts(r))
      .catch((err) => !cancelled && setError(describeReceiptError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const getId = React.useCallback((f: Receipt) => f.id, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const ficha = (f: Receipt) => `/recibo/${f.id}`;

  const botones: AccionListado<Receipt>[] = [
    { label: 'Ver', onClick: (f) => f && navigate(ficha(f)) },
    { label: 'Imprimir', bloqueo: SOLO_REGISTRADO, onClick: (f) => f && navigate(urlDeAccion(ficha(f), 'imprimir')) },
  ];

  const masAcciones = [
    {
      label: 'Descargar comprobante',
      bloqueo: SOLO_REGISTRADO,
      onClick: (f: Receipt | null) => f && navigate(urlDeAccion(ficha(f), 'descargar')),
    },
    ETIQUETAR,
    {
      label: 'Enviar comprobante por WhatsApp',
      bloqueo: SOLO_REGISTRADO,
      onClick: (f: Receipt | null) => f && navigate(urlDeAccion(ficha(f), 'whatsapp')),
    },
    {
      label: 'Enviar comprobante por correo',
      bloqueo: SOLO_REGISTRADO,
      onClick: (f: Receipt | null) => f && navigate(urlDeAccion(ficha(f), 'email')),
    },
    {
      label: 'Nuevo recibo para este cliente',
      onClick: (f: Receipt | null) => f && navigate(`/cobranzas/nueva?cliente=${f.customerId}`),
    },
    {
      label: 'Cuenta corriente de clientes',
      sinSeleccion: true,
      onClick: () => navigate('/cuenta-corriente-clientes'),
    },
    { label: 'Nuevo cliente', sinSeleccion: true, onClick: () => navigate('/clientes?nuevo=1') },
  ];

  return (
    <ComprobantesListado
      titulo="Recibos de venta"
      tipo="recibo"
      filas={receipts}
      loading={loading}
      error={error}
      getId={getId}
      columnas={COLUMNAS}
      nuevo={{ to: '/cobranzas/nueva' }}
      onAbrir={(f) => navigate(ficha(f))}
      botones={botones}
      masAcciones={masAcciones}
      etiquetasDe={(f) => f.etiquetas}
      onEtiquetasGuardadas={(id, etiquetas) =>
        setReceipts((rows) => rows.map((r) => (r.id === id ? { ...r, etiquetas } : r)))
      }
      vacio="Todavía no hay cobranzas registradas."
    />
  );
}
