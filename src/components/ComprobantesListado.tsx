import React from 'react';
import { ChevronDown, LayoutGrid, List, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn, coincideBusqueda } from '@/src/lib/utils';
import { ordenarFilas, type Orden } from '@/src/lib/ordenar';
import { ThOrdenable } from '@/src/components/ThOrdenable';
import { CabeceraFija } from '@/src/components/CabeceraFija';
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
  /**
   * Qué valor se compara al ordenar por esta columna, si no es lo que se ve
   * (un estado con su color, por ejemplo). Por defecto, el texto de la celda.
   */
  orden?: (fila: T) => unknown;
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

/**
 * El texto que muestra una celda, aunque venga armada (un estado con su
 * cuadradito de color, por ejemplo): es lo que se busca y lo que se filtra.
 */
function textoDe(nodo: React.ReactNode): string {
  if (nodo === null || nodo === undefined || typeof nodo === 'boolean') return '';
  if (typeof nodo === 'string' || typeof nodo === 'number') return String(nodo);
  if (Array.isArray(nodo)) return nodo.map(textoDe).join(' ');
  if (React.isValidElement(nodo)) return textoDe((nodo.props as { children?: React.ReactNode }).children);
  return '';
}

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
  vacio = 'Todavía no hay comprobantes emitidos.',
  aviso,
  onCerrarAviso,
  textoBusqueda,
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
  vacio?: string;
  /** Un resultado para contar (no un error): "Se eliminó la orden…". */
  aviso?: string | null;
  onCerrarAviso?: () => void;
  /**
   * Datos que no están en las columnas pero por los que se busca (el número
   * de pieza o la patente del equipo de una factura, por ejemplo).
   */
  textoBusqueda?: (fila: T) => unknown[];
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

  // ── Búsqueda y filtro por estado ─────────────────────────────────────
  // La búsqueda mira todo lo que se ve en la fila (número, cliente,
  // vehículo, importes…), con la misma regla que el resto de la app. El
  // filtro por estado sale de la columna "Estado" de cada pantalla, con los
  // estados que realmente aparecen en el listado.
  const [busqueda, setBusqueda] = React.useState('');
  // Los estados elegidos; vacío = todos.
  const [estados, setEstados] = React.useState<string[]>([]);
  const busquedaDiferida = React.useDeferredValue(busqueda);
  const columnaEstado = columnas.find((c) => c.label === 'Estado');

  const estadosPresentes = React.useMemo(() => {
    if (!columnaEstado) return [];
    const cuenta = new Map<string, number>();
    for (const f of filas) {
      const e = textoDe(columnaEstado.valor(f)).trim();
      if (e) cuenta.set(e, (cuenta.get(e) ?? 0) + 1);
    }
    return [...cuenta.entries()];
  }, [filas, columnaEstado]);

  const filtradas = React.useMemo(() => {
    if (busquedaDiferida.trim() === '' && estados.length === 0) return filas;
    return filas.filter((f) => {
      if (estados.length > 0 && columnaEstado && !estados.includes(textoDe(columnaEstado.valor(f)).trim())) return false;
      if (busquedaDiferida.trim() === '') return true;
      return coincideBusqueda(busquedaDiferida, [
        ...columnas.map((c) => textoDe(c.valor(f))),
        ...(textoBusqueda?.(f) ?? []),
      ]);
    });
  }, [filas, busquedaDiferida, estados, columnas, columnaEstado, textoBusqueda]);

  // Con otro filtro se vuelve a la primera página.
  React.useEffect(() => {
    setCantidad(PAGINA);
  }, [busquedaDiferida, estados]);

  const filtrando = busqueda.trim() !== '' || estados.length > 0;

  // Orden por columna: un click en el título ordena, otro invierte, otro
  // vuelve al orden de la pantalla. Se aplica a todo lo filtrado, no solo a
  // lo que se ve: "Ver más" sigue el mismo orden.
  const [orden, setOrden] = React.useState<Orden | null>(null);
  const ordenadas = React.useMemo(
    () =>
      ordenarFilas(filtradas, orden, (fila, columna) => {
        const c = columnas.find((x) => x.label === columna);
        return c ? (c.orden ? c.orden(fila) : textoDe(c.valor(fila))) : null;
      }),
    [filtradas, orden, columnas]
  );

  const visibles = ordenadas.slice(0, cantidad);

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

  const elegida = filas.find((f) => getId(f) === elegidoId) ?? null;

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
      <CabeceraFija>
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1 sm:max-w-md">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por número, cliente, vehículo, importe…"
            aria-label="Buscar en el listado"
            className="h-10 w-full rounded-[3px] border border-line bg-panel pl-9 pr-3 text-[15px] text-text focus:border-accent focus:outline-none"
          />
        </div>
        {columnaEstado && (
          <FiltroDeEstados opciones={estadosPresentes} elegidos={estados} onChange={setEstados} />
        )}
        {filtrando && (
          <>
            <span className="text-[14px] text-text-soft">
              {filtradas.length} de {filas.length}
            </span>
            <button
              type="button"
              onClick={() => {
                setBusqueda('');
                setEstados([]);
              }}
              className="inline-flex items-center gap-1 text-[14px] text-text-soft hover:text-text"
            >
              <X size={14} /> Limpiar
            </button>
          </>
        )}
      </div>
      </CabeceraFija>

      {loading ? (
        <p className="py-10 text-center text-text-soft">Cargando…</p>
      ) : filas.length === 0 ? (
        <p className="py-10 text-center text-text-soft">{vacio}</p>
      ) : filtradas.length === 0 ? (
        <p className="py-10 text-center text-text-soft">Ningún comprobante coincide con la búsqueda o el estado elegido.</p>
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
              className="overflow-x-auto focus:outline-none xl:overflow-x-clip"
            >
              <table className="tabla-fija w-full min-w-[900px] text-left text-[16px] [--cabecera-bg:var(--color-surface)] xl:min-w-0">
                <thead>
                  <tr className="text-[17px] font-semibold text-text">
                    {columnas.map((c) => (
                      <ThOrdenable
                        key={c.label}
                        columna={c.label}
                        orden={orden}
                        onOrden={setOrden}
                        derecha={c.derecha}
                        className={cn('whitespace-nowrap px-2 py-2', c.ancho)}
                      >
                        {c.label}
                      </ThOrdenable>
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

          {filtradas.length > cantidad && (
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

/**
 * El filtro de estado: un desplegable con una casilla por estado, para
 * elegir uno o varios a la vez (Ingresado + En reparación, por ejemplo).
 * Sin ninguno tildado, muestra todos.
 */
function FiltroDeEstados({
  opciones,
  elegidos,
  onChange,
}: {
  opciones: [string, number][];
  elegidos: string[];
  onChange: (elegidos: string[]) => void;
}) {
  const [abierto, setAbierto] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!abierto) return;
    function cerrar(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false);
    }
    document.addEventListener('mousedown', cerrar);
    return () => document.removeEventListener('mousedown', cerrar);
  }, [abierto]);

  function alternar(estado: string) {
    onChange(elegidos.includes(estado) ? elegidos.filter((e) => e !== estado) : [...elegidos, estado]);
  }

  const rotulo =
    elegidos.length === 0 ? 'Todos los estados' : elegidos.length === 1 ? elegidos[0] : `${elegidos.length} estados`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        onKeyDown={(e) => e.key === 'Escape' && setAbierto(false)}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-label="Filtrar por estado"
        className={cn(
          'inline-flex h-10 min-w-[12rem] items-center justify-between gap-2 rounded-[3px] border bg-panel px-3 text-[15px] text-text focus:border-accent focus:outline-none',
          elegidos.length > 0 ? 'border-accent' : 'border-line'
        )}
      >
        <span className="truncate">{rotulo}</span>
        <ChevronDown size={16} className="shrink-0 text-text-soft" />
      </button>

      {abierto && (
        <div
          role="listbox"
          aria-multiselectable
          className="absolute left-0 top-full z-40 mt-1 min-w-full whitespace-nowrap border border-line bg-panel py-1 shadow-lg"
        >
          {opciones.map(([estado, cantidad]) => (
            <label
              key={estado}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[15px] text-text hover:bg-panel-alt"
            >
              <input
                type="checkbox"
                checked={elegidos.includes(estado)}
                onChange={() => alternar(estado)}
                className="h-4 w-4 accent-accent"
              />
              <span className="flex-1">{estado}</span>
              <span className="text-[13px] text-text-soft">{cantidad}</span>
            </label>
          ))}
          {elegidos.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full border-t border-line px-3 py-1.5 text-left text-[14px] text-text-soft hover:text-text"
            >
              Ver todos los estados
            </button>
          )}
        </div>
      )}
    </div>
  );
}
