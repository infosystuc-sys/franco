import React from 'react';
import {
  CheckCircle2,
  Wrench,
  Settings,
  Truck,
  ClipboardCheck,
  CheckCircle,
  Mail,
  Info,
  ArrowLeft,
  AlertTriangle,
  Check,
  X,
} from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader } from '@/src/components/ui';
import {
  decidePriceAuthorization,
  fetchPublicStatusHistory,
  fetchPublicWorkOrder,
  fetchWorkOrderStatuses,
  getErrorMessage,
  PRICE_AUTH_DECISION_MESSAGES,
  type PriceAuthDecisionResult,
  type PublicWorkOrder,
  type WorkOrderStatusDef,
} from '@/src/lib/workOrders';

/**
 * Portal público de seguimiento. Se entra con el token aleatorio de la orden,
 * no con su número: los números son correlativos y se podrían enumerar para
 * espiar las órdenes de otros clientes.
 *
 * No consulta las tablas: llama a una función de la base que devuelve
 * únicamente los datos de esa orden que el cliente puede ver.
 */
export function ClientPortal() {
  const { session } = useAuth();
  const { id: token } = useParams();
  const [order, setOrder] = React.useState<PublicWorkOrder | null>(null);
  const [statuses, setStatuses] = React.useState<WorkOrderStatusDef[]>([]);
  const [history, setHistory] = React.useState<{ toStatusId: string; changedAt: string }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [priceDeciding, setPriceDeciding] = React.useState(false);
  const [priceConfirming, setPriceConfirming] = React.useState<'autorizar' | 'rechazar' | null>(null);
  const [priceResult, setPriceResult] = React.useState<PriceAuthDecisionResult | null>(null);
  const [priceReason, setPriceReason] = React.useState('');

  const load = React.useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [data, statusDefs] = await Promise.all([fetchPublicWorkOrder(token), fetchWorkOrderStatuses(true)]);
      setOrder(data);
      setStatuses(statusDefs);
      if (data) setHistory(await fetchPublicStatusHistory(token));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  React.useEffect(() => { load(); }, [load]);

  async function decidirPrecio(accept: boolean) {
    if (!token) return;
    setPriceDeciding(true);
    try {
      const r = await decidePriceAuthorization(token, accept, priceReason);
      if (r !== 'FALTA_MOTIVO') setPriceConfirming(null);
      setPriceResult(r === 'FALTA_MOTIVO' ? null : r);
      if (r !== 'FALTA_MOTIVO') await load();
    } finally {
      setPriceDeciding(false);
    }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-text-soft">Cargando…</div>;
  }

  if (error || !order) {
    return (
      <div className="min-h-screen flex flex-col gap-3 items-center justify-center px-6 text-center text-text-soft">
        <span className="font-display text-2xl uppercase tracking-[0.04em] text-text-faint">
          Link no válido
        </span>
        <span className="max-w-sm text-sm">
          Este link de seguimiento no corresponde a ninguna orden. Puede estar
          incompleto: verificá que lo hayas copiado entero.
        </span>
        {session && (
          <Link to="/" className="mt-2 inline-flex items-center gap-1.5 text-sm font-bold text-accent-deep hover:underline">
            <ArrowLeft size={15} /> Volver al panel
          </Link>
        )}
      </div>
    );
  }

  const statusIndex = statuses.findIndex((s) => s.id === order.statusId);
  const currentStatus = statuses.find((s) => s.id === order.statusId);

  // Fecha en que la orden alcanzó cada estado, según el historial real.
  const reachedAt: Record<string, string> = {};
  history.forEach((change) => {
    reachedAt[change.toStatusId] = change.changedAt;
  });

  return (
    <div className="min-h-screen bg-panel-alt flex flex-col font-sans">
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
        <div className="flex items-center gap-4">
          <span className="hidden text-[11px] font-semibold uppercase tracking-[0.12em] text-white/60 md:block">
            Seguimiento de su reparación
          </span>
          {/*
            Esta pantalla es pública: la ve el cliente sin iniciar sesión.
            El acceso al panel solo aparece si hay sesión, es decir cuando la
            está mirando alguien del taller desde "Ver como cliente".
          */}
          {session && (
            <Link
              to="/"
              className="text-accent text-[11px] font-bold uppercase tracking-wider hover:underline inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <ArrowLeft size={14} /> Volver al panel
            </Link>
          )}
        </div>
      </header>

      <main className="flex-grow pt-20 pb-10 px-5 max-w-5xl mx-auto w-full space-y-6">
        <PageHeader
          title="Estado de su reparación"
          subtitle={`Orden ${order.number} · seguimiento en tiempo real`}
          actions={
            <div className="flex items-center gap-2 border border-line bg-panel px-4 py-2">
              <Info size={17} className="text-accent-deep" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text">
                {currentStatus?.label ?? '—'}
              </span>
            </div>
          }
        />

        {(order.priceAuthStatus === 'PENDIENTE' || priceResult) && (
          <div className="bg-panel p-5 border border-state-wait space-y-4">
            {priceResult ? (
              <div
                className={cn(
                  'border px-4 py-3 text-sm',
                  priceResult === 'AUTORIZADO'
                    ? 'border-state-done/40 bg-panel-alt text-state-done'
                    : 'border-line bg-panel-alt text-text-soft'
                )}
              >
                {PRICE_AUTH_DECISION_MESSAGES[priceResult]}
              </div>
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0 text-state-wait" />
                  <div>
                    <p className="text-sm font-bold text-text">El costo cambió respecto al presupuesto original</p>
                    <p className="mt-1 text-sm text-text-soft">
                      Nuevo monto: <span className="font-semibold text-text">
                        {order.priceAuthRequestedTotal !== null ? formatMoney(order.priceAuthRequestedTotal) : '—'}
                      </span>. Necesitamos su autorización para poder continuar.
                    </p>
                  </div>
                </div>

                {priceConfirming === null ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button onClick={() => setPriceConfirming('autorizar')} className="justify-center sm:flex-1">
                      <Check size={16} /> Autorizar
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setPriceConfirming('rechazar')}
                      className="justify-center sm:flex-1"
                    >
                      <X size={16} /> No autorizar
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-text">
                      {priceConfirming === 'autorizar'
                        ? '¿Confirmás que autorizás el nuevo monto? El taller va a continuar con el trabajo.'
                        : '¿Confirmás que no autorizás el nuevo monto?'}
                    </p>
                    {priceConfirming === 'rechazar' && (
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                          ¿Por qué no autoriza? *
                        </span>
                        <textarea
                          autoFocus
                          value={priceReason}
                          onChange={(e) => setPriceReason(e.target.value)}
                          rows={3}
                          placeholder="Por ejemplo: el nuevo monto excede lo que puedo pagar, quiero que me expliquen el motivo del cambio…"
                          className={cn(
                            'w-full resize-y border border-line bg-panel px-3 py-2 text-sm',
                            'focus:border-accent-deep focus:outline-none',
                            priceReason.trim() === '' && 'field-required'
                          )}
                        />
                      </label>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Button
                        onClick={() => decidirPrecio(priceConfirming === 'autorizar')}
                        disabled={priceDeciding}
                        className="justify-center sm:flex-1"
                      >
                        {priceDeciding ? 'Enviando…' : 'Confirmar'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setPriceConfirming(null)}
                        disabled={priceDeciding}
                        className="justify-center sm:flex-1"
                      >
                        Volver
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          <div className="md:col-span-4 space-y-6">
            <div className="bg-panel p-5 border border-line space-y-4">
              <div className="flex justify-between items-center border-b border-line pb-2 mb-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-soft">Orden de Trabajo</span>
                <span className="text-base font-bold text-text">#{order.number}</span>
              </div>

              <div className="space-y-4">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-text-soft block mb-1">Vehículo</span>
                  <div className="flex items-center gap-2">
                    <Truck size={18} className="text-text-soft" />
                    <span className="text-sm font-bold text-text">
                      {[order.vehicleBrand, order.vehicleModel].filter(Boolean).join(' ') || '—'}
                    </span>
                  </div>
                </div>
                {order.licensePlate && (
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-text-soft block mb-1">Matrícula</span>
                    <div className="bg-panel-head inline-block px-3 py-1 border border-line font-mono font-bold text-text">
                      {order.licensePlate}
                    </div>
                  </div>
                )}
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-text-soft block mb-1">Componente</span>
                  <div className="flex items-center gap-2">
                    <Settings size={18} className="text-text-soft" />
                    <span className="text-sm text-text">{order.component ?? '—'}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-panel p-5 border border-line space-y-4">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-soft border-b border-line pb-2 mb-2">Contacto de Taller</h3>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 bg-panel-head flex items-center justify-center border border-line">
                  <CheckCircle2 size={24} className="text-text-soft fill-current" />
                </div>
                <div>
                  <p className="text-sm font-bold text-text">Técnico Asignado</p>
                  <p className="text-xs text-text-soft">{order.employeeName ?? 'Sin asignar'}</p>
                </div>
              </div>
              <button className="w-full bg-panel-head hover:bg-panel-head text-text text-[11px] font-bold uppercase tracking-wider py-2 border border-line transition-colors flex items-center justify-center gap-2 mt-2">
                <Mail size={16} />
                Contactar Taller
              </button>
            </div>
          </div>

          <div className="md:col-span-8 bg-panel p-6 border border-line">
            <h2 className="text-base font-bold text-text mb-8 pb-2 border-b-2 border-accent inline-block">Progreso del Servicio</h2>
            <div className="flex flex-col relative pl-2">
              {statuses.map((status, idx) => {
                const state = idx < statusIndex ? 'completed' : idx === statusIndex ? 'active' : 'pending';
                return (
                  <div key={status.id} className="flex gap-6 relative mb-10 last:mb-0">
                    {idx < statuses.length - 1 && (
                      <div className="absolute top-[40px] left-[20px] bottom-[-40px] w-0.5 bg-line z-0"></div>
                    )}

                    <div className="relative z-10 flex-shrink-0">
                      <div className={cn(
                        "w-10 h-10 bg-panel border-2 flex items-center justify-center",
                        state === 'completed' ? "border-accent-deep" :
                        state === 'active' ? "border-accent-deep bg-accent animate-pulse" :
                        "border-line"
                      )}>
                        {state === 'completed' ? (
                          <CheckCircle size={24} className="text-accent-deep fill-current" />
                        ) : state === 'active' ? (
                          <Wrench size={20} className="text-accent-ink fill-current" />
                        ) : (
                          <ClipboardCheck size={20} className="text-line-strong" />
                        )}
                      </div>
                    </div>

                    <div className={cn(
                      "pt-1 flex-1",
                      state === 'active' && "bg-panel-alt p-4 border-l-4 border-accent -mt-1"
                    )}>
                      <div className="flex justify-between items-start mb-1">
                        <h3 className="text-sm font-bold text-text">{status.label}</h3>
                        {state === 'active' && (
                          <span className="bg-accent text-accent-ink text-[9px] font-bold uppercase tracking-wider px-2 py-0.5">ACTUAL</span>
                        )}
                      </div>
                      <p className="text-xs text-text-soft mt-1 leading-relaxed">{status.clientDescription}</p>
                      {reachedAt[status.id] && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-text-soft block mt-3">
                          {new Date(reachedAt[status.id]!).toLocaleString('es-AR', {
                            day: '2-digit', month: 'short', year: 'numeric',
                            hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>

      <footer className="w-full py-4 bg-panel border-t border-line flex flex-col md:flex-row justify-between items-center px-5 mt-auto gap-4">
        <div className="text-xs text-text-soft">
          © 2024 DieselPro ERP - Sistema de Gestión de Taller
        </div>
        <div className="flex gap-6">
          <a className="text-xs text-text-soft hover:text-accent-deep transition-colors cursor-pointer">Soporte Técnico</a>
          <a className="text-xs text-text-soft hover:text-accent-deep transition-colors cursor-pointer">Documentación</a>
          <a className="text-xs text-text-soft hover:text-accent-deep transition-colors cursor-pointer">Términos</a>
        </div>
      </footer>
    </div>
  );
}
