import React from 'react';
import { Merge, AlertTriangle, CheckCircle2, Package } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  fetchArticulosDuplicados,
  fusionarArticulos,
  type ArticuloDuplicado,
  type GrupoDuplicado,
} from '@/src/lib/articulosDuplicados';

/**
 * Artículos duplicados, para unificarlos.
 *
 * Cada grupo es un número de fábrica con más de una ficha. Se elige cuál se
 * conserva y el resto se absorbe: proveedores, stock e historia pasan a la que
 * queda y las otras desaparecen.
 *
 * La pantalla muestra proveedores y movimientos de cada ficha porque es lo que
 * decide cuál conservar, y elegir mal no se deshace.
 */
export function ArticulosDuplicados() {
  const { role } = useAuth();

  const [grupos, setGrupos] = React.useState<GrupoDuplicado[]>([]);
  const [elegido, setElegido] = React.useState<Record<string, string>>({});
  const [fusionando, setFusionando] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchArticulosDuplicados();
      setGrupos(data);
      // Se propone conservar la que más historia tiene: es la que más cuesta
      // reconstruir si se elige mal.
      setElegido(
        Object.fromEntries(
          data.map((g) => [g.factoryCode, [...g.articulos].sort(porPeso)[0]?.id ?? ''])
        )
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (role === 'admin') cargar();
  }, [role, cargar]);

  if (role && role !== 'admin') return <Navigate to="/" replace />;

  async function handleFusionar(grupo: GrupoDuplicado) {
    const conservarId = elegido[grupo.factoryCode];
    const conservar = grupo.articulos.find((a) => a.id === conservarId);
    const absorber = grupo.articulos.filter((a) => a.id !== conservarId);
    if (!conservar || absorber.length === 0) return;

    const compartidos = absorber.some((a) => a.proveedores > 0) && conservar.proveedores > 0;

    if (
      !window.confirm(
        `Unificar ${absorber.length + 1} ficha(s) del número de fábrica ${grupo.factoryCode}.\n\n` +
          `Queda: ${conservar.code} — ${conservar.description}\n` +
          `Desaparece(n): ${absorber.map((a) => a.code).join(', ')}\n\n` +
          'Los proveedores, el stock y la historia pasan a la ficha que queda.' +
          (compartidos
            ? '\n\nSi las dos tenían cargado el mismo proveedor, uno de los códigos de ese ' +
              'proveedor se pierde y deja de reconocerse al importar. Te digo cuál al terminar.'
            : '') +
          '\n\nNo se puede deshacer.'
      )
    ) {
      return;
    }

    setFusionando(grupo.factoryCode);
    setError(null);
    setAviso(null);
    try {
      const perdidos: string[] = [];
      let movidos = 0;
      for (const a of absorber) {
        const r = await fusionarArticulos(conservarId, a.id);
        perdidos.push(...r.codigosPerdidos);
        movidos += r.proveedoresMovidos;
      }
      setAviso(
        `${grupo.factoryCode} unificado en ${conservar.code}. ` +
          `${movidos} proveedor(es) movido(s).` +
          (perdidos.length
            ? ` Códigos que se perdieron porque la ficha que queda ya tenía ese proveedor: ${perdidos.join(', ')}.`
            : '')
      );
      await cargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setFusionando(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Artículos duplicados"
        subtitle="La misma pieza cargada más de una vez, con el mismo número de fábrica."
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

      {loading && <p className="text-center text-sm text-text-soft">Buscando duplicados…</p>}

      {!loading && grupos.length === 0 && (
        <Panel className="p-8 text-center text-sm text-text-soft">
          <Package size={24} className="mx-auto mb-2 text-text-faint" />
          No hay artículos duplicados: ningún número de fábrica tiene más de una ficha.
        </Panel>
      )}

      {!loading && grupos.length > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-line bg-panel-head px-4 py-3 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-text-soft" />
          <span>
            {grupos.length} número(s) de fábrica con más de una ficha. Elegí cuál se
            conserva en cada grupo: la que tiene proveedores y movimientos es la que
            más cuesta rehacer.
          </span>
        </p>
      )}

      {grupos.map((grupo) => (
        <Panel key={grupo.factoryCode} className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <span className="font-mono text-lg font-semibold text-text">
              {grupo.factoryCode}
            </span>
            <Button
              type="button"
              onClick={() => handleFusionar(grupo)}
              disabled={fusionando !== null || !elegido[grupo.factoryCode]}
            >
              <Merge size={16} />{' '}
              {fusionando === grupo.factoryCode ? 'Unificando…' : 'Unificar'}
            </Button>
          </div>

          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                <th className="py-2 w-24">Conservar</th>
                <th className="py-2">Código</th>
                <th className="py-2">Descripción</th>
                <th className="py-2">Marca</th>
                <th className="py-2 text-right">Stock</th>
                <th className="py-2 text-right">Precio</th>
                <th className="py-2 text-right">Prov.</th>
                <th className="py-2 text-right">Movim.</th>
              </tr>
            </thead>
            <tbody>
              {grupo.articulos.map((a) => {
                const seConserva = elegido[grupo.factoryCode] === a.id;
                return (
                  <tr
                    key={a.id}
                    className={cn(
                      'border-b border-line/60',
                      !seConserva && 'text-text-soft'
                    )}
                  >
                    <td className="py-1.5">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="radio"
                          name={`conservar-${grupo.factoryCode}`}
                          checked={seConserva}
                          onChange={() =>
                            setElegido((v) => ({ ...v, [grupo.factoryCode]: a.id }))
                          }
                        />
                        <span className="text-[12px] uppercase tracking-[0.06em]">
                          {seConserva ? 'Queda' : 'Se absorbe'}
                        </span>
                      </label>
                    </td>
                    <td className="py-1.5 font-mono">{a.code}</td>
                    <td className="py-1.5">
                      {a.description}
                      {!a.active && (
                        <span className="ml-2 text-[12px] uppercase tracking-[0.06em] text-text-faint">
                          inactivo
                        </span>
                      )}
                    </td>
                    <td className="py-1.5">{a.brand ?? '—'}</td>
                    <td className="py-1.5 text-right">
                      {a.tracksStock ? a.stockQuantity : '—'}
                    </td>
                    <td className="py-1.5 text-right">$ {formatMoney(a.unitPrice)}</td>
                    <td className="py-1.5 text-right">{a.proveedores}</td>
                    <td className="py-1.5 text-right">{a.movimientos}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      ))}
    </div>
  );
}

/** Más historia primero: movimientos, después proveedores, después stock. */
function porPeso(a: ArticuloDuplicado, b: ArticuloDuplicado): number {
  return (
    b.movimientos - a.movimientos ||
    b.proveedores - a.proveedores ||
    b.stockQuantity - a.stockQuantity
  );
}
