import React from 'react';
import { MessageSquareText, RotateCcw, Save, Check, AlertTriangle, Pencil } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Button, Panel } from '@/src/components/ui';
import { inputClass, labelClass } from '@/src/components/FiscalFields';
import { getErrorMessage, fetchWorkOrderStatuses, type WorkOrderStatusDef } from '@/src/lib/workOrders';
import {
  aplicarPlantilla,
  fetchMensajesDeEstado,
  fetchPlantillas,
  guardarMensajeDeEstado,
  guardarPlantilla,
  olvidarPlantillas,
  PLANTILLAS,
  variablesUsadas,
  type DefinicionPlantilla,
  type Plantilla,
} from '@/src/lib/plantillasMensaje';

const sectionTitleClass =
  'flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-text-faint';

/** Valores de ejemplo para la vista previa. */
const EJEMPLO: Record<string, string> = {
  cliente: 'Juan Pérez',
  orden: 'OT-25',
  vehiculo: 'Scania 124 (AB123CD)',
  componente: 'Bomba inyectora',
  mensaje_estado: 'Su componente está listo para retirar. Lo esperamos en el taller.',
  link: 'https://.../seguimiento/…',
  presupuesto_original: '150000.00',
  nuevo_monto: '185000.00',
  numero: '0003-00000125',
  total: '185.000,00',
  vencimiento: '15/10/2026',
  fecha: '01/10/2026',
  impuesto: 'IIBB Tucumán',
  importe: '2.500,00',
  tipo: 'Factura B',
};

/**
 * Configuración de los textos de WhatsApp y mail. Cada mensaje se edita
 * aparte, con la lista de variables que acepta y una vista previa con datos
 * de ejemplo. "Texto original" lo devuelve a como venía.
 */
