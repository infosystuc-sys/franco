import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { cn, formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage, setEstimatedDeliveryDate } from '@/src/lib/workOrders';
import { SIZE_CLASS_LABELS } from '@/src/lib/vehicles';
import {
  disponibilidad,
  fetchYardCells,
  fetchYardOccupancy,
  hoyISO,
  proyectarDisponibilidad,
  sinFechaEstimada,
  vencidas,
  type YardOccupant,
} from '@/src/lib/yardCapacity';

/**
 * Cuánto lugar queda en la playa, hoy y en los próximos días.
 *
 * Ocupa playa toda OT que recibió un vehículo y cuyo estado todavía no lo
 * libera. Una pieza sobre el mostrador no ocupa lugar de estacionamiento,
 * aunque se haya elegido de qué equipo salió. No se reparte por sector ni se
 * deduce de quién atiende el vehículo — dónde está parado un camión no
 * depende de eso.
 *
 * La playa se mide en CELDAS: en cada una entra un vehículo grande o hasta
 * tres medianos. El lugar que sobra en una celda a medio llenar no se publica
 * como disponible.
 *
 * La proyección supone que cada orden se retira en su fecha estimada. Las que
 * no tienen fecha, y las que la tienen vencida sin haberse retirado, ocupan
 * toda la ventana: la celda está tomada de hecho y no hay con qué predecir
 * cuándo se libera.
 */
