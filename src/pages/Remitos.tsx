import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { formatDate } from '@/src/lib/invoices';
import { describeRemitoError, fetchRemitos, voidRemito, type RemitoListRow } from '@/src/lib/remitos';
import { siNo } from '@/src/lib/comprobantes';
import { urlDeAccion } from '@/src/lib/accionDesdeListado';
import {
  ComprobantesListado,
  ETIQUETAR,
  type AccionListado,
  type ColumnaListado,
} from '@/src/components/ComprobantesListado';

/** Pendiente es "entregado y todavía sin factura", no un estado guardado. */
function isPendingRow(r: RemitoListRow): boolean {
  return r.status === 'EMITIDO' && r.invoiceId === null;
}

const SOLO_PENDIENTE = (f: RemitoListRow) =>
  isPendingRow(f) ? null : f.status === 'ANULADO' ? 'Este remito está anulado.' : 'Este remito ya está facturado.';

const COLUMNAS: ColumnaListado<RemitoListRow>[] = [
  { label: 'Comprobante', valor: (f) => `REM ${f.fullNumber}` },
  { label: 'Cliente', valor: (f) => f.customerName, ancho: 'w-full' },
  { label: 'Emisión', valor: (f) => formatDate(f.issueDate) },
  { label: 'Ítems', valor: (f) => f.itemCount, derecha: true },
  { label: 'Enviado', valor: (f) => siNo(!!f.enviadoAt) },
  {
    label: 'Estado',
    valor: (f) => (f.status === 'ANULADO' ? 'Anulado' : isPendingRow(f) ? 'Pendiente' : 'Emitido'),
  },
  { label: 'Facturado', valor: (f) => (f.status === 'ANULADO' ? '—' : f.invoiceFullNumber ?? 'No') },
];

/**
 * Remitos, con el listado y las acciones del de Tango: los que salieron con
 * una factura y los que se entregaron solos, pendientes de facturar.
 */
export function Remitos() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = React.useState<RemitoListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      setRows(await fetchRemitos());
    } catch (err) {
      setError(describeRemitoError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  const getId = React.useCallback((f: RemitoListRow) => f.id, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const ficha = (f: RemitoListRow) => `/remito/${f.id}`;

  async function anular(r: RemitoListRow) {
    const reason = window.prompt(`¿Por qué se anula el remito ${r.fullNumber}?`);
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert('Hace falta un motivo.');
      return;
    }
    setError(null);
    try {
      await voidRemito(r.id, reason);
      await cargar();
    } catch (err) {
      setError(describeRemitoError(getErrorMessage(err)));
    }
  }

  const NO_ANULADO = (f: RemitoListRow) => (f.status === 'ANULADO' ? 'Este remito está anulado.' : null);

  const botones: AccionListado<RemitoListRow>[] = [
    { label: 'Ver', onClick: (f) => f && navigate(ficha(f)) },
    { label: 'Imprimir', onClick: (f) => f && navigate(urlDeAccion(ficha(f), 'imprimir')) },
  ];

  const masAcciones = [
    {
      label: 'Descargar comprobante',
      onClick: (f: RemitoListRow | null) => f && navigate(urlDeAccion(ficha(f), 'descargar')),
    },
    ETIQUETAR,
    {
      label: 'Facturar remito',
      bloqueo: SOLO_PENDIENTE,
      onClick: (f: RemitoListRow | null) => f && navigate(`/facturas/nueva?remito=${f.id}`),
    },
    {
      label: 'Ver factura',
      bloqueo: (f: RemitoListRow) => (f.invoiceId ? null : 'Este remito no tiene factura.'),
      onClick: (f: RemitoListRow | null) => f?.invoiceId && navigate(`/factura/${f.invoiceId}`),
    },
    {
      label: 'Enviar comprobante por WhatsApp',
      bloqueo: NO_ANULADO,
      onClick: (f: RemitoListRow | null) => f && navigate(urlDeAccion(ficha(f), 'whatsapp')),
    },
    {
      label: 'Enviar comprobante por correo',
      bloqueo: NO_ANULADO,
      onClick: (f: RemitoListRow | null) => f && navigate(urlDeAccion(ficha(f), 'email')),
    },
    {
      label: 'Anular remito',
      bloqueo: SOLO_PENDIENTE,
      onClick: (f: RemitoListRow | null) => f && anular(f),
    },
    { label: 'Nuevo cliente', sinSeleccion: true, onClick: () => navigate('/clientes?nuevo=1') },
    { label: 'Nuevo producto/servicio', sinSeleccion: true, onClick: () => navigate('/inventario?nuevo=1') },
  ];

  return (
    <ComprobantesListado
      titulo="Remitos"
      tipo="remito"
      filas={rows}
      loading={loading}
      error={error}
      getId={getId}
      columnas={COLUMNAS}
      nuevo={{ to: '/remitos/nuevo' }}
      onAbrir={(f) => navigate(ficha(f))}
      botones={botones}
      masAcciones={masAcciones}
      etiquetasDe={(f) => f.etiquetas}
      onEtiquetasGuardadas={(id, etiquetas) =>
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, etiquetas } : r)))
      }
      vacio="Todavía no hay remitos."
    />
  );
}