export function PlantillasMensajes() {
  const [plantillas, setPlantillas] = React.useState<Map<string, Plantilla> | null>(null);
  const [estados, setEstados] = React.useState<WorkOrderStatusDef[]>([]);
  const [mensajesEstado, setMensajesEstado] = React.useState<Map<string, string>>(new Map());
  const [abierta, setAbierta] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    Promise.all([fetchPlantillas(), fetchWorkOrderStatuses(true), fetchMensajesDeEstado()])
      .then(([p, e, m]) => {
        setPlantillas(p);
        setEstados(e);
        setMensajesEstado(m);
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const grupos = ['Automáticos por WhatsApp', 'Envío de comprobantes'] as const;

  return (
    <Panel className="space-y-4 p-5">
      <h3 className={sectionTitleClass}><MessageSquareText size={14} /> Textos de WhatsApp y mail</h3>
      <p className="text-xs text-text-soft">
        Las palabras entre llaves, como <code>{'{cliente}'}</code> o <code>{'{total}'}</code>, se
        reemplazan por el dato de cada envío. Si un dato no está (una orden sin vehículo, un
        presupuesto sin vencimiento), el renglón que lo usa no sale.
      </p>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {!plantillas && !error && <p className="text-sm text-text-soft">Cargando…</p>}

      {plantillas &&
        grupos.map((grupo) => (
          <div key={grupo} className="space-y-2">
            <h4 className="text-[13px] font-semibold text-text">{grupo}</h4>
            <div className="divide-y divide-line rounded-md border border-line">
              {PLANTILLAS.filter((d) => d.grupo === grupo).map((d) => {
                const p = plantillas.get(d.clave);
                if (!p) return null;
                return (
                  <EditorPlantilla
                    key={d.clave}
                    definicion={d}
                    plantilla={p}
                    abierta={abierta === d.clave}
                    onAbrir={() => setAbierta(abierta === d.clave ? null : d.clave)}
                    onGuardada={(nueva) => {
                      setPlantillas(new Map(plantillas).set(d.clave, nueva));
                      olvidarPlantillas();
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}

      {plantillas && estados.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[13px] font-semibold text-text">Texto de cada estado de la orden</h4>
          <p className="text-xs text-text-soft">
            Es lo que reemplaza a <code>{'{mensaje_estado}'}</code> en los mensajes de la orden. Se
            manda solo en los estados marcados "avisa al cliente" (se marcan en Estados de OT); en
            el resto se usa en el mensaje de alta, si la orden se carga en ese estado.
          </p>
          <div className="divide-y divide-line rounded-md border border-line">
            {estados.map((e) => (
              <MensajeDeEstado
                key={e.id}
                estado={e}
                texto={mensajesEstado.get(e.id) ?? ''}
                onGuardado={(t) => setMensajesEstado(new Map(mensajesEstado).set(e.id, t))}
              />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function EditorPlantilla({
  definicion,
  plantilla,
  abierta,
  onAbrir,
  onGuardada,
}: {
  definicion: DefinicionPlantilla;
  plantilla: Plantilla;
  abierta: boolean;
  onAbrir: () => void;
  onGuardada: (p: Plantilla) => void;
}) {
  const conAsunto = definicion.canal === 'mail';
  const [asunto, setAsunto] = React.useState(plantilla.asunto ?? '');
  const [cuerpo, setCuerpo] = React.useState(plantilla.cuerpo);
  const [guardando, setGuardando] = React.useState(false);
  const [guardado, setGuardado] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const permitidas = new Set(definicion.variables.map((v) => v.nombre));
  const desconocidas = [...new Set([...variablesUsadas(asunto), ...variablesUsadas(cuerpo)])].filter(
    (v) => !permitidas.has(v)
  );
  const cambiado = cuerpo !== plantilla.cuerpo || (conAsunto && asunto !== (plantilla.asunto ?? ''));
  const esOriginal = cuerpo === plantilla.cuerpoOriginal && (!conAsunto || asunto === (plantilla.asuntoOriginal ?? ''));

  async function guardar() {
    if (!cuerpo.trim()) {
      setError('El texto no puede quedar vacío. Para volver al de siempre, usá "Texto original".');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      const nuevoAsunto = conAsunto ? asunto : plantilla.asunto;
      await guardarPlantilla(plantilla.clave, nuevoAsunto, cuerpo);
      onGuardada({ ...plantilla, asunto: nuevoAsunto, cuerpo });
      onAbrir();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[16rem_1fr_auto] sm:items-start">
        <span>
          <span className="block text-sm font-semibold text-text">{definicion.titulo}</span>
          <span className="block text-xs text-text-soft">{definicion.descripcion}</span>
          <span className="mt-0.5 block text-[11px] text-text-faint">
            {plantilla.cuerpo === plantilla.cuerpoOriginal && (plantilla.asunto ?? '') === (plantilla.asuntoOriginal ?? '')
              ? 'Texto original'
              : 'Modificado'}
          </span>
        </span>
        {!abierta ? (
          <div className="whitespace-pre-line text-[13px] text-text">
            {conAsunto && plantilla.asunto && <p className="mb-1 font-semibold">{plantilla.asunto}</p>}
            {plantilla.cuerpo}
          </div>
        ) : (
          <span className="text-[13px] text-text-soft">Editando…</span>
        )}
        {!abierta && (
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setAsunto(plantilla.asunto ?? '');
              setCuerpo(plantilla.cuerpo);
              onAbrir();
            }}
          >
            <Pencil size={14} /> Modificar
          </Button>
        )}
      </div>

      {abierta && (
        <div className="space-y-3 border-t border-line bg-panel-alt px-4 py-4">
          {conAsunto && (
            <label className={labelClass}>
              Asunto
              <input value={asunto} onChange={(e) => setAsunto(e.target.value)} className={inputClass} />
            </label>
          )}
          <label className={labelClass}>
            {conAsunto ? 'Texto del mail' : 'Texto'}
            <textarea
              value={cuerpo}
              onChange={(e) => setCuerpo(e.target.value)}
              rows={Math.max(4, cuerpo.split('\n').length + 1)}
              className={cn(inputClass, 'font-mono text-[13px] normal-case')}
            />
          </label>

          <div className="flex flex-wrap gap-1.5">
            {definicion.variables.map((v) => (
              <button
                key={v.nombre}
                type="button"
                title={v.descripcion}
                onClick={() => setCuerpo((c) => `${c}{${v.nombre}}`)}
                className="rounded border border-line-strong bg-panel px-1.5 py-0.5 font-mono text-[12px] text-text-soft hover:border-accent-deep hover:text-text"
              >
                {`{${v.nombre}}`}
              </button>
            ))}
            <span className="self-center text-[11px] text-text-faint">Tocá una para agregarla al final.</span>
          </div>

          {desconocidas.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-state-wait">
              <AlertTriangle size={13} />
              {desconocidas.map((v) => `{${v}}`).join(', ')} no{' '}
              {desconocidas.length === 1 ? 'es una variable de este mensaje: el renglón que la use no va a salir' : 'son variables de este mensaje: los renglones que las usen no van a salir'}.
            </p>
          )}

          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
              Vista previa
            </span>
            <div className="whitespace-pre-wrap rounded-md border border-line bg-panel px-3 py-2 text-[13px] text-text">
              {conAsunto && <p className="mb-2 font-semibold">{aplicarPlantilla(asunto, EJEMPLO)}</p>}
              {aplicarPlantilla(cuerpo, EJEMPLO)}
            </div>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setCuerpo(plantilla.cuerpoOriginal);
                setAsunto(plantilla.asuntoOriginal ?? '');
              }}
              disabled={esOriginal}
            >
              <RotateCcw size={14} /> Texto original
            </Button>
            <Button variant="ghost" type="button" onClick={onAbrir} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="button" onClick={guardar} disabled={guardando || !cambiado}>
              {guardado ? <Check size={14} /> : <Save size={14} />}
              {guardando ? 'Guardando…' : guardado ? 'Guardado' : 'Guardar'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function MensajeDeEstado({
  estado,
  texto,
  onGuardado,
}: {
  estado: WorkOrderStatusDef;
  texto: string;
  onGuardado: (t: string) => void;
}) {
  const [editando, setEditando] = React.useState(false);
  const [valor, setValor] = React.useState(texto);
  const [guardando, setGuardando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      await guardarMensajeDeEstado(estado.id, valor.trim());
      onGuardado(valor.trim());
      setEditando(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[12rem_1fr_auto] sm:items-start">
      <span className="text-sm">
        <span className="font-semibold text-text">{estado.label}</span>
        {estado.notifiesClient && (
          <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-state-done">
            Avisa al cliente
          </span>
        )}
      </span>

      {editando ? (
        <textarea
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          rows={3}
          autoFocus
          placeholder="Sin texto para este estado"
          className={cn(inputClass, 'mt-0 text-[13px] normal-case')}
        />
      ) : (
        <p className={cn('whitespace-pre-line text-[13px]', texto ? 'text-text' : 'italic text-text-faint')}>
          {texto || 'Sin texto para este estado'}
        </p>
      )}

      <div className="flex flex-col items-end gap-1">
        {editando ? (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => { setValor(texto); setEditando(false); setError(null); }}
              disabled={guardando}
            >
              Cancelar
            </Button>
            <Button type="button" onClick={guardar} disabled={guardando || valor.trim() === texto.trim()}>
              <Save size={14} /> {guardando ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" type="button" onClick={() => { setValor(texto); setEditando(true); }}>
            <Pencil size={14} /> Modificar
          </Button>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}
