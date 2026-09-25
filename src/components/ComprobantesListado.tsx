import React from 'react';
import { ChevronDown, LayoutGrid, List, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { guardarEtiquetas, type TipoComprobante } from '@/src/lib/comprobantes';

/**
 * El listado de comprobantes emitidos, con la forma del de Tango: título
 * arriba a la izquierda, la botonera a la derecha (Nuevo en amarillo, el
 * resto en gris, y "Más acciones" desplegable), una fila elegida sobre la que
 * actúan los botones, y "Ver más" al pie.
 *
 * Lo comparten todas las pantallas de comprobantes —facturas, notas de
 * crédito, recibos, cotizaciones, remitos, órdenes de trabajo, compras y
 * pagos—: cada una dice qué columnas y qué acciones tiene, y este componente
 * pone el resto. Así todas se manejan igual.
 */

export interface ColumnaListado<T> {
  label: string;
  valor: (fila: T) => React.ReactNode;
  derecha?: boolean;
  /** Clases del ancho de la columna (Tailwind). */
  ancho?: string;
}

export interface AccionListado<T> {
  label: string;
  onClick: (fila: T | null) => void;
  /** Se puede usar sin haber elegido un comprobante (Nuevo cliente…). */
  sinSeleccion?: boolean;
  /** Por qué no se puede sobre esta fila. Null si se puede. */
  bloqueo?: (fila: T) => string | null;
}

/** Marca, dentro de "Más acciones", dónde va "Etiquetar". */
export const ETIQUETAR = 'ETIQUETAR' as const;

type ItemMasAcciones<T> = AccionListado<T> | typeof ETIQUETAR;

const PAGINA = 20;

const botonBase =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-[3px] px-4 text-[15px] text-white ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const botonGris = 'bg-[#b3b3b3] hover:bg-[#9e9e9e]';
const botonAmarillo = 'bg-accent hover:bg-accent-hover';

export function ComprobantesListado<T>({
  titulo,
  tipo,
  filas,
  loading,
  error,
  getId,
  columnas,
  nuevo,
  onAbrir,
  botones,
  masAcciones,
  etiquetasDe,
  onEtiquetasGuardadas,
  ocultarListado,
  vacio = 'Todavía no hay comprobantes emitidos.',
  aviso,
  onCerrarAviso,
}: {
  titulo: string;
  tipo: TipoComprobante;
  filas: T[];
  loading: boolean;
  error: string | null;
  getId: (fila: T) => string;
  columnas: ColumnaListado<T>[];
  /** A dónde lleva el botón Nuevo. Sin él, no hay botón (quien no puede dar de alta). */
  nuevo?: { to: string; title?: string };
  /** Doble click o Enter sobre una fila. */
  onAbrir: (fila: T) => void;
  /** Los botones grises, en orden (Ver, Imprimir…). */
  botones: AccionListado<T>[];
  masAcciones: ItemMasAcciones<T>[];
  etiquetasDe: (fila: T) => string[];
  /** Para que la pantalla actualice la fila sin volver a leer todo. */
  onEtiquetasGuardadas: (id: string, etiquetas: string[]) => void;
  /** El permiso "sin historial": se ve la botonera pero no los comprobantes. */
  ocultarListado?: boolean;
  vacio?: string;
  /** Un resultado para contar (no un error): "Se eliminó la orden…". */
  aviso?: string | null;
  onCerrarAviso?: () => void;
}) {
  const navigate = useNavigate();
  const [cantidad, setCantidad] = React.useState(PAGINA);
  const [elegidoId, setElegidoId] = React.useState<string | null>(null);
  const [menuAbierto, setMenuAbierto] = React.useState(false);
  const [etiquetando, setEtiquetando] = React.useState<T | null>(null);
  const [vista, setVista] = React.useState<'lista' | 'tarjetas'>(() => {
    try {
      return localStorage.getItem(`listado-vista:${tipo}`) === 'tarjetas' ? 'tarjetas' : 'lista';
    } catch {
      return 'lista';
    }
  });
  const menuRef = React.useRef<HTMLDivElement>(null);

  const visibles = filas.slice(0, cantidad);

  // Siempre hay una fila elegida, como en Tango: la primera, hasta que se
  // toque otra. Si la elegida deja de estar (se recargó el listado), vuelve
  // a la primera.
  React.useEffect(() => {
    if (visibles.length === 0) {
      if (elegidoId !== null) setElegidoId(null);
      return;
    }
    if (!elegidoId || !visibles.some((f) => getId(f) === elegidoId)) {
      setElegidoId(getId(visibles[0]));
    }
  }, [visibles, elegidoId, getId]);

  // "Más acciones" se cierra al hacer click afuera.
  React.useEffect(() => {
    if (!menuAbierto) return;
    function cerrar(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuAbierto(false);
    }
    document.addEventListener('mousedown', cerrar);
    return () => document.removeEventListener('mousedown', cerrar);
  }, [menuAbierto]);

  const elegida = ocultarListado ? null : filas.find((f) => getId(f) === elegidoId) ?? null;

  function cambiarVista(nueva: 'lista' | 'tarjetas') {
    setVista(nueva);
    try {
      localStorage.setItem(`listado-vista:${tipo}`, nueva);
    } catch {
      // Sin almacenamiento: la vista vale solo mientras dure la pantalla.
    }
  }

  function motivoBloqueo(accion: AccionListado<T>): string | null {
    // Una acción sin selección igual puede estar vedada (por el rol, no por la
    // fila): el bloqueo se consulta con lo que haya elegido, que puede no ser nada.
    if (accion.sinSeleccion) return accion.bloqueo?.(elegida as T) ?? null;
    if (!elegida) return 'Elegí un comprobante del listado.';
    return accion.bloqueo?.(elegida) ?? null;
  }

  function ejecutar(accion: AccionListado<T>) {
    if (motivoBloqueo(accion)) return;
    setMenuAbierto(false);
    accion.onClick(elegida);
  }

  function moverSeleccion(delta: number) {
    const i = visibles.findIndex((f) => getId(f) === elegidoId);
    const j = Math.min(Math.max(i + delta, 0), visibles.length - 1);
    if (visibles[j]) setElegidoId(getId(visibles[j]));
  }

  return (
    <div className="w-full">
      {/* ── Encabezado y botonera ───────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b-2 border-accent pb-3">
        <h1 className="text-[26px] font-light uppercase tracking-wide text-text-faint">{titulo}</h1>

        <div className="flex flex-wrap items-center gap-2">
          {nuevo && (
            <button
              type="button"
              onClick={() => navigate(nuevo.to)}
              title={nuevo.title}
              className={cn(botonBase, botonAmarillo)}
            >
              Nuevo
            </button>
          )}

          {botones.map((accion) => {
            const bloqueo = motivoBloqueo(accion);
            return (
              <button
                key={accion.label}
                type="button"
                onClick={() => ejecutar(accion)}
                disabled={!!bloqueo}
                title={bloqueo ?? undefined}
                className={cn(botonBase, botonGris)}
              >
                {accion.label}
              </button>
            );
          })}

          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuAbierto((v) => !v)}
              aria-expanded={menuAbierto}
              className={cn(botonBase, botonGris)}
            >
              Más acciones <ChevronDown size={16} />
            </button>

            {menuAbierto && (
              <div className="absolute right-0 top-full z-30 mt-1 min-w-[18rem] rounded-b-md bg-[#8c8c8c] py-2 shadow-lg">
                {masAcciones.map((item) => {
                  const accion: AccionListado<T> =
                    item === ETIQUETAR
                      ? { label: 'Etiquetar', onClick: (fila) => fila && setEtiquetando(fila) }
                      : item;
                  const bloqueo = motivoBloqueo(accion);
                  return (
                    <button
                      key={accion.label}
                      type="button"
                      onClick={() => ejecutar(accion)}
                      disabled={!!bloqueo}
                      title={bloqueo ?? undefined}
                      className="block w-full px-6 py-1 text-left text-[16px] text-white transition-colors hover:bg-[#7a7a7a] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      {accion.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex">
            <button
              type="button"
              onClick={() => cambiarVista('lista')}
              aria-label="Ver como lista"
              aria-pressed={vista === 'lista'}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-l-[3px] text-white transition-colors',
                vista === 'lista' ? botonAmarillo : botonGris
              )}
            >
              <List size={20} />
            </button>
            <button
              type="button"
              onClick={() => cambiarVista('tarjetas')}
              aria-label="Ver como tarjetas"
              aria-pressed={vista === 'tarjetas'}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-r-[3px] text-white transition-colors',
                vista === 'tarjetas' ? botonAmarillo : botonGris
              )}
            >
              <LayoutGrid size={18} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {aviso && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-line-strong bg-panel-alt px-4 py-3 text-sm text-text">
          <span>{aviso}</span>
          {onCerrarAviso && (
            <button type="button" onClick={onCerrarAviso} aria-label="Cerrar aviso" className="shrink-0 text-text-soft hover:text-text">
              <X size={16} />
            </button>
          )}
        </div>
      )}

      {ocultarListado ? (
        <p className="py-10 text-center text-text-soft">
          Tu usuario no tiene habilitado ver el historial de comprobantes.
        </p>
      ) : loading ? (
        <p className="py-10 text-center text-text-soft">Cargando…</p>
      ) : filas.length === 0 ? (
        <p className="py-10 text-center text-text-soft">{vacio}</p>
      ) : (
        <>
          {vista === 'lista' ? (
            <div
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); moverSeleccion(1); }
                if (e.key === 'ArrowUp') { e.preventDefault(); moverSeleccion(-1); }
                if (e.key === 'Enter' && elegida) onAbrir(elegida);
              }}
              className="overflow-x-auto focus:outline-none"
            >
              <table className="w-full min-w-[900px] text-left text-[16px]">
                <thead>
                  <tr className="text-[17px] font-semibold text-text">
                    {columnas.map((c) => (
                      <th
                        key={c.label}
                        className={cn('whitespace-nowrap px-2 py-2', c.derecha && 'text-right', c.ancho)}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((fila) => {
                    const id = getId(fila);
                    const seleccionada = id === elegidoId;
                    return (
                      <tr
                        key={id}
                        onClick={() => setElegidoId(id)}
                        onDoubleClick={() => onAbrir(fila)}
                        className={cn(
                          'cursor-pointer select-none',
                          seleccionada ? 'bg-[#b3b3b3] text-white' : 'text-text-soft hover:bg-[#e3e3e3]'
                        )}
                      >
                        {columnas.map((c, i) => (
                          <td
                            key={c.label}
                            className={cn('whitespace-nowrap px-2 py-1.5', c.derecha && 'text-right')}
                          >
                            {c.valor(fila)}
                            {i === 0 && <Etiquetas etiquetas={etiquetasDe(fila)} />}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visibles.map((fila) => {
                const id = getId(fila);
                const seleccionada = id === elegidoId;
                const [principal, ...resto] = columnas;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setElegidoId(id)}
                    onDoubleClick={() => onAbrir(fila)}
                    className={cn(
                      'rounded-[3px] border-l-4 p-4 text-left transition-colors',
                      seleccionada
                        ? 'border-accent bg-[#b3b3b3] text-white'
                        : 'border-[#b3b3b3] bg-panel text-text-soft hover:bg-[#e3e3e3]'
                    )}
                  >
                    <span className="block text-[16px] font-semibold">
                      {principal.valor(fila)}
                      <Etiquetas etiquetas={etiquetasDe(fila)} />
                    </span>
                    <dl className="mt-2 space-y-0.5 text-[14px]">
                      {resto.map((c) => (
                        <div key={c.label} className="flex justify-between gap-3">
                          <dt className={seleccionada ? 'text-white/80' : 'text-text-faint'}>{c.label}</dt>
                          <dd className="truncate text-right">{c.valor(fila)}</dd>
                        </div>
                      ))}
                    </dl>
                  </button>
                );
              })}
            </div>
          )}

          {filas.length > cantidad && (
            <button
              type="button"
              onClick={() => setCantidad((n) => n + PAGINA)}
              className="mt-3 w-full rounded-[3px] bg-[#b3b3b3] py-2 text-[15px] text-white transition-colors hover:bg-[#9e9e9e]"
            >
              Ver más
            </button>
          )}
        </>
      )}

      {etiquetando && (
        <EtiquetasModal
          tipo={tipo}
          id={getId(etiquetando)}
          iniciales={etiquetasDe(etiquetando)}
          onClose={() => setEtiquetando(null)}
          onGuardado={(id, etiquetas) => {
            onEtiquetasGuardadas(id, etiquetas);
            setEtiquetando(null);
          }}
        />
      )}
    </div>
  );
}

function Etiquetas({ etiquetas }: { etiquetas: string[] }) {
  if (etiquetas.length === 0) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {etiquetas.map((e) => (
        <span
          key={e}
          className="rounded-sm bg-accent px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-accent-ink"
        >
          {e}
        </span>
      ))}
    </span>
  );
}

function EtiquetasModal({
  tipo,
  id,
  iniciales,
  onClose,
  onGuardado,
}: {
  tipo: TipoComprobante;
  id: string;
  iniciales: string[];
  onClose: () => void;
  onGuardado: (id: string, etiquetas: string[]) => void;
}) {
  const [etiquetas, setEtiquetas] = React.useState<string[]>(iniciales);
  const [nueva, setNueva] = React.useState('');
  const [guardando, setGuardando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function agregar() {
    const texto = nueva.trim();
    if (!texto) return;
    if (!etiquetas.includes(texto)) setEtiquetas([...etiquetas, texto]);
    setNueva('');
  }

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      // Lo escrito y no agregado todavía también cuenta: es lo que se espera
      // al apretar Guardar con el texto en el campo.
      const pendiente = nueva.trim();
      const todas = pendiente && !etiquetas.includes(pendiente) ? [...etiquetas, pendiente] : etiquetas;
      onGuardado(id, await guardarEtiquetas(tipo, id, todas));
    } catch (err) {
      setError(getErrorMessage(err));
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Panel className="w-full max-w-sm p-5">
        <h3 className="text-sm font-bold uppercase tracking-wider text-text">Etiquetar comprobante</h3>

        <div className="mt-3 flex min-h-8 flex-wrap gap-1.5">
          {etiquetas.length === 0 && <span className="text-sm text-text-faint">Sin etiquetas.</span>}
          {etiquetas.map((e) => (
            <span
              key={e}
              className="inline-flex items-center gap-1 rounded-sm bg-accent px-2 py-0.5 text-xs font-semibold uppercase text-accent-ink"
            >
              {e}
              <button
                type="button"
                onClick={() => setEtiquetas(etiquetas.filter((x) => x !== e))}
                aria-label={`Quitar la etiqueta ${e}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={nueva}
            onChange={(e) => setNueva(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); agregar(); }
            }}
            placeholder="Nueva etiqueta y Enter"
            autoFocus
            className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
          />
        </div>

        {error && <p className="mt-3 text-xs text-danger">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={guardando}>
            Cancelar
          </Button>
          <Button type="button" onClick={guardar} disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
