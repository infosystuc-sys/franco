import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  balanceOf,
  describeInvoiceError,
  fetchInvoices,
  formatDate,
  letraYNumeroDeSaldoInicial,
  paymentStateOf,
  acreditadaPorNc,
  type InvoiceListRow,
} from '@/src/lib/invoices';
import { emitirEnArca } from '@/src/lib/arcaFacturacion';
import { siNo } from '@/src/lib/comprobantes';
import { urlDeAccion } from '@/src/lib/accionDesdeListado';
import {
  ComprobantesListado,
  ETIQUETAR,
  type AccionListado,
  type ColumnaListado,
} from '@/src/components/ComprobantesListado';

const SOLO_EMITIDA = (f: InvoiceListRow) =>
  f.status === 'EMITIDA' ? null : 'Solo sobre una factura emitida: esta está anulada o esperando el CAE.';

/** Un saldo inicial no es un comprobante: no se imprime, ni se manda, ni se copia. */
const NO_SALDO_INICIAL = (f: InvoiceListRow) =>
  f.saldoInicial ? 'Es un saldo inicial del sistema anterior, no un comprobante: solo se cobra.' : null;
const COMPROBANTE_EMITIDO = (f: InvoiceListRow) => NO_SALDO_INICIAL(f) ?? SOLO_EMITIDA(f);

function estado(f: InvoiceListRow): string {
  if (f.status === 'ANULADA') return 'Anulado';
  if (f.saldoInicial) return 'Saldo inicial';
  if (f.status === 'PENDIENTE_CAE') return f.caeRechazo ? 'Rechazado por ARCA' : 'Pendiente de CAE';
  return 'Emitido';
}

function cobrado(f: InvoiceListRow): string {
  if (f.status !== 'EMITIDA') return '—';
  const pago = paymentStateOf(f);
  if (acreditadaPorNc(f)) return 'Acreditada';
  return pago === 'PAGADA' ? 'Si' : pago === 'PARCIAL' ? 'Parcial' : 'No';
}

const COLUMNAS: ColumnaListado<InvoiceListRow>[] = [
  {
    label: 'Comprobante',
    valor: (f) => {
      if (!f.saldoInicial) return `FVA ${f.invoiceType} ${f.fullNumber}`;
      const { letra, numero } = letraYNumeroDeSaldoInicial(f);
      return letra ? `FVA ${letra} ${numero}` : numero;
    },
  },
  { label: 'Cliente', valor: (f) => f.customerName, ancho: 'w-full' },
  { label: 'Emisión', valor: (f) => formatDate(f.issueDate) },
  { label: 'Vencimiento', valor: (f) => formatDate(f.dueDate) },
  { label: 'Enviado', valor: (f) => siNo(!!f.enviadoAt) },
  { label: 'Total', valor: (f) => `$ ${formatMoney(f.totalAmount)}`, derecha: true },
  { label: 'Estado', valor: estado },
  // La X no es fiscal: ARCA no la autoriza, ni tiene por qué.
  { label: 'Autorizado', valor: (f) => (f.invoiceType === 'X' || f.saldoInicial ? '—' : siNo(f.autorizada)) },
  { label: 'Cobrado', valor: cobrado },
];

/**
 * Facturas de venta, con el listado y las acciones del de Tango. Cada acción
 * sobre un comprobante abre su ficha y le pide la acción por la URL: la ficha
 * es la que sabe dibujar la factura, imprimirla y mandarla.
 */
/** Además de las columnas, se busca por el equipo de la OT (patente, N° de pieza). */
const textoBusquedaFactura = (f: InvoiceListRow) => [f.equipo];

