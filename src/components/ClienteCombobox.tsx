import React from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { formatCuit, TAX_CONDITION_LABELS, type TaxCondition } from '@/src/lib/fiscal';

/** Lo que el buscador necesita de un cliente (o de un proveedor). */
export interface ClienteBuscable {
  id: string;
  name: string;
  legalName?: string | null;
  taxId?: string | null;
  taxCondition?: TaxCondition;
  phone?: string | null;
  addressCity?: string | null;
  active?: boolean;
}

const MINIMO = 2;
const MAXIMO_RESULTADOS = 50;

const normalizar = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,]/g, '')
    .trim();

interface Indexado<T> {
  cliente: T;
  texto: string;
  nombre: string;
  digitos: string;
}

/**
 * Qué tan bien coincide: más alto, más arriba. Cada palabra buscada tiene que
 * estar en algún lado (nombre, razón social, localidad, CUIT o teléfono), en
 * cualquier orden; "lemon arg" encuentra a ARGENTI LEMON SA. Una palabra de
 * números busca también en el CUIT y el teléfono, con o sin guiones.
 */
function puntaje<T>(item: Indexado<T>, consulta: string, palabras: string[]): number {
  let puntos = 0;
  for (const palabra of palabras) {
    const digitos = palabra.replace(/\D/g, '');
    const enTexto = item.texto.includes(palabra);
    const enNumeros = digitos.length >= 3 && digitos === palabra.replace(/[-\s]/g, '') && item.digitos.includes(digitos);
    if (!enTexto && !enNumeros) return 0;
    if (enNumeros) puntos += 5;
    if (item.nombre.startsWith(palabra)) puntos += 4;
    else if (item.nombre.includes(` ${palabra}`)) puntos += 2;
    else if (enTexto) puntos += 1;
  }
  if (item.nombre === consulta) puntos += 20;
  else if (item.nombre.startsWith(consulta)) puntos += 10;
  return puntos;
}

/** Resalta en el nombre las palabras buscadas. */
function Resaltado({ texto, palabras }: { texto: string; palabras: string[] }) {
  const norm = normalizar(texto);
  const marcas = new Array(texto.length).fill(false);
  for (const p of palabras) {
    if (!p) continue;
    let desde = 0;
    for (;;) {
      const i = norm.indexOf(p, desde);
      if (i < 0) break;
      for (let k = i; k < i + p.length && k < marcas.length; k++) marcas[k] = true;
      desde = i + p.length;
    }
  }
  // La normalización saca puntos y comas: si cambió el largo, no se resalta.
  if (norm.length !== texto.length) return <>{texto}</>;
  const partes: React.ReactNode[] = [];
  let i = 0;
  while (i < texto.length) {
    const marcado = marcas[i];
    let j = i;
    while (j < texto.length && marcas[j] === marcado) j++;
    const trozo = texto.slice(i, j);
    partes.push(marcado ? <mark key={i} className="rounded-sm bg-accent/60 px-0 text-text">{trozo}</mark> : trozo);
    i = j;
  }
  return <>{partes}</>;
}

/**
 * Buscador de clientes para reemplazar al desplegable, que con más de mil
 * quinientos clientes era inmanejable.
 *
 * Se escribe y filtra desde la segunda letra: por nombre, razón social,
 * localidad, CUIT (con o sin guiones) o teléfono, con las palabras en
 * cualquier orden y sin importar acentos ni mayúsculas. Los resultados vienen
 * ordenados por qué tan bien coinciden —primero los que empiezan con lo
 * escrito— y se eligen con el mouse o con las flechas y Enter.
 */
