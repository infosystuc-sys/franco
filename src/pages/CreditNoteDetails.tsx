import React from 'react';
import { XCircle, Printer, AlertTriangle, Stamp, Receipt, Mail, MessageCircle } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader } from '@/src/components/ui';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { afipQrUrl, discriminatesVat, formatDate } from '@/src/lib/invoices';
import {
  describeCreditNoteError,
  fetchCreditNoteById,
  type CreditNoteDetail,
} from '@/src/lib/creditNotes';
import { emitirNcEnArca } from '@/src/lib/arcaFacturacion';
import { fetchCompanySettings } from '@/src/lib/companySettings';
import { SendDocumentModal } from '@/src/components/SendDocumentModal';
import { useAccionDesdeListado } from '@/src/lib/accionDesdeListado';
import { marcarEnviado } from '@/src/lib/comprobantes';

/** Los códigos de nota de crédito de ARCA, para el QR. */
const COD_NOTA_CREDITO: Record<string, number> = { A: 3, B: 8, C: 13 };

export function CreditNoteDetails() {
  const { role } = useAuth();
  const { id } = useParams();

  const [nc, setNc] = React.useState<CreditNoteDetail | null>(null);
  const [logo, setLogo] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [pidiendoCae, setPidiendoCae] = React.useState(false);
  const [sendModal, setSendModal] = React.useState<'email' | 'whatsapp' | null>(null);
  const documentRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setNc(await fetchCreditNoteById(id));
      setLogo((await fetchCompanySettings().catch(() => null))?.logo ?? null);
    } catch (err) {
      setError(describeCreditNoteError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => { load(); }, [load]);

  // Los botones del listado llegan acá con la acción en la URL.
  const desdeListado = useAccionDesdeListado({
    listo: !loading && nc?.status === 'EMITIDA',
    listado: '/notas-credito',
    documentRef,
    nombreArchivo: `NC-${nc?.fullNumber ?? ''}.pdf`,
    abrirEnvio: setSendModal,
  });

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) return <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">Cargando…</div>;

  if (!nc) {
    return (
      <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">
        No se encontró la nota de crédito.{' '}
        <Link to="/notas-credito" className="text-accent-deep underline">Ver todas</Link>
      </div>
    );
  }

  const pendiente = nc.status === 'PENDIENTE_CAE';

  async function handlePedirCae() {
    if (!nc) return;
    if (
      !window.confirm(
        `Pedirle a ARCA el CAE de la nota de crédito ${nc.fullNumber}, por ` +
          `$ ${formatMoney(nc.totalAmount)}.\n\nSi la autoriza, queda emitida y no ` +
          'se puede deshacer.'
      )
    ) {
      return;
    }

    setPidiendoCae(true);
    setError(null);
    try {
      await emitirNcEnArca(nc.id);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPidiendoCae(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print">
        <PageHeader
          title={
            <span className="font-mono text-3xl font-medium tracking-normal text-text">
              {nc.fullNumber}
            </span>
          }
          meta={
            <span className="inline-flex items-center gap-1.5 rounded bg-panel-head px-2 py-1 text-[13px] font-semibold uppercase tracking-[0.08em] text-text-soft">
              {pendiente ? <><AlertTriangle size={14} /> Esperando CAE</> : 'Emitida'}
            </span>
          }
          subtitle={
            <>
            <span className="mt-1 block text-text-soft">
              {nc.devuelveFondos
                ? 'La plata se devolvió por tesorería.'
                : 'Queda a cuenta del cliente: se aplica en una cobranza, contra esta factura o contra otra.'}
            </span>
            <Link
              to={`/factura/${nc.invoiceId}`}
              className="inline-flex items-center gap-1.5 text-accent-deep hover:underline"
            >
              <Receipt size={14} /> Revierte la factura {nc.invoiceFullNumber}
              {nc.cancelaTotal ? ' (la cancela entera)' : ' (parcial)'}
            </Link>
            </>
          }
          actions={
            <>
              <Link to="/notas-credito">
                <Button variant="ghost" type="button"><XCircle size={16} /> Volver</Button>
              </Link>
              {pendiente ? (
                <Button type="button" onClick={handlePedirCae} disabled={pidiendoCae}>
                  <Stamp size={16} />{' '}
                  {pidiendoCae ? 'Pidiendo el CAE…' : nc.caeRechazo ? 'Reintentar el CAE' : 'Pedir el CAE a ARCA'}
                </Button>
              ) : (
                <>
                  <Button variant="ghost" type="button" onClick={() => window.print()}>
                    <Printer size={16} /> Imprimir
                  </Button>
                  <Button variant="ghost" type="button" onClick={() => setSendModal('email')}>
                    <Mail size={16} /> Enviar por mail
                  </Button>
                  <Button variant="ghost" type="button" onClick={() => setSendModal('whatsapp')}>
                    <MessageCircle size={16} /> Enviar por WhatsApp
                  </Button>
                </>
              )}
            </>
          }
        />

        {error && (
          <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {pendiente && (
          <div className="mb-6 flex items-start gap-2 rounded-md border border-line bg-panel-head px-4 py-3 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-text-soft" />
            <span>
              El número {nc.fullNumber} quedó reservado y ARCA todavía no le dio el
              CAE. Hasta que lo dé no revierte nada: el saldo de la factura sigue
              entero.
            </span>
          </div>
        )}

        {nc.caeRechazo && (
          <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            <p className="font-semibold">
              ARCA no autorizó la nota de crédito
              {nc.caeRechazadoAt && ` el ${formatDate(nc.caeRechazadoAt.slice(0, 10))}`}.
            </p>
            <ul className="mt-2 list-disc pl-5">
              {nc.caeRechazo.split(' · ').map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div ref={documentRef}>
        <CreditNoteDocument nc={nc} logo={logo} />
      </div>

      {sendModal && (
        <SendDocumentModal
          channel={sendModal}
          defaultDestino={(sendModal === 'email' ? nc.customerEmail : nc.customerPhone) ?? null}
          fileName={`NC-${nc.fullNumber}.pdf`}
          documentRef={documentRef}
          subject={`Nota de crédito ${nc.fullNumber}`}
          text={
            sendModal === 'email'
              ? `Adjuntamos la nota de crédito ${nc.fullNumber} por $ ${formatMoney(nc.totalAmount)}.`
              : `Nota de crédito ${nc.fullNumber} — $ ${formatMoney(nc.totalAmount)}`
          }
          onSent={() => marcarEnviado('nota_credito', nc.id)}
          onClose={() => {
            setSendModal(null);
            if (desdeListado.vinoDelListado) desdeListado.volverAlListado();
          }}
        />
      )}
    </div>
  );
}

function QrDeArca({ url }: { url: string }) {
  const [svg, setSvg] = React.useState<string | null>(null);
  React.useEffect(() => {
    let vigente = true;
    QRCode.toString(url, { type: 'svg', margin: 0 })
      .then((s) => vigente && setSvg(s))
      .catch(() => vigente && setSvg(null));
    return () => { vigente = false; };
  }, [url]);
  if (!svg) return null;
  return <div className="h-21.5 w-21.5 shrink-0" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function CreditNoteDocument({
  nc,
  logo,
}: {
  nc: CreditNoteDetail;
  logo?: string | null;
}) {
  const discriminates = discriminatesVat(nc.invoiceType);
  // Mismo QR que la factura; lo único que cambia es el código de comprobante,
  // que va adentro del JSON y por eso se pasa, no se parchea después.
  const qrDeNota = afipQrUrl(nc, COD_NOTA_CREDITO[nc.invoiceType]);

  return (
    <div className="print-document relative border border-line bg-panel p-6 md:p-8">
      <div className="grid grid-cols-1 gap-4 border-b-2 border-ink pb-5 sm:grid-cols-[1fr_auto_1fr]">
        <div>
          {logo && (
            <img src={logo} alt="" className="mb-3 max-h-20 max-w-55 object-contain object-left" />
          )}
          <h2 className="font-display text-2xl font-medium uppercase leading-tight text-text">
            {nc.issuerLegalName}
          </h2>
          <dl className="mt-2 space-y-0.5 text-[13px] text-text-soft">
            {nc.issuerAddress && <dd>{nc.issuerAddress}</dd>}
            <dd>{TAX_CONDITION_LABELS[nc.issuerTaxCondition]}</dd>
            {nc.issuerTaxId && <dd className="font-mono">CUIT {formatCuit(nc.issuerTaxId)}</dd>}
            {nc.issuerGrossIncome && <dd>Ingresos Brutos {nc.issuerGrossIncome}</dd>}
          </dl>
        </div>

        <div className="flex flex-col items-center justify-start self-start border-2 border-ink px-5 py-2">
          <span className="font-display text-4xl font-medium leading-none text-text">
            {nc.invoiceType}
          </span>
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            Cód. {String(COD_NOTA_CREDITO[nc.invoiceType] ?? 0).padStart(2, '0')}
          </span>
        </div>

        <div className="sm:text-right">
          <h3 className="font-display text-xl uppercase tracking-[0.08em] text-text-faint">
            Nota de crédito {nc.invoiceType}
          </h3>
          <p className="mt-1 font-mono text-lg font-semibold text-text">{nc.fullNumber}</p>
          <dl className="mt-2 space-y-0.5 text-[13px] text-text-soft">
            <dd>Fecha de emisión: {formatDate(nc.issueDate)}</dd>
          </dl>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-line py-4 text-[14px] sm:grid-cols-2">
        <Dato label="Señor(es)" value={nc.customerLegalName || nc.customerName} />
        <Dato label="CUIT / CUIL" value={nc.customerTaxId ? formatCuit(nc.customerTaxId) : '—'} mono />
        <Dato label="Domicilio" value={nc.customerAddress || '—'} />
        <Dato label="Condición frente al IVA" value={TAX_CONDITION_LABELS[nc.customerTaxCondition]} />
        <Dato
          label="Comprobante asociado"
          value={`${nc.invoiceType} ${nc.invoiceFullNumber}${nc.invoiceIssueDate ? ` del ${formatDate(nc.invoiceIssueDate)}` : ''}`}
          mono
        />
        {nc.motivo && <Dato label="Motivo" value={nc.motivo} />}
      </div>

      <table className="mt-4 w-full text-[14px]">
        <thead>
          <tr className="border-b border-line text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            <th className="py-2">Código</th>
            <th className="py-2">Descripción</th>
            <th className="py-2 text-right">Cant.</th>
            <th className="py-2 text-right">P. unitario</th>
            <th className="py-2 text-right">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {nc.items.map((item, i) => (
            <tr key={i} className="border-b border-line/60">
              <td className="py-1.5 font-mono text-text-soft">{item.code || '—'}</td>
              <td className="py-1.5">{item.description}</td>
              <td className="py-1.5 text-right">{item.quantity.toFixed(2)}</td>
              <td className="py-1.5 text-right">$ {formatMoney(item.unitPrice)}</td>
              <td className="py-1.5 text-right">$ {formatMoney(item.subtotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex flex-col items-end gap-1 text-[14px]">
        {discriminates && (
          <>
            <span className="text-text-soft">Subtotal $ {formatMoney(nc.netAmount)}</span>
            <span className="text-text-soft">IVA 21% $ {formatMoney(nc.vatAmount)}</span>
          </>
        )}
        <span className="border-t border-ink pt-1 text-lg font-semibold">
          Total $ {formatMoney(nc.totalAmount)}
        </span>
      </div>

      {nc.cae ? (
        <div className="mt-6 flex items-center gap-4 border-t border-line pt-3">
          {qrDeNota && <QrDeArca url={qrDeNota} />}
          <div className="flex-1 text-center">
            <p className="text-[12px] text-text-faint">
              CAE <span className="font-mono text-text-soft">{nc.cae}</span>
              {nc.caeDueDate && <> · Vence {formatDate(nc.caeDueDate)}</>}
            </p>
          </div>
        </div>
      ) : (
        <p className="mt-6 border-t border-line pt-3 text-center text-[12px] text-text-faint">
          Comprobante no válido: pendiente de autorización de ARCA.
        </p>
      )}
    </div>
  );
}

function Dato({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-text-faint">{label}:</span>
      <span className={cn('text-text', mono && 'font-mono')}>{value}</span>
    </div>
  );
}