export function Invoices() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [invoices, setInvoices] = React.useState<InvoiceListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      setInvoices(await fetchInvoices());
    } catch (err) {
      setError(describeInvoiceError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  const getId = React.useCallback((f: InvoiceListRow) => f.id, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  const ficha = (f: InvoiceListRow) => `/factura/${f.id}`;

  /** Pedirle a ARCA el CAE que quedó pendiente, sin salir del listado. */
  async function pedirCae(f: InvoiceListRow) {
    const motivo = f.caeRechazo ? `\n\nLa vez anterior ARCA dijo:\n${f.caeRechazo}` : '';
    if (
      !window.confirm(
        `Pedirle a ARCA el CAE de la ${f.fullNumber}, por $ ${formatMoney(f.totalAmount)}.` +
          `${motivo}\n\nSi ARCA la autoriza, el comprobante queda emitido y solo se ` +
          'puede revertir con una nota de crédito.'
      )
    ) {
      return;
    }
    setError(null);
    try {
      await emitirEnArca(f.id);
    } catch (err) {
      setError(getErrorMessage(err));
    }
    await cargar();
  }

  const botones: AccionListado<InvoiceListRow>[] = [
    { label: 'Ver', onClick: (f) => f && navigate(ficha(f)) },
    { label: 'Imprimir', bloqueo: COMPROBANTE_EMITIDO, onClick: (f) => f && navigate(urlDeAccion(ficha(f), 'imprimir')) },
    {
      label: 'Generar ticket de cambio',
      bloqueo: COMPROBANTE_EMITIDO,
      onClick: (f) => f && navigate(urlDeAccion(ficha(f), 'ticket')),
    },
  ];

  const masAcciones = [
    {
      label: 'Descargar comprobante',
      bloqueo: COMPROBANTE_EMITIDO,
      onClick: (f: InvoiceListRow | null) => f && navigate(urlDeAccion(ficha(f), 'descargar')),
    },
    {
      label: 'Copiar comprobante',
      bloqueo: NO_SALDO_INICIAL,
      onClick: (f: InvoiceListRow | null) => f && navigate(`/facturas/nueva?copiar=${f.id}`),
    },
    ETIQUETAR,
    {
      label: 'Generar nota de crédito',
      bloqueo: (f: InvoiceListRow) => {
        if (f.saldoInicial) return 'Un saldo inicial no lleva nota de crédito: si está mal, se anula desde la ficha.';
        if (f.invoiceType === 'X') return 'La serie X no lleva nota de crédito: se anula desde la ficha.';
        return SOLO_EMITIDA(f);
      },
      onClick: (f: InvoiceListRow | null) => f && navigate(`/notas-credito/nueva?factura=${f.id}`),
    },
    {
      label: 'Enviar comprobante por WhatsApp',
      bloqueo: COMPROBANTE_EMITIDO,
      onClick: (f: InvoiceListRow | null) => f && navigate(urlDeAccion(ficha(f), 'whatsapp')),
    },
    {
      label: 'Enviar comprobante por correo',
      bloqueo: COMPROBANTE_EMITIDO,
      onClick: (f: InvoiceListRow | null) => f && navigate(urlDeAccion(ficha(f), 'email')),
    },
    {
      label: 'Cobrar',
      bloqueo: (f: InvoiceListRow) =>
        SOLO_EMITIDA(f) ?? (balanceOf(f) > 0 ? null : 'Esta factura no tiene saldo pendiente.'),
      onClick: (f: InvoiceListRow | null) =>
        f && navigate(`/cobranzas/nueva?cliente=${f.customerId}&factura=${f.id}`),
    },
    {
      label: 'Pedir el CAE a ARCA',
      bloqueo: (f: InvoiceListRow) =>
        f.status === 'PENDIENTE_CAE' ? null : 'Solo para una factura que quedó esperando el CAE.',
      onClick: (f: InvoiceListRow | null) => f && pedirCae(f),
    },
    {
      label: 'Órdenes para facturar',
      sinSeleccion: true,
      onClick: () => navigate('/facturas/pendientes'),
    },
    { label: 'Nuevo cliente', sinSeleccion: true, onClick: () => navigate('/clientes?nuevo=1') },
    { label: 'Nuevo producto/servicio', sinSeleccion: true, onClick: () => navigate('/inventario?nuevo=1') },
  ];

  return (
    <ComprobantesListado
      textoBusqueda={textoBusquedaFactura}
      titulo="Facturas de venta"
      tipo="factura"
      filas={invoices}
      loading={loading}
      error={error}
      getId={getId}
      columnas={COLUMNAS}
      nuevo={{ to: '/facturas/nueva' }}
      onAbrir={(f) => navigate(ficha(f))}
      botones={botones}
      masAcciones={masAcciones}
      etiquetasDe={(f) => f.etiquetas}
      onEtiquetasGuardadas={(id, etiquetas) =>
        setInvoices((rows) => rows.map((r) => (r.id === id ? { ...r, etiquetas } : r)))
      }
      vacio="Todavía no hay facturas emitidas."
    />
  );
}
