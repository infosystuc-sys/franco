import React from 'react';
import { RefreshCw, AlertTriangle, MessageSquare, Power, FlaskConical } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { Button, Label, PageHeader, Panel, SectionHeader, StateStrip, fieldClass } from '@/src/components/ui';
import {
  fetchNotifications,
  fetchWhatsappSettings,
  KIND_LABELS,
  STATUS_LABELS,
  STATUS_STRIP,
  updateSetting,
  type NotificationRow,
  type NotificationStatus,
  type WhatsappSettings,
} from '@/src/lib/notifications';

/**
 * Cola de mensajes de WhatsApp: qué se mandó, qué está esperando y qué falló.
 * Sin esta pantalla, un servidor de Evolution caído se nota recién cuando un
 * cliente se queja de que nunca le avisaron.
 */
export function Notifications() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [rows, setRows] = React.useState<NotificationRow[]>([]);
  const [settings, setSettings] = React.useState<WhatsappSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<NotificationStatus | ''>('');
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [notif, conf] = await Promise.all([fetchNotifications(), fetchWhatsappSettings()]);
      setRows(notif);
      setSettings(conf);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const counts = React.useMemo(() => {
    const base = { PENDIENTE: 0, ENVIADO: 0, FALLIDO: 0, DESCARTADO: 0 } as Record<NotificationStatus, number>;
    rows.forEach((r) => { base[r.status] += 1; });
    return base;
  }, [rows]);

  const filtered = filter ? rows.filter((r) => r.status === filter) : rows;

  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Mensajes"
        subtitle="Cola de avisos por WhatsApp: qué salió, qué espera y qué falló."
        actions={
          <Button variant="ghost" onClick={load} disabled={loading}>
            <RefreshCw size={16} /> Actualizar
          </Button>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {settings && <EstadoDelEnvio settings={settings} onChanged={load} />}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {(Object.keys(STATUS_LABELS) as NotificationStatus[]).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(filter === s ? '' : s)}
            className={cn(
              'relative border bg-panel p-4 pl-5 text-left transition-colors',
              filter === s ? 'border-accent-deep ring-1 ring-accent-deep' : 'border-line hover:border-line-strong'
            )}
          >
            <StateStrip color={STATUS_STRIP[s]} />
            <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              {STATUS_LABELS[s]}
            </span>
            <span className="font-display text-3xl font-medium leading-none text-text">
              {loading ? '—' : counts[s]}
            </span>
          </button>
        ))}
      </div>

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="w-40 p-3 font-semibold">Fecha</th>
                <th className="w-36 p-3 font-semibold">Tipo</th>
                <th className="p-3 font-semibold">Destinatario</th>
                <th className="w-28 p-3 font-semibold">Referencia</th>
                <th className="w-28 p-3 font-semibold">Estado</th>
                <th className="w-20 p-3 text-right font-semibold">Intentos</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="p-8 text-center text-text-soft">Cargando…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-text-soft">
                    {filter ? 'No hay mensajes en ese estado.' : 'Todavía no se encoló ningún mensaje.'}
                  </td>
                </tr>
              )}
              {filtered.map((row) => (
                <React.Fragment key={row.id}>
                  <tr
                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                    className="relative cursor-pointer border-b border-line transition-colors hover:bg-panel-alt"
                  >
                    <td data-primary className="relative py-3 pl-5 pr-3 font-mono text-xs">
                      <StateStrip color={STATUS_STRIP[row.status]} />
                      {new Date(row.createdAt).toLocaleString('es-AR')}
                    </td>
                    <td data-label="Tipo" className="p-3">{KIND_LABELS[row.kind]}</td>
                    <td data-label="Destinatario" className="p-3">
                      <span className="block">{row.customerName ?? '—'}</span>
                      <span className="block font-mono text-[11px] text-text-soft">
                        {row.toPhone ?? 'sin teléfono'}
                      </span>
                    </td>
                    <td data-label="Referencia" className="p-3 font-mono text-xs">
                      {row.workOrderNumber ?? row.quotationNumber ?? '—'}
                    </td>
                    <td data-label="Estado" className="p-3">
                      <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                        <span
                          aria-hidden
                          className="inline-block h-2 w-2"
                          style={{ backgroundColor: STATUS_STRIP[row.status] }}
                        />
                        {STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td data-label="Intentos" className="p-3 text-right">{row.attempts}</td>
                  </tr>

                  {expanded === row.id && (
                    <tr className="border-b border-line bg-panel-alt">
                      <td colSpan={6} className="p-4">
                        {row.lastError && (
                          <p className="mb-3 flex items-start gap-2 text-xs text-danger">
                            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                            {row.lastError}
                          </p>
                        )}
                        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                          Mensaje
                        </span>
                        <pre className="whitespace-pre-wrap border border-line bg-panel p-3 font-sans text-xs text-text">
{row.body}
                        </pre>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="mt-3 text-[11px] text-text-soft">
        Tocá una fila para ver el mensaje completo y el error, si lo hubo.
      </p>
    </div>
  );
}

/**
 * Los dos interruptores que deciden si sale algo, y a quién.
 * Están arriba de todo a propósito: es lo primero que hay que mirar cuando
 * un mensaje no llegó.
 */
function EstadoDelEnvio({
  settings,
  onChanged,
}: {
  settings: WhatsappSettings;
  onChanged: () => void;
}) {
  const [phone, setPhone] = React.useState(settings.testPhone);
  const [baseUrl, setBaseUrl] = React.useState(settings.publicBaseUrl);
  const [busy, setBusy] = React.useState(false);

  async function guardar(key: string, value: string) {
    setBusy(true);
    try {
      await updateSetting(key, value);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const apagado = !settings.enabled;

  return (
    <Panel className="mb-6 p-5">
      <SectionHeader title="Estado del envío" />

      <div
        className={cn(
          'mb-4 flex items-start gap-2 border px-4 py-3 text-sm',
          apagado
            ? 'border-line bg-panel-alt text-text-soft'
            : settings.testMode
              ? 'border-state-wait bg-panel-alt text-state-wait'
              : 'border-state-done/40 bg-panel-alt text-state-done'
        )}
      >
        {apagado ? <Power size={16} className="mt-0.5" /> : settings.testMode ? <FlaskConical size={16} className="mt-0.5" /> : <MessageSquare size={16} className="mt-0.5" />}
        <span>
          {apagado
            ? 'El envío está apagado. Los mensajes se encolan pero no salen.'
            : settings.testMode
              ? `Modo prueba: todo se manda a ${settings.testPhone || '(falta cargar el número)'}, nunca al cliente.`
              : 'Envío activo. Los mensajes salen a los clientes.'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Label>
          Número de prueba
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => phone !== settings.testPhone && guardar('whatsapp_test_phone', phone)}
            placeholder="5491155550001"
            className={fieldClass(false, 'font-mono normal-case')}
          />
          <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
            Solo dígitos, con 54 y el 9 de celular.
          </span>
        </Label>

        <Label>
          Dirección pública de la app
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => baseUrl !== settings.publicBaseUrl && guardar('public_base_url', baseUrl)}
            placeholder="https://tu-app.vercel.app"
            className={fieldClass(false, 'font-mono normal-case')}
          />
          <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
            Con la que se arman los links. Si apunta a localhost, el cliente no puede abrirlos.
          </span>
        </Label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant={settings.enabled ? 'ghost' : 'primary'}
          disabled={busy}
          onClick={() => guardar('whatsapp_enabled', settings.enabled ? 'false' : 'true')}
        >
          <Power size={16} /> {settings.enabled ? 'Apagar el envío' : 'Activar el envío'}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => guardar('whatsapp_test_mode', settings.testMode ? 'false' : 'true')}
        >
          <FlaskConical size={16} />
          {settings.testMode ? 'Salir del modo prueba' : 'Volver al modo prueba'}
        </Button>
      </div>
    </Panel>
  );
}
