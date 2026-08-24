import React from 'react';
import { Check, X, AlertTriangle, Truck, Settings, CheckCircle2 } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { PageHeader, Panel, Button } from '@/src/components/ui';
import { QUOTATION_STATUS_LABELS } from '@/src/lib/quotations';
import {
  decideQuotation,
  DECISION_MESSAGES,
  fetchPublicQuotation,
  fetchPublicQuotationItems,
  type DecisionResult,
  type PublicQuotation as Quotation,
  type PublicQuotationItem,
} from '@/src/lib/publicQuotation';

const IVA_RATE = 0.21;

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
  const [loading, setLoading] = React.useState(true);
  const [deciding, setDeciding] = React.useState(false);
  const [confirming, setConfirming] = React.useState<'aceptar' | 'rechazar' | null>(null);
  const [result, setResult] = React.useState<DecisionResult | null>(null);
  const [reason, setReason] = React.useState('');

  const load = React.useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const data = await fetchPublicQuotation(token);
      setQuotation(data);
      if (data) setItems(await fetchPublicQuotationItems(token));
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

  const total = items.reduce((sum, i) => sum + i.subtotal, 0);
  const iva = total * IVA_RATE;
  const vencido =
    quotation.validUntil !== null &&
    quotation.validUntil < new Date().toISOString().slice(0, 10);
  const pendiente = quotation.status === 'EMITIDA' || quotation.status === 'ENVIADA';
  const puedeDecidir = pendiente && !vencido && !quotation.alreadyConverted;

  return (
    <Marco>
      <PageHeader
        title="Presupuesto"
        subtitle={`N° ${quotation.number}${quotation.customerName ? ` · ${quotation.customerName}` : ''}`}
        actions={
          <span className="border border-line bg-panel px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-text">
            {QUOTATION_STATUS_LABELS[quotation.status]}
          </span>
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

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Vehículo / Equipo
          </span>
          <span className="flex items-center gap-2 text-sm font-semibold text-text">
            <Truck size={17} className="text-text-soft" />
            {[quotation.vehicleBrand, quotation.vehicleModel].filter(Boolean).join(' ') || '—'}
          </span>
          {quotation.licensePlate && (
            <span className="mt-2 inline-block border border-line bg-panel-alt px-2 py-0.5 font-mono text-xs font-semibold">
              {quotation.licensePlate}
            </span>
          )}
        </Panel>

        <Panel className="p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Trabajo a realizar
          </span>
          <span className="flex items-center gap-2 text-sm font-semibold text-text">
            <Settings size={17} className="text-text-soft" />
            {quotation.component ?? '—'}
          </span>
          {quotation.validUntil && (
            <span className="mt-2 block text-xs text-text-soft">
              Válido hasta{' '}
              {new Date(`${quotation.validUntil}T00:00:00`).toLocaleDateString('es-AR')}
            </span>
          )}
        </Panel>
      </div>

      <Panel className="mb-6 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="p-3 font-semibold">Detalle</th>
                <th className="w-24 p-3 text-right font-semibold">Cant.</th>
                <th className="w-32 p-3 text-right font-semibold">Precio</th>
                <th className="w-32 p-3 text-right font-semibold">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-text-soft">
                    Este presupuesto todavía no tiene detalle cargado.
                  </td>
                </tr>
              )}
              {items.map((item, idx) => (
                <tr key={idx} className="border-b border-line last:border-b-0">
                  <td data-primary className="p-3">{item.description}</td>
                  <td data-label="Cant." className="p-3 text-right">{item.quantity.toFixed(2)}</td>
                  <td data-label="Precio" className="p-3 text-right">$ {item.unitPrice.toFixed(2)}</td>
                  <td data-label="Subtotal" className="p-3 text-right font-semibold">
                    $ {item.subtotal.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="mb-6 flex justify-end">
        <div className="w-full space-y-2 border border-line bg-panel p-4 sm:w-80">
          <div className="flex justify-between text-xs text-text-soft">
            <span>Subtotal</span>
            <span className="text-text">$ {total.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-xs text-text-soft">
            <span>IVA 21%</span>
            <span className="text-text">$ {iva.toFixed(2)}</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
              Total
            </span>
            <span className="font-display text-3xl font-medium text-text">
              $ {(total + iva).toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {quotation.notes && (
        <Panel className="mb-6 p-4">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Observaciones
          </span>
          <p className="whitespace-pre-line text-sm text-text">{quotation.notes}</p>
        </Panel>
      )}

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
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
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
                  <span className="mt-1 block text-[11px] text-text-soft">
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
        <div className="flex items-baseline gap-1.5">
          <span className="font-display text-2xl font-semibold uppercase leading-none tracking-[0.02em] text-accent">
            DieselPro
          </span>
          <span className="font-display text-sm font-light uppercase leading-none tracking-[0.2em] text-white/60">
            Taller
          </span>
        </div>
        <span className="hidden text-[11px] font-semibold uppercase tracking-[0.12em] text-white/60 md:block">
          Presupuesto
        </span>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-grow px-5 pb-10 pt-20">{children}</main>
    </div>
  );
}
