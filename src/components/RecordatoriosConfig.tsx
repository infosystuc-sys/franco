import React from 'react';
import { AlertTriangle, BellRing, Check, Save, Send } from 'lucide-react';
import { Button, Panel } from '@/src/components/ui';
import { inputClass, labelClass, sectionTitleClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  enviarRecordatoriosAhora,
  fetchConfigRecordatorios,
  guardarConfigRecordatorios,
  type ConfigRecordatorios,
} from '@/src/lib/recordatorios';

/**
 * Los recordatorios que salen solos por WhatsApp, una vez por día de lunes a
 * sábado a las 10: presupuestos sin respuesta, trabajos terminados sin retirar
 * y saldos vencidos. Los textos se editan abajo, en "Textos de WhatsApp y mail".
 */
export function RecordatoriosConfig() {
  const [config, setConfig] = React.useState<ConfigRecordatorios | null>(null);
  const [sinMigracion, setSinMigracion] = React.useState(false);
  const [ocupado, setOcupado] = React.useState<'guardar' | 'enviar' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetchConfigRecordatorios()
      .then((c) => {
        if (c) setConfig(c);
        else setSinMigracion(true);
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  function cambiar<K extends keyof ConfigRecordatorios>(clave: K, cambios: Partial<ConfigRecordatorios[K]>) {
    setConfig((c) => (c ? { ...c, [clave]: { ...c[clave], ...cambios } } : c));
    setAviso(null);
  }

  async function guardar() {
    if (!config) return;
    setOcupado('guardar');
    setError(null);
    setAviso(null);
    try {
      await guardarConfigRecordatorios(config);
      setAviso('Guardado. Los recordatorios salen de lunes a sábado a las 10.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setOcupado(null);
    }
  }

  async function enviarAhora() {
    if (!config) return;
    if (!window.confirm('¿Mandar ahora los recordatorios que correspondan? Se usa la configuración guardada.')) return;
    setOcupado('enviar');
    setError(null);
    setAviso(null);
    try {
      const r = await enviarRecordatoriosAhora();
      const total = r.cotizaciones + r.terminados + r.saldos;
      setAviso(
        total === 0
          ? 'No había ningún recordatorio para mandar hoy.'
          : `Se encolaron ${total}: ${r.cotizaciones} de presupuestos, ${r.terminados} de trabajos terminados y ${r.saldos} de saldos. Se ven en Mensajes.`
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setOcupado(null);
    }
  }

  const numero = (valor: number, onChange: (n: number) => void, min = 1) => (
    <input
      type="number"
      min={min}
      value={valor}
      onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
      className={`${inputClass} w-20`}
    />
  );

  return (
    <Panel className="space-y-4 p-5">
      <h3 className={sectionTitleClass}><BellRing size={14} /> Recordatorios automáticos por WhatsApp</h3>
      <p className="text-xs text-text-soft">
        Se mandan solos de lunes a sábado a las 10, a los clientes con teléfono cargado. Cada uno se cuenta desde el
        último mensaje que recibió por eso mismo: si le reenviaste el presupuesto a mano ayer, el recordatorio espera.
        Los textos se cambian abajo, en <b>Textos de WhatsApp y mail → Recordatorios automáticos</b>.
      </p>

      {error && <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}
      {sinMigracion && (
        <div className="flex items-center gap-2 border border-line bg-panel-alt px-3 py-2 text-xs text-text-soft">
          <AlertTriangle size={14} /> Falta correr la migración 20261113_recordatorios_automaticos.sql en Supabase.
        </div>
      )}

      {config && (
        <div className="divide-y divide-line border border-line">
          <Fila
            titulo="Presupuestos sin respuesta"
            detalle="Presupuestos enviados por WhatsApp, sin vencer, que el cliente no aceptó ni rechazó."
            activo={config.cotizaciones.activo}
            onActivo={(activo) => cambiar('cotizaciones', { activo })}
          >
            <label className={labelClass}>Cada (días){numero(config.cotizaciones.cada, (cada) => cambiar('cotizaciones', { cada }))}</label>
            <label className={labelClass}>Hasta (veces){numero(config.cotizaciones.maximo, (maximo) => cambiar('cotizaciones', { maximo }))}</label>
          </Fila>
          <Fila
            titulo="Trabajos terminados sin retirar"
            detalle="Órdenes que siguen en el estado Terminado."
            activo={config.terminados.activo}
            onActivo={(activo) => cambiar('terminados', { activo })}
          >
            <label className={labelClass}>Cada (días){numero(config.terminados.cada, (cada) => cambiar('terminados', { cada }))}</label>
            <label className={labelClass}>Hasta (veces){numero(config.terminados.maximo, (maximo) => cambiar('terminados', { maximo }))}</label>
          </Fila>
          <Fila
            titulo="Saldos vencidos en cuenta corriente"
            detalle="Clientes que deben y tienen alguna factura vencida. Se repite mientras sigan debiendo."
            activo={config.saldos.activo}
            onActivo={(activo) => cambiar('saldos', { activo })}
          >
            <label className={labelClass}>Cada (días){numero(config.saldos.cada, (cada) => cambiar('saldos', { cada }))}</label>
            <label className={labelClass}>
              Saldo mínimo ($)
              <input
                type="number"
                min={0}
                value={config.saldos.minimo}
                onChange={(e) => cambiar('saldos', { minimo: Math.max(0, Number(e.target.value) || 0) })}
                className={`${inputClass} w-28`}
              />
            </label>
          </Fila>
        </div>
      )}

      {aviso && (
        <p className="flex items-center gap-1.5 text-xs text-state-done"><Check size={14} /> {aviso}</p>
      )}

      {config && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={guardar} disabled={ocupado !== null}>
            <Save size={16} /> {ocupado === 'guardar' ? 'Guardando…' : 'Guardar'}
          </Button>
          <Button type="button" variant="secondary" onClick={enviarAhora} disabled={ocupado !== null}>
            <Send size={16} /> {ocupado === 'enviar' ? 'Enviando…' : 'Enviar ahora'}
          </Button>
        </div>
      )}
    </Panel>
  );
}

function Fila({
  titulo,
  detalle,
  activo,
  onActivo,
  children,
}: {
  titulo: string;
  detalle: string;
  activo: boolean;
  onActivo: (activo: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 p-3">
      <label className="flex min-w-[16rem] flex-1 items-start gap-2">
        <input
          type="checkbox"
          checked={activo}
          onChange={(e) => onActivo(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-accent-deep"
        />
        <span>
          <span className="block text-sm font-semibold text-text">{titulo}</span>
          <span className="block text-xs text-text-soft">{detalle}</span>
        </span>
      </label>
      <div className={`flex gap-3 ${activo ? '' : 'opacity-50'}`}>{children}</div>
    </div>
  );
}
