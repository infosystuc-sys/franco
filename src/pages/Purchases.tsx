import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  balanceOf,
  describePurchaseError,
  eliminarComprobanteDeCompra,
  fetchPurchases,
  formatDate,
  isOverdue,
  PURCHASE_DOC_TYPE_LABELS,
  PURCHASE_DOC_TYPE_SHORT,
  PURCHASE_KIND_LABELS,
  signOf,
  type PurchaseListRow,
} from '@/src/lib/purchases';
import { urlDeAccion } from '@/src/lib/accionDesdeListado';
import {
  ComprobantesListado,
  ETIQUETAR,
  type AccionListado,
  type ColumnaListado,
} from '@/src/components/ComprobantesListado';

const NO_ANULADO = (f: PurchaseListRow) =>
  f.status === 'ANULADA' ? 'Este comprobante está anulado.' : null;

function pagado(f: PurchaseListRow): string {
  if (f.status === 'ANULADA') return '—';
  if (f.docType === 'NOTA_CREDITO') return balanceOf(f) > 0 ? 'A aplicar' : 'Aplicada';
  if (balanceOf(f) <= 0) return 'Si';
  return f.settledAmount > 0 ? 'Parcial' : 'No';
}

const COLUMNAS: ColumnaListado<PurchaseListRow>[] = [
  {
    label: 'Comprobante',
    valor: (f) => `${PURCHASE_DOC_TYPE_SHORT[f.docType]} ${f.letter} ${f.fullNumber}`,
  },
  { label: 'Proveedor', valor: (f) => f.supplierName, ancho: 'w-full' },
  { label: 'Tipo', valor: (f) => PURCHASE_KIND_LABELS[f.kind] },
  { label: 'Emisión', valor: (f) => formatDate(f.issueDate) },
  {
    label: 'Vencimiento',
    valor: (f) =>
      f.docType === 'NOTA_CREDITO' ? '—' : `${formatDate(f.dueDate)}${isOverdue(f) ? ' · vencido' : ''}`,
  },
  {
    label: 'Total',
    valor: (f) => `${signOf(f.docType) < 0 ? '−' : ''}$ ${formatMoney(f.totalAmount)}`,
    derecha: true,
  },
  {
    label: 'Saldo',
    valor: (f) => (f.status === 'ANULADA' ? '—' : `$ ${formatMoney(balanceOf(f))}`),
    derecha: true,
  },
  { label: 'Estado', valor: (f) => (f.status === 'ANULADA' ? 'Anulado' : 'Registrado') },
  { label: 'Pagado', valor: pagado },
];

/**
 * Comprobantes de compra, con el listado y las acciones del de Tango. Son los
 * que manda el proveedor: se registran, se pagan y se imprimen, pero no se
 * envían.
 */
export function Purchases() {
  const { role, canViewHistory } = useAuth();
  const navigate = useNavigate();
  const [docs, setDocs] = React.useState<PurchaseListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      setDocs(await fetchPurchases());
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  const getId = React.useCallback((f: PurchaseListRow) => f.id, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const ficha = (f: PurchaseListRow) => `/compra/${f.id}`;

  async function eliminar(f: PurchaseListRow) {
    if (
      !window.confirm(
        `Eliminar ${PURCHASE_DOC_TYPE_LABELS[f.docType]} ${f.letter} ${f.fullNumber} de ${f.supplierName}.\n\n` +
          'Se borra del listado, del Libro IVA Compras y de la cuenta del proveedor, junto con ' +
          'sus renglones. Si movió stock, el stock se devuelve.\n\nNo se puede deshacer.'
      )
    ) {
      return;
    }
    setError(null);
    try {
      await eliminarComprobanteDeCompra(f.id);
      await cargar();
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
    }
  }

  const botones: AccionListado<PurchaseListRow>[] = [
    { label: 'Ver', onClick: (f) => f && navigate(ficha(f)) },
    { label: 'Imprimir', onClick: (f) => f && navigate(urlDeAccion(ficha(f), 'imprimir')) },
  ];

  const masAcciones = [
    {
      label: 'Descargar comprobante',
      onClick: (f: PurchaseListRow | null) => f && navigate(urlDeAccion(ficha(f), 'descargar')),
    },
    ETIQUETAR,
    {
      label: 'Pagar',
      bloqueo: (f: PurchaseListRow) =>
        NO_ANULADO(f) ??
        (f.docType === 'NOTA_CREDITO'
          ? 'Una nota de crédito no se paga: se aplica en una orden de pago.'
          : balanceOf(f) > 0
            ? null
            : 'Este comprobante no tiene saldo pendiente.'),
      onClick: (f: PurchaseListRow | null) => f && navigate(`/pagos/nueva?proveedor=${f.supplierId}`),
    },
    {
      label: 'Eliminar comprobante',
      bloqueo: NO_ANULADO,
      onClick: (f: PurchaseListRow | null) => f && eliminar(f),
    },
    {
      label: 'Nueva compra de conceptos',
      sinSeleccion: true,
      onClick: () => navigate('/compras/nueva/conceptos'),
    },
    { label: 'Nueva compra con IA', sinSeleccion: true, onClick: () => navigate('/compras-ia') },
    {
      label: 'Cuenta corriente de proveedores',
      sinSeleccion: true,
      onClick: () => navigate('/cuenta-corriente-proveedores'),
    },
    { label: 'Nuevo proveedor', sinSeleccion: true, onClick: () => navigate('/proveedores?nuevo=1') },
    { label: 'Nuevo producto/servicio', sinSeleccion: true, onClick: () => navigate('/inventario?nuevo=1') },
  ];

  return (
    <ComprobantesListado
      titulo="Comprobantes de compra"
      tipo="compra"
      filas={docs}
      loading={loading}
      error={error}
      getId={getId}
      columnas={COLUMNAS}
      nuevo={{ to: '/compras/nueva/articulos', title: 'Compra de artículos. La de conceptos está en Más acciones.' }}
      onAbrir={(f) => navigate(ficha(f))}
      botones={botones}
      masAcciones={masAcciones}
      etiquetasDe={(f) => f.etiquetas}
      onEtiquetasGuardadas={(id, etiquetas) =>
        setDocs((rows) => rows.map((r) => (r.id === id ? { ...r, etiquetas } : r)))
      }
      ocultarListado={!canViewHistory}
      vacio="Todavía no hay compras cargadas."
    />
  );
}