export function ClienteCombobox<T extends ClienteBuscable>({
  clientes,
  value,
  onChange,
  placeholder = 'Buscá por nombre, razón social o CUIT…',
  disabled,
  className,
  vacio,
  autoFocus,
  entidad = 'cliente',
}: {
  clientes: T[];
  value: string;
  onChange: (id: string, cliente: T | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Clases del recuadro, para que se vea como los demás campos de la pantalla. */
  className?: string;
  /** Si se puede dejar sin cliente, el texto de esa opción ("Todos los clientes"). */
  vacio?: string;
  autoFocus?: boolean;
  /** Para los textos: el mismo buscador sirve para clientes y proveedores. */
  entidad?: 'cliente' | 'proveedor';
}) {
  const [abierto, setAbierto] = React.useState(false);
  const [consulta, setConsulta] = React.useState('');
  const [activo, setActivo] = React.useState(0);
  const contenedorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listaRef = React.useRef<HTMLUListElement>(null);

  const elegido = clientes.find((c) => c.id === value) ?? null;

  const indice = React.useMemo<Indexado<T>[]>(
    () =>
      clientes.map((c) => ({
        cliente: c,
        nombre: normalizar(c.name),
        texto: normalizar([c.name, c.legalName, c.addressCity].filter(Boolean).join(' ')),
        digitos: [c.taxId, c.phone].filter(Boolean).join(' ').replace(/\D/g, ' '),
      })),
    [clientes]
  );

  const consultaNorm = normalizar(consulta);
  const palabras = consultaNorm.split(/\s+/).filter(Boolean);
  const suficiente = consultaNorm.replace(/\s/g, '').length >= MINIMO;

  const resultados = React.useMemo(() => {
    if (!suficiente) return { lista: [] as T[], total: 0 };
    const conPuntaje = indice
      .map((item) => ({ item, puntos: puntaje(item, consultaNorm, palabras) }))
      .filter((x) => x.puntos > 0)
      .sort(
        (a, b) =>
          b.puntos - a.puntos ||
          Number(b.item.cliente.active !== false) - Number(a.item.cliente.active !== false) ||
          a.item.nombre.localeCompare(b.item.nombre)
      );
    return { lista: conPuntaje.slice(0, MAXIMO_RESULTADOS).map((x) => x.item.cliente), total: conPuntaje.length };
    // palabras se deriva de consultaNorm
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indice, consultaNorm, suficiente]);

  // Con "vacio", la primera opción es dejarlo sin cliente.
  const opciones: (T | null)[] = vacio ? [null, ...resultados.lista] : resultados.lista;

  React.useEffect(() => { setActivo(vacio && resultados.lista.length > 0 ? 1 : 0); }, [consultaNorm, vacio, resultados.lista.length]);

  React.useEffect(() => {
    if (!abierto) return;
    function cerrar(e: MouseEvent) {
      if (contenedorRef.current && !contenedorRef.current.contains(e.target as Node)) {
        setAbierto(false);
        setConsulta('');
      }
    }
    document.addEventListener('mousedown', cerrar);
    return () => document.removeEventListener('mousedown', cerrar);
  }, [abierto]);

  // La opción marcada con las flechas siempre a la vista.
  React.useEffect(() => {
    const li = listaRef.current?.children[activo] as HTMLElement | undefined;
    li?.scrollIntoView({ block: 'nearest' });
  }, [activo]);

  function abrir() {
    if (disabled) return;
    setAbierto(true);
    setConsulta('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function elegir(c: T | null) {
    onChange(c?.id ?? '', c);
    setAbierto(false);
    setConsulta('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActivo((i) => Math.min(i + 1, Math.max(opciones.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActivo((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (opciones.length > 0 && (suficiente || vacio)) elegir(opciones[activo] ?? null);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setAbierto(false);
      setConsulta('');
    } else if (e.key === 'Tab') {
      setAbierto(false);
      setConsulta('');
    }
  }

  const caja =
    'flex h-full w-full items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-left text-sm text-text';

  return (
    <div ref={contenedorRef} className={cn('relative', className?.includes('w-') ? '' : 'w-full')}>
      {!abierto ? (
        <button
          type="button"
          onClick={abrir}
          disabled={disabled}
          autoFocus={autoFocus}
          className={cn(caja, 'focus:border-accent-deep focus:outline-none disabled:cursor-not-allowed disabled:opacity-60', className)}
        >
          <span className={cn('min-w-0 flex-1 truncate', !elegido && 'text-text-faint')}>
            {elegido ? (
              <>
                {elegido.name}
                {elegido.taxId && <span className="text-text-soft"> — {formatCuit(elegido.taxId)}</span>}
              </>
            ) : (
              vacio ?? placeholder
            )}
          </span>
          {elegido && vacio !== undefined && !disabled && (
            <span
              role="button"
              aria-label={`Quitar el ${entidad} elegido`}
              onClick={(e) => { e.stopPropagation(); onChange('', null); }}
              className="shrink-0 rounded p-0.5 text-text-soft hover:bg-panel-head hover:text-text"
            >
              <X size={14} />
            </span>
          )}
          <ChevronDown size={16} className="shrink-0 text-text-soft" />
        </button>
      ) : (
        <div className={cn(caja, 'border-accent-deep', className)}>
          <Search size={15} className="shrink-0 text-text-soft" />
          <input
            ref={inputRef}
            value={consulta}
            onChange={(e) => setConsulta(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={`Buscar ${entidad}`}
            aria-expanded
            role="combobox"
            className="min-w-0 flex-1 bg-transparent text-sm normal-case tracking-normal text-text placeholder:text-text-faint focus:outline-none"
          />
        </div>
      )}

      {abierto && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-md border border-line-strong bg-panel shadow-lg">
          {!suficiente && !vacio && (
            <p className="px-3 py-3 text-[13px] text-text-soft">
              Escribí al menos {MINIMO} letras del nombre, la razón social o el CUIT. Varias palabras, en
              cualquier orden: «lemon arg».
            </p>
          )}
          {suficiente && resultados.total === 0 && (
            <p className="px-3 py-3 text-[13px] text-text-soft">Ningún {entidad} coincide con «{consulta.trim()}».</p>
          )}
          {opciones.length > 0 && (
            <ul ref={listaRef} role="listbox" className="max-h-80 overflow-y-auto py-1">
              {opciones.map((c, i) => (
                <li
                  key={c?.id ?? '__vacio'}
                  role="option"
                  aria-selected={i === activo}
                  onMouseDown={(e) => { e.preventDefault(); elegir(c); }}
                  onMouseEnter={() => setActivo(i)}
                  className={cn(
                    'cursor-pointer px-3 py-1.5 text-sm normal-case tracking-normal',
                    i === activo ? 'bg-accent/25' : 'hover:bg-panel-alt',
                    c?.id === value && 'font-semibold'
                  )}
                >
                  {c === null ? (
                    <span className="text-text-soft">{vacio}</span>
                  ) : (
                    <>
                      <span className="block text-text">
                        <Resaltado texto={c.name} palabras={palabras} />
                        {c.active === false && (
                          <span className="ml-2 rounded-sm bg-panel-head px-1 text-[11px] uppercase text-text-soft">
                            Inactivo
                          </span>
                        )}
                      </span>
                      <span className="block text-[12px] text-text-soft">
                        {[
                          c.legalName && normalizar(c.legalName) !== normalizar(c.name) ? c.legalName : null,
                          c.taxId ? formatCuit(c.taxId) : null,
                          c.taxCondition ? TAX_CONDITION_LABELS[c.taxCondition] : null,
                          c.addressCity,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {suficiente && resultados.total > MAXIMO_RESULTADOS && (
            <p className="border-t border-line px-3 py-1.5 text-[12px] text-text-faint">
              Se muestran {MAXIMO_RESULTADOS} de {resultados.total}: seguí escribiendo para achicar la lista.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
