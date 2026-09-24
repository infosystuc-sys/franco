import React from 'react';
import { Filter, Pencil, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { PART_KIND_LABELS, type PartKind } from '@/src/lib/articles';
import {
  actualizarEnMasa,
  contarAlcanzados,
  fetchValoresDeClasificacion,
  type CambiosArticulos,
  type FiltroArticulos,
  type ValoresDeClasificacion,
} from '@/src/lib/actualizacionMasiva';

/** Los campos que se pueden cambiar en masa, y cómo se los nombra. */
const CAMPOS = [
  { key: 'markupPercent', label: 'Utilidad (%)', tipo: 'numero' },
  { key: 'rubro', label: 'Rubro', tipo: 'texto' },
  { key: 'familia', label: 'Familia', tipo: 'texto' },
  { key: 'marca', label: 'Marca', tipo: 'texto' },
  { key: 'partKind', label: 'Tipo de pieza', tipo: 'partKind' },
  { key: 'tracksStock', label: 'Lleva stock', tipo: 'booleano' },
  { key: 'active', label: 'Activo', tipo: 'booleano' },
] as const;

type CampoKey = (typeof CAMPOS)[number]['key'];

/**
 * Actualización masiva de artículos.
 *
 * Arriba a quiénes alcanza, abajo qué cambiarles. Nada se toca hasta apretar
 * aplicar, y antes se muestra cuántos artículos caen en el filtro: es el único
 * número que distingue "los cuarenta de este rubro" de "el catálogo entero".
 */
export function ActualizacionMasiva() {
  const { role } = useAuth();

  const [valores, setValores] = React.useState<ValoresDeClasificacion>({
    rubros: [], familias: [], marcas: [],
  });
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [filtro, setFiltro] = React.useState<FiltroArticulos>({});
  const [elegidos, setElegidos] = React.useState<Set<CampoKey>>(new Set());
  const [cambios, setCambios] = React.useState<Record<string, string>>({});
  const [alcanzados, setAlcanzados] = React.useState<number | null>(null);
  const [contando, setContando] = React.useState(false);
  const [aplicando, setAplicando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    fetchValoresDeClasificacion().then(setValores).catch((e) => setError(getErrorMessage(e)));
    fetchSuppliers(true).then(setSuppliers).catch(() => setSuppliers([]));
  }, [role]);

  // Cualquier cambio en el filtro invalida el conteo: mostrarlo viejo al lado
  // del botón de aplicar sería peor que no mostrarlo.
  React.useEffect(() => {
    setAlcanzados(null);
  }, [filtro]);

  if (role && role !== 'admin') return <Navigate to="/" replace />;

  function armarCambios(): CambiosArticulos {
    const c: CambiosArticulos = {};
    for (const campo of CAMPOS) {
      if (!elegidos.has(campo.key)) continue;
      const v = cambios[campo.key] ?? '';
      if (campo.tipo === 'booleano') (c as any)[campo.key] = v === 'true';
      else (c as any)[campo.key] = v;
    }
    return c;
  }

  const hayCambios = elegidos.size > 0;

  async function contar() {
    setContando(true);
    setError(null);
    setAviso(null);
    try {
      setAlcanzados(await contarAlcanzados(filtro, armarCambios()));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setContando(false);
    }
  }

  async function aplicar() {
    if (alcanzados === null || alcanzados === 0) return;

    const detalle = CAMPOS.filter((c) => elegidos.has(c.key))
      .map((c) => {
        const v = cambios[c.key] ?? '';
        if (c.tipo === 'booleano') return `${c.label}: ${v === 'true' ? 'sí' : 'no'}`;
        return `${c.label}: ${v === '' ? '(sin valor)' : v}`;
      })
      .join('\n');

    if (
      !window.confirm(
        `Cambiar ${alcanzados} artículo(s):\n\n${detalle}\n\nNo se puede deshacer.`
      )
    ) {
      return;
    }

    setAplicando(true);
    setError(null);
    setAviso(null);
    try {
      const r = await actualizarEnMasa(filtro, armarCambios());
      setAviso(
        `${r.afectados} artículo(s) actualizado(s).` +
          (r.salteados > 0
            ? ` A ${r.salteados} no se les pudo poner la marca: con esa marca quedarían ` +
              'idénticos a otro con el mismo número de fábrica. Unificalos desde Artículos duplicados.'
            : '')
      );
      setAlcanzados(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAplicando(false);
    }
  }

  function toggle(key: CampoKey) {
    setElegidos((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
    setAlcanzados(null);
  }

  const sinFiltro = Object.keys(filtro).length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Actualización masiva"
        subtitle="Cambiar un campo en muchos artículos de una vez."
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {aviso && !error && (
        <div className="flex items-start gap-2 rounded-md border border-state-done/40 bg-panel-alt px-4 py-3 text-sm">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-state-done" />
          <span>{aviso}</span>
        </div>
      )}

      {/* A quiénes alcanza */}
      <Panel className="space-y-4 p-5">
        <SectionHeader title="A qué artículos" />
        <p className="text-xs text-text-soft">
          Los filtros se suman: si ponés rubro y marca, alcanza a los que cumplen
          las dos. Sin ningún filtro alcanza a todo el catálogo.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className={labelClass}>
            Código desde
            <input
              value={filtro.codigoDesde ?? ''}
              onChange={(e) => setFiltro({ ...filtro, codigoDesde: e.target.value || undefined })}
              placeholder="000001"
              className={cn(inputClass, 'font-mono')}
            />
          </label>
          <label className={labelClass}>
            Código hasta
            <input
              value={filtro.codigoHasta ?? ''}
              onChange={(e) => setFiltro({ ...filtro, codigoHasta: e.target.value || undefined })}
              placeholder="000999"
              className={cn(inputClass, 'font-mono')}
            />
          </label>
          <label className={labelClass}>
            En la descripción
            <input
              value={filtro.texto ?? ''}
              onChange={(e) => setFiltro({ ...filtro, texto: e.target.value || undefined })}
              placeholder="TOBERA"
              className={inputClass}
            />
          </label>

          <ListaODato
            etiqueta="Rubro"
            valor={filtro.rubro ?? ''}
            opciones={valores.rubros}
            onChange={(v) => setFiltro({ ...filtro, rubro: v || undefined })}
          />
          <ListaODato
            etiqueta="Familia"
            valor={filtro.familia ?? ''}
            opciones={valores.familias}
            onChange={(v) => setFiltro({ ...filtro, familia: v || undefined })}
          />
          <ListaODato
            etiqueta="Marca"
            valor={filtro.marca ?? ''}
            opciones={valores.marcas}
            onChange={(v) => setFiltro({ ...filtro, marca: v || undefined })}
          />

          <label className={labelClass}>
            Proveedor
            <select
              value={filtro.supplierId ?? ''}
              onChange={(e) => setFiltro({ ...filtro, supplierId: e.target.value || undefined })}
              className={inputClass}
            >
              <option value="">Cualquiera</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className={labelClass}>
            Tipo de pieza
            <select
              value={filtro.partKind ?? ''}
              onChange={(e) =>
                setFiltro({ ...filtro, partKind: (e.target.value || undefined) as PartKind })
              }
              className={inputClass}
            >
              <option value="">Cualquiera</option>
              {Object.entries(PART_KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Estado
            <select
              value={filtro.activos === undefined ? '' : String(filtro.activos)}
              onChange={(e) =>
                setFiltro({
                  ...filtro,
                  activos: e.target.value === '' ? undefined : e.target.value === 'true',
                })
              }
              className={inputClass}
            >
              <option value="">Todos</option>
              <option value="true">Solo activos</option>
              <option value="false">Solo inactivos</option>
            </select>
          </label>
        </div>
      </Panel>

      {/* Qué cambiarles */}
      <Panel className="space-y-4 p-5">
        <SectionHeader title="Qué cambiarles" />
        <p className="text-xs text-text-soft">
          Solo se tocan los campos que tildes. Dejar el valor vacío significa
          borrarle ese dato al artículo.
        </p>

        <div className="space-y-2">
          {CAMPOS.map((campo) => {
            const activo = elegidos.has(campo.key);
            return (
              <div
                key={campo.key}
                className={cn(
                  'flex flex-wrap items-center gap-3 border px-3 py-2',
                  activo ? 'border-accent bg-panel-alt' : 'border-line'
                )}
              >
                <label className="inline-flex min-w-48 items-center gap-2 text-sm">
                  <input type="checkbox" checked={activo} onChange={() => toggle(campo.key)} />
                  {campo.label}
                </label>

                {activo && campo.tipo === 'booleano' && (
                  <select
                    value={cambios[campo.key] ?? 'true'}
                    onChange={(e) => setCambios({ ...cambios, [campo.key]: e.target.value })}
                    className={cn(inputClass, 'w-40')}
                  >
                    <option value="true">Sí</option>
                    <option value="false">No</option>
                  </select>
                )}

                {activo && campo.tipo === 'partKind' && (
                  <select
                    value={cambios[campo.key] ?? ''}
                    onChange={(e) => setCambios({ ...cambios, [campo.key]: e.target.value })}
                    className={cn(inputClass, 'w-48')}
                  >
                    <option value="">Sin definir</option>
                    {Object.entries(PART_KIND_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                )}

                {activo && (campo.tipo === 'texto' || campo.tipo === 'numero') && (
                  <input
                    type={campo.tipo === 'numero' ? 'number' : 'text'}
                    step={campo.tipo === 'numero' ? '0.01' : undefined}
                    value={cambios[campo.key] ?? ''}
                    onChange={(e) => setCambios({ ...cambios, [campo.key]: e.target.value })}
                    placeholder={campo.tipo === 'numero' ? 'vacío = utilidad global' : 'vacío = sin valor'}
                    className={cn(inputClass, 'w-64')}
                  />
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Contar y aplicar */}
      <Panel className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" type="button" onClick={contar} disabled={!hayCambios || contando}>
            <Filter size={16} /> {contando ? 'Contando…' : 'Ver a cuántos alcanza'}
          </Button>
          <Button
            type="button"
            onClick={aplicar}
            disabled={alcanzados === null || alcanzados === 0 || aplicando}
          >
            <Pencil size={16} /> {aplicando ? 'Aplicando…' : 'Aplicar'}
          </Button>
        </div>

        {!hayCambios && (
          <p className="text-xs text-text-soft">Tildá al menos un campo para cambiar.</p>
        )}

        {alcanzados !== null && (
          <p
            className={cn(
              'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
              alcanzados === 0
                ? 'border-line bg-panel-head'
                : sinFiltro
                  ? 'border-danger/40 bg-danger-soft text-danger'
                  : 'border-line-strong bg-panel-alt'
            )}
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              {alcanzados === 0
                ? 'Ningún artículo cae en ese filtro.'
                : `Alcanza a ${alcanzados} artículo(s).`}
              {sinFiltro && alcanzados > 0 && ' Es el catálogo entero: no pusiste ningún filtro.'}
            </span>
          </p>
        )}
      </Panel>
    </div>
  );
}

/**
 * Un campo que propone lo que ya existe pero deja escribir algo nuevo: los
 * rubros y familias son texto libre y la lista puede estar vacía al empezar.
 */
function ListaODato({
  etiqueta,
  valor,
  opciones,
  onChange,
}: {
  etiqueta: string;
  valor: string;
  opciones: string[];
  onChange: (v: string) => void;
}) {
  const id = `lista-${etiqueta.toLowerCase()}`;
  return (
    <label className={labelClass}>
      {etiqueta}
      <input
        list={id}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Cualquiera"
        className={inputClass}
      />
      <datalist id={id}>
        {opciones.map((o) => <option key={o} value={o} />)}
      </datalist>
    </label>
  );
}
