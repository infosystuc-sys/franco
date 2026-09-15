import React from 'react';
import { Check, X, AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { PageHeader, Panel, Button } from '@/src/components/ui';
import { QUOTATION_STATUS_LABELS } from '@/src/lib/quotations';
import { downloadElementAsPdf } from '@/src/lib/pdf';
import { QuotationDocument } from '@/src/components/QuotationDocument';
import { fetchTallerHeader, type TallerHeader } from '@/src/lib/companySettings';
import {
  decideQuotation,
  DECISION_MESSAGES,
  fetchPublicQuotation,
  fetchPublicQuotationItems,
  type DecisionResult,
  type PublicQuotation as Quotation,
  type PublicQuotationItem,
} from '@/src/lib/publicQuotation';
import logo from '@/src/assets/logo-luciano-diesel.png';

/**
 * Presupuesto que ve el cliente por el link. Es la única pantalla pública
 * desde la que alguien sin sesión modifica datos: acepta o rechaza.
 *
 * Todas las validaciones están en la base. Acá solo se muestran los botones
 * cuando corresponde; si alguien fuerza el pedido igual, la base lo rechaza.
 */
export function PublicQuotation() {
  const { token } = useParams();
  const [quotation, setQuotation] = React.useState<Quotation | null>(null);
  const [items, setItems] = React.useState<PublicQuotationItem[]>([]);
  const [taller, setTaller] = React.useState<TallerHeader | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [deciding, setDeciding] = React.useState(false);
  const [confirming, setConfirming] = React.useState<'aceptar' | 'rechazar' | null>(null);
  const [bajando, setBajando] = React.useState(false);
  const documentoRef = React.useRef<HTMLDivElement>(null);
  const [result, setResult] = React.useState<DecisionResult | null>(null);
  const [reason, setReason] = React.useState('');

  const load = React.useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const data = await fetchPublicQuotation(token);
      setQuotation(data);
      if (data) {
        const [renglones, datosTaller] = await Promise.all([
          fetchPublicQuotationItems(token),
          fetchTallerHeader().catch(() => null),
        ]);
        setItems(renglones);
        setTaller(datosTaller);
      }
    } catch {
      setQuotation(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  React.useEffect(() => { load(); }, [load]);

  async function decidir(accept: boolean) {
    if (!token) return;
    setDeciding(true);
    try {
      const r = await decideQuotation(token, accept, reason);
      // Si falta el motivo no se cierra el paso de confirmación: el cliente
      // tiene que poder completarlo sin volver a empezar.
      if (r !== 'FALTA_MOTIVO') setConfirming(null);
      setResult(r === 'FALTA_MOTIVO' ? null : r);
      if (r !== 'FALTA_MOTIVO') await load();
    } finally {
      setDeciding(false);
    }
  }

  if (loading) {
    return <Marco><p className="text-center text-text-soft">Cargando presupuesto…</p></Marco>;
  }

  if (!quotation) {
    return (
      <Marco>
        <div className="text-center">
          <p className="font-display text-2xl uppercase tracking-[0.04em] text-text-faint">
            Link no válido
          </p>
          <p className="mt-2 text-sm text-text-soft">
            Este link no corresponde a ningún presupuesto. Puede estar
            incompleto: verificá que lo hayas copiado entero.
          </p>
        </div>
      </Marco>
    );
  }

  const vencido =
    quotation.validUntil !== null &&
    quotation.validUntil < new Date().toISOString().slice(0, 10);
  async function handleDescargarPdf() {
    if (!documentoRef.current) return;
    setBajando(true);
    try {
      await downloadElementAsPdf(documentoRef.current, `Presupuesto-${quotation.number}.pdf`);
    } catch {
      // El cliente no puede hacer nada con un error técnico: se le dice que
      // reintente, y si no, que la página igual muestra todo.
      window.alert('No se pudo armar el PDF. Probá de nuevo; el presupuesto se ve igual en esta pantalla.');
    } finally {
      setBajando(false);
    }
  }

  const pendiente = quotation.status === 'EMITIDA' || quotation.status === 'ENVIADA';
  const puedeDecidir = pendiente && !vencido && !quotation.alreadyConverted;

  return (
    <Marco>
      <PageHeader
        title="Presupuesto"
        subtitle={`N° ${quotation.number}${quotation.customerName ? ` · ${quotation.customerName}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" disabled={bajando} onClick={handleDescargarPdf}>
              <Download size={16} /> {bajando ? 'Armando PDF…' : 'Descargar PDF'}
            </Button>
            <span className="border border-line bg-panel px-4 py-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-text">
              {QUOTATION_STATUS_LABELS[quotation.status]}
            </span>
          </div>
        }
      />

      {result && (
        <div
          className={cn(
            'mb-6 border px-4 py-3 text-sm',
            result === 'ACEPTADA'
              ? 'border-state-done/40 bg-panel-alt text-state-done'
              : 'border-line bg-panel-alt text-text-soft'
          )}
        >
          {DECISION_MESSAGES[result]}
        </div>
      )}

      {vencido && pendiente && !result && (
        <div className="mb-6 flex items-center gap-2 border border-state-wait px-4 py-3 text-sm text-state-wait">
          <AlertTriangle size={16} />
          Este presupuesto venció el{' '}
          {new Date(`${quotation.validUntil}T00:00:00`).toLocaleDateString('es-AR')}.
          Comunicate con el taller para pedir uno actualizado.
        </div>
      )}

      {/* Todo lo que es el presupuesto en sí va adentro de este bloque: es lo
          que se convierte en PDF. Los botones de aceptar y rechazar quedan
          afuera a propósito —en un papel guardado no significan nada—. */}
      {/* El mismo papel que imprime el taller: el cliente ve y se baja el
          presupuesto tal cual, con membrete, no una versión de pantalla. */}
      <div ref={documentoRef} className="mb-6">
        <QuotationDocument
          taller={taller}
          quotation={{
            number: quotation.number,
            issueDate: quotation.createdAt,
            validUntil: quotation.validUntil,
            component: quotation.component,
            notes: quotation.notes,
            customerName: quotation.customerName ?? '—',
            // El link es público: el CUIT y el domicilio del cliente no viajan
            // en él, como en el resto de la vista pública.
            customerTaxId: null,
            customerAddress: null,
            customerTaxCondition: null,
            vehicleBrand: quotation.vehicleBrand,
            vehicleModel: quotation.vehicleModel,
            licensePlate: quotation.licensePlate,
            workOrderNumber: null,
            items: items.map((item) => ({
              code: item.code,
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          }}
        />
      </div>

      {puedeDecidir && !result && (
        <Panel className="p-5">
          {confirming === null ? (
            <>
              <p className="mb-4 text-sm text-text-soft">
                Si el presupuesto está bien, aceptalo y el taller empieza el
                trabajo. Tu respuesta queda registrada.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button onClick={() => setConfirming('aceptar')} className="justify-center sm:flex-1">
                  <Check size={16} /> Aceptar presupuesto
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirming('rechazar')}
                  className="justify-center sm:flex-1"
                >
                  <X size={16} /> Rechazar
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="mb-4 text-sm text-text">
                {confirming === 'aceptar'
                  ? '¿Confirmás que aceptás este presupuesto? El taller va a comenzar el trabajo.'
                  : '¿Confirmás que rechazás este presupuesto?'}
              </p>

              {/* El motivo es lo único que le queda al taller para reaccionar:
                  si fue el precio puede recotizar, si fue el plazo puede
                  reordenar el trabajo. Sin eso, el presupuesto perdido no
                  enseña nada. */}
              {confirming === 'rechazar' && (
                <label className="mb-4 block">
                  <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                    ¿Por qué lo rechazás? *
                  </span>
                  <textarea
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    placeholder="Por ejemplo: el precio se fue de presupuesto, necesito el vehículo antes, ya lo resolví en otro lado…"
                    className={cn(
                      'w-full resize-y border border-line bg-panel px-3 py-2 text-sm',
                      'focus:border-accent-deep focus:outline-none',
                      reason.trim() === '' && 'field-required'
                    )}
                  />
                  <span className="mt-1 block text-[13px] text-text-soft">
                    Nos sirve para mejorar la próxima cotización.
                  </span>
                </label>
              )}

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant={confirming === 'aceptar' ? 'primary' : 'danger'}
                  onClick={() => decidir(confirming === 'aceptar')}
                  disabled={deciding || (confirming === 'rechazar' && reason.trim() === '')}
                  className="justify-center sm:flex-1"
                >
                  {deciding ? 'Enviando…' : confirming === 'aceptar' ? 'Sí, acepto' : 'Sí, rechazo'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirming(null)}
                  disabled={deciding}
                  className="justify-center sm:flex-1"
                >
                  Volver
                </Button>
              </div>
            </>
          )}
        </Panel>
      )}

      {!puedeDecidir && !result && !vencido && (
        <Panel className="flex items-center gap-2 p-4 text-sm text-text-soft">
          <CheckCircle2 size={16} />
          {quotation.alreadyConverted
            ? 'El trabajo de este presupuesto ya está en marcha.'
            : 'Este presupuesto ya fue respondido.'}
        </Panel>
      )}
    </Marco>
  );
}

/** Marco común: la misma cabecera que el portal de seguimiento. */
function Marco({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-panel-alt">
      <header
        className="fixed top-0 z-50 flex w-full items-center justify-between border-b border-ink-line bg-ink px-5"
        style={{ height: 'calc(3.5rem + var(--safe-top))', paddingTop: 'var(--safe-top)' }}
      >
        <div className="flex items-center">
          <img src={logo} alt="Luciano Diesel" className="h-8 w-auto" />
        </div>
        <span className="hidden text-[13px] font-semibold uppercase tracking-[0.12em] text-white/60 md:block">
          Presupuesto
        </span>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-grow px-5 pb-10 pt-20">{children}</main>
    </div>
  );
}