export function ShopCapacity() {
  const { role } = useAuth();
  const [cells, setCells] = React.useState(0);
  const [occupancy, setOccupancy] = React.useState<YardOccupant[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [celdas, rows] = await Promise.all([fetchYardCells(), fetchYardOccupancy()]);
      setCells(celdas);
      setOccupancy(rows);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  // hoyISO se calcula una vez y se pasa a todo: la proyección y los contadores
  // tienen que estar de acuerdo en qué es pasado.
  const hoy = hoyISO();
  const disponible = React.useMemo(() => disponibilidad(cells, occupancy), [cells, occupancy]);
  const libres = disponible.freeCells;
  const linea = React.useMemo(
    () => proyectarDisponibilidad(cells, occupancy, 14, hoy),
    [cells, occupancy, hoy]
  );
  const sinFecha = React.useMemo(() => sinFechaEstimada(occupancy), [occupancy]);
  const atrasadas = React.useMemo(() => vencidas(occupancy, hoy), [occupancy, hoy]);

  const sortedOccupancy = React.useMemo(() => {
    return [...occupancy].sort((a, b) => {
      if (a.estimatedDeliveryDate && b.estimatedDeliveryDate) {
        return a.estimatedDeliveryDate.localeCompare(b.estimatedDeliveryDate);
      }
      if (a.estimatedDeliveryDate) return -1;
      if (b.estimatedDeliveryDate) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }, [occupancy]);

  const sinConfigurar = cells === 0;

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleDeliveryChange(workOrderId: string, date: string) {
    setError(null);
    try {
      await setEstimatedDeliveryDate(workOrderId, date || null);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Disponibilidad del taller"
        subtitle="Cuánto lugar queda en la playa, según las órdenes de trabajo en curso."
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {!loading && sinConfigurar && (
        <div className="rounded-md border border-line bg-panel-alt px-4 py-3 text-sm text-text-soft">
          Todavía no cargaste cuántas celdas tiene el taller. Configurala en{' '}
          <Link to="/configuracion" className="font-semibold text-accent-deep hover:underline">Configuración</Link>{' '}
          para que esta pantalla pueda decir cuánto lugar queda.
        </div>
      )}

      <Panel className="p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-8">
            <div>
              <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                Entran todavía
              </span>
              <span className="font-display text-5xl font-medium text-text">
                {loading ? '—' : disponible.grandes}
              </span>
              <span className="ml-2 text-sm text-text-soft">
                grande{disponible.grandes === 1 ? '' : 's'}
              </span>
            </div>
            <div>
              <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                o bien
              </span>
              <span className="font-display text-5xl font-medium text-text">
                {loading ? '—' : disponible.medianos}
              </span>
              <span className="ml-2 text-sm text-text-soft">
                mediano{disponible.medianos === 1 ? '' : 's'}
              </span>
            </div>
            <div className="pb-1">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                Celdas libres
              </span>
              <span className={cn(
                'font-display text-2xl font-medium',
                libres < 0 ? 'text-danger' : 'text-text-soft'
              )}>
                {loading ? '—' : libres}
              </span>
              <span className="ml-1 text-sm text-text-soft">de {cells}</span>
            </div>
          </div>
          <p className="max-w-xs text-xs text-text-soft">
            En cada celda entra un vehículo grande o hasta tres medianos. Un grande
            necesita la celda entera; un mediano puede sumarse a una que esté a
            medio llenar.
          </p>
        </div>

        {libres < 0 && (
          <p className="mt-3 border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
            Hay más vehículos que celdas: la playa está desbordada.
          </p>
        )}

        {!loading && (sinFecha.length > 0 || atrasadas.length > 0) && (
          <p className="mt-3 text-xs text-text-soft">
            {sinFecha.length > 0 && <>{sinFecha.length} sin fecha estimada. </>}
            {atrasadas.length > 0 && <>{atrasadas.length} con la fecha vencida. </>}
            Ocupan celda todos los días proyectados, porque no hay con qué saber
            cuándo se liberan.
          </p>
        )}
      </Panel>

      <Panel className="p-5">
        <h2 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
          <CalendarClock size={14} /> Cuántos entran, día por día
        </h2>
        <p className="mb-3 text-xs text-text-soft">
          G = vehículos grandes, M = medianos. Suponiendo que cada orden se retire
          en su fecha estimada: es una proyección, no una promesa — una fecha que
          se corre arrastra todo lo que viene atrás.
        </p>
        <div className="overflow-x-auto">
          <div className="flex gap-2">
            {linea.map((dia) => (
              <div
                key={dia.date}
                className={cn(
                  'min-w-[78px] border p-2 text-center',
                  dia.freeCells < 0 ? 'border-danger/40 bg-danger-soft' : 'border-line bg-panel-alt'
                )}
              >
                <span className="block text-[10px] uppercase tracking-[0.06em] text-text-soft">
                  {formatDate(dia.date)}
                </span>
                {/* Los dos números, porque uno solo miente: puede no quedar
                    ninguna celda entera y entrar un mediano igual. */}
                <span className={cn(
                  'block font-display text-lg font-medium leading-tight',
                  dia.freeCells < 0 ? 'text-danger' : 'text-text'
                )}>
                  {dia.grandes} <span className="text-[10px] font-normal text-text-soft">G</span>
                </span>
                <span className={cn(
                  'block font-display text-lg font-medium leading-tight',
                  dia.freeCells < 0 ? 'text-danger' : 'text-text'
                )}>
                  {dia.medianos} <span className="text-[10px] font-normal text-text-soft">M</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto overflow-y-hidden">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="w-28 p-3 font-semibold">Comprobante</th>
                <th className="p-3 font-semibold">Cliente</th>
                <th className="p-3 font-semibold">Vehículo</th>
                <th className="w-28 p-3 font-semibold">Tamaño</th>
                <th className="w-36 p-3 font-semibold">Estado</th>
                <th className="w-20 p-3 text-right font-semibold">Días</th>
                <th className="w-40 p-3 font-semibold">Entrega estimada</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-text-soft">Cargando…</td>
                </tr>
              )}
              {!loading && sortedOccupancy.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-text-soft">
                    No hay vehículos ocupando la playa.
                  </td>
                </tr>
              )}
              {sortedOccupancy.map((row) => (
                <tr key={`${row.kind}-${row.id}`} className="border-b border-line hover:bg-panel-alt">
                  <td data-primary className="p-3">
                    {/*
                      Va el número, no el id: la ruta /orden/:id resuelve con
                      fetchWorkOrderByNumber, así que ese parámetro lleva el
                      número aunque se llame id.
                    */}
                    <Link
                      to={`/orden/${row.number}`}
                      className="font-mono font-semibold text-accent-deep hover:underline"
                    >
                      {row.number}
                    </Link>
                    {row.otrosRegistros > 0 && (
                      <span
                        className="mt-0.5 block text-[10px] font-normal text-text-soft"
                        title="Este vehículo tiene más órdenes abiertas; se deduplica a un solo lugar en la playa"
                      >
                        +{row.otrosRegistros} registro{row.otrosRegistros === 1 ? '' : 's'} del mismo vehículo
                      </span>
                    )}
                  </td>
                  <td data-label="Cliente" className="p-3">{row.customerName}</td>
                  <td data-label="Vehículo" className="p-3 text-text-soft">{row.vehicleLabel}</td>
                  <td data-label="Tamaño" className="p-3 text-text-soft">{SIZE_CLASS_LABELS[row.sizeClass]}</td>
                  <td data-label="Estado" className="p-3">
                    <span
                      className="text-[10px] font-bold uppercase tracking-wider"
                      style={{ color: row.statusColor }}
                    >
                      {row.statusLabel}
                    </span>
                  </td>
                  <td data-label="Días" className="p-3 text-right font-mono text-text-soft">{row.daysInShop}</td>
                  <td data-label="Entrega estimada" className="p-3">
                    {row.kind === 'OT' ? (
                      <input
                        type="date"
                        value={row.estimatedDeliveryDate ?? ''}
                        onChange={(e) => handleDeliveryChange(row.id, e.target.value)}
                        className="rounded border border-line bg-panel px-1.5 py-0.5 text-[13px] focus:border-accent-deep focus:outline-none"
                      />
                    ) : (
                      <span className="text-text-faint">Sin OT todavía</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
