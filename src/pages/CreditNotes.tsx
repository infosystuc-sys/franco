import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { formatDate } from '@/src/lib/invoices';
import {
  describeCreditNoteError,
  fetchCreditNotes,
  type CreditNoteListRow,
} from '@/src/lib/creditNotes';
import { emitirNcEnArca } from '@/src/lib/arcaFacturacion';
import { siNo } from '@/src/lib/comprobantes';
import { urlDeAccion } from '@/src/lib/accionDesdeListado';
import {
  ComprobantesListado,
  ETIQUETAR,
  type AccionListado,
  type ColumnaListado,
} from '@/src/components/ComprobantesListado';

const SOLO_EMITIDA = (f: CreditNoteListRow) =>
  f.status === 'EMITIDA' ? null : 'Solo sobre una nota de crédito emitida: esta está esperando el CAE.';

/** Si la nota ya se usó entera, en parte o quedó a cuenta del cliente. */
function aplicada(f: CreditNoteListRow): string {
  if (f.status !== 'EMITIDA') return '—';
  if (f.devuelveFondos) return 'Devuelta';
  if (f.appliedAmount >= f.totalAmount - 0.005) return 'Si';
  return f.appliedAmount > 0 ? 'Parcial' : 'No';
}

const COLUMNAS: ColumnaListado<CreditNoteListRow>[] = [
  { label: 'Comprobante', valor: (f) => `NCV ${f.invoiceType} ${f.fullNumber}` },
  { label: 'Cliente', valor: (f) => f.customerName, ancho: 'w-full' },
  { label: 'Emisión', valor: (f) => formatDate(f.issueDate) },
  { label: 'Factura', valor: (f) => f.invoiceFullNumber || '—' },
  { label: 'Enviado', valor: (f) => siNo(!!f.enviadoAt) },
  { label: 'Total', valor: (f) => `$ ${formatMoney(f.totalAmount)}`, derecha: true },
  {
    label: 'Estado',
    valor: (f) => (f.status === 'EMITIDA' ? 'Emitido' : f.caeRechazo ? 'Rechazado por ARCA' : 'Pendiente de CAE'),
  },
  { label: 'Autorizado', valor: (f) => siNo(f.autorizada) },
  { label: 'Aplicada', valor: aplicada },
];

export function CreditNotes() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = React.useState<CreditNoteListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      setRows(await fetchCreditNotes());
    } catch (err) {
      setError(describeCreditNoteError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  const getId = React.useCallback((f: CreditNoteListRow) => f.id, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const ficha = (f: CreditNoteListRow) => `/nota-credito/${f.id}`;

  async function pedirCae(nc: CreditNoteListRow) {
    const motivo = nc.caeRechazo ? `\n\nLa vez anterior ARCA dijo:\n${nc.caeRechazo}` : '';
    if (
      !window.confirm(
        `Pedirle a ARCA el CAE de la nota de crédito ${nc.fullNumber}, por ` +
          `$ ${formatMoney(nc.totalAmount)}.${motivo}\n\nSi la autoriza, queda emitida ` +
          'y no se puede deshacer.'
      )
    ) {
      return;
    }
    setError(null);
    try {
      await emitirNcEnArca(nc.id);
    } catch (err) {
      setError(getErrorMessage(err));
    }
    await cargar();
  }

  const botones: AccionListado<CreditNoteListRow>[] = [
    { label: 'Ver', onClick: (f) => f && navigate(ficha(f)) },
    { label: 'Imprimir', bloqueo: SOLO_EMITIDA, onClick: (f) => f && navigate(urlDeAccion(ficha(f), 'imprimir')) },
  ];

  const masAcciones = [
    {
      label: 'Descargar comprobante',
      bloqueo: SOLO_EMITIDA,
      onClick: (f: CreditNoteListRow | null) => f && navigate(urlDeAccion(ficha(f), 'descargar')),
    },
    ETIQUETAR,
    {
      label: 'Ver factura de origen',
      onClick: (f: CreditNoteListRow | null) => f && navigate(`/factura/${f.invoiceId}`),
    },
    {
      label: 'Enviar comprobante por WhatsApp',
      bloqueo: SOLO_EMITIDA,
      onClick: (f: CreditNoteListRow | null) => f && navigate(urlDeAccion(ficha(f), 'whatsapp')),
    },
    {
      label: 'Enviar comprobante por correo',
      bloqueo: SOLO_EMITIDA,
      onClick: (f: CreditNoteListRow | null) => f && navigate(urlDeAccion(ficha(f), 'email')),
    },
    {
      label: 'Imputar a una factura',
      bloqueo: (f: CreditNoteListRow) => {
        const bloqueo = SOLO_EMITIDA(f);
        if (bloqueo) return bloqueo;
        if (f.devuelveFondos) return 'La plata de esta nota ya se devolvió: no queda nada a cuenta.';
        return f.appliedAmount >= f.totalAmount - 0.005 ? 'Esta nota ya está aplicada entera.' : null;
      },
      onClick: () => navigate('/imputaciones'),
    },
    {
      label: 'Pedir el CAE a ARCA',
      bloqueo: (f: CreditNoteListRow) =>
        f.status === 'PENDIENTE_CAE' ? null : 'Solo para una nota que quedó esperando el CAE.',
      onClick: (f: CreditNoteListRow | null) => f && pedirCae(f),
    },
    { label: 'Nuevo cliente', sinSeleccion: true, onClick: () => navigate('/clientes?nuevo=1') },
    { label: 'Nuevo producto/servicio', sinSeleccion: true, onClick: () => navigate('/inventario?nuevo=1') },
  ];

  return (
    <ComprobantesListado
      titulo="Notas de crédito de venta"
      tipo="nota_credito"
      filas={rows}
      loading={loading}
      error={error}
      getId={getId}
      columnas={COLUMNAS}
      nuevo={{ to: '/notas-credito/nueva' }}
      onAbrir={(f) => navigate(ficha(f))}
      botones={botones}
      masAcciones={masAcciones}
      etiquetasDe={(f) => f.etiquetas}
      onEtiquetasGuardadas={(id, etiquetas) =>
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, etiquetas } : r)))
      }
      vacio="Todavía no hay notas de crédito emitidas."
    />
  );
}
