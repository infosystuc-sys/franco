import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { cn, formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage, setEstimatedDeliveryDate } from '@/src/lib/workOrders';
import {
  fetchShopOccupancy,
  fetchWorkplaceCapacities,
  updateWorkplaceCapacity,
  type ShopOccupancyRow,
  type WorkplaceCapacity,
} from '@/src/lib/shopCapacity';

/**
 * "Cashflow de espacio": no es plata, es lugar físico. Cada sector tiene un
 * cupo fijo (Laboratorio 1, Laboratorio 2, Playa) y la ocupación sale de
 * contar las OT activas asignadas a un empleado de ese sector — no hay una
 * tabla de ocupación separada para no duplicar lo que ya vive en work_orders.
 *
 * La proyección de cuándo se libera un lugar depende de que el admin haya
 * cargado la entrega estimada en la OT: sin ese dato no hay forma confiable
 * de saber cuánto falta, así que esas órdenes quedan afuera de "Próximas
 * salidas" pero siguen contando en la ocupación actual.
 */
export function ShopCapacity() {
  const { role } = useAuth();
  const [capacities, setCapacities] = React.useState<WorkplaceCapacity[]>([]);
  const [occupancy, setOccupancy] = React.useState<ShopOccupancyRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [savingCapacity, setSavingCapacity] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [caps, rows] = await Promise.all([fetchWorkplaceCapacities(), fetchShopOccupancy()]);
      setCapacities(caps);
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

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleCapacityChange(workplace: string, value: string) {
    const capacity = Math.max(0, Number(value) || 0);
    setSavingCapacity(workplace);
    setError(null);
    try {
      await updateWorkplaceCapacity(workplace as any, capacity);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSavingCapacity(null);
    }
  }

  async function handleDeliveryChange(workOrderId: string, date: string) {
    setError(null);
    try {
      await setEstimatedDeliveryDate(workOrderId, date || null);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  const occupancyByWorkplace = React.useMemo(() => {
    const map = new Map<string, ShopOccupancyRow[]>();
    for (const row of occupancy) {
      if (!row.workplace) continue;
      map.set(row.workplace, [...(map.get(row.workplace) ?? []), row]);
    }
    return map;
  }, [occupancy]);

  const sinSector = occupancy.filter((r) => !r.workplace);

  const sortedOccupancy = React.useMemo(() => {
    return [...occupancy].sort((a, b) => {
      if (a.estimatedDeliveryDate && b.estimatedDeliveryDate) return a.estimatedDeliveryDate.localeCompare(b.estimatedDeliveryDate);
      if (a.estimatedDeliveryDate) return -1;
      if (b.estimatedDeliveryDate) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }, [occupancy]);

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = React.useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const row of occupancy) {
      if (!row.estimatedDeliveryDate || row.estimatedDeliveryDate < today || !row.workplace) continue;
      const bySector = map.get(row.estimatedDeliveryDate) ?? new Map<string, number>();
      bySector.set(row.workplace, (bySector.get(row.workplace) ?? 0) + 1);
      map.set(row.estimatedDeliveryDate, bySector);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 14);
  }, [occupancy, today]);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Disponibilidad del taller"
        subtitle="Ocupación actual por sector y próximas salidas, según las OT en curso."
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {capacities.map((cap) => {
          const count = occupancyByWorkplace.get(cap.workplace)?.length ?? 0;
          const over = count > cap.capacity;
          const full = count === cap.capacity && cap.capacity > 0;
          return (
            <Panel key={cap.workplace} className="p-4">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                {cap.workplace}
              </span>
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'font-display text-3xl font-medium',
                    over ? 'text-danger' : full ? 'text-state-wait' : 'text-state-done'
                  )}
                >
                  {loading ? '—' : count}
                </span>
                <span className="text-sm text-text-soft">
                  / <input
                    type="number"
                    min={0}
                    value={cap.capacity}
                    disabled={savingCapacity === cap.workplace}
                    onChange={(e) => handleCapacityChange(cap.workplace, e.target.value)}
                    className="w-14 rounded border border-line bg-panel px-1.5 py-0.5 text-sm focus:border-accent-deep focus:outline-none"
                  /> cupo
                </span>
              </div>
              {over && <span className="mt-1 block text-[11px] font-semibold text-danger">Por encima del cupo</span>}
            </Panel>
          );
        })}
      </div>

      {sinSector.length > 0 && (
        <div className="rounded-md border border-line bg-panel-alt px-4 py-3 text-sm text-text-soft">
          {sinSector.length} orden{sinSector.length === 1 ? '' : 'es'} activa{sinSector.length === 1 ? '' : 's'} sin
          empleado asignado (y por lo tanto sin sector conocido): {sinSector.map((r) => r.workOrderNumber).join(', ')}.
        </div>
      )}

      {upcoming.length > 0 && (
        <Panel className="p-4">
          <span className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            <CalendarClock size={14} /> Próximas salidas
          </span>
          <div className="space-y-1.5">
            {upcoming.map(([date, bySector]) => (
              <div key={date} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono font-semibold text-text">{formatDate(date)}</span>
                <span className="text-text-soft">
                  {[...bySector.entries()].map(([sector, n]) => `${sector} libera ${n}`).join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto overflow-y-hidden">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="w-28 p-3 font-semibold">N° OT</th>
                <th className="p-3 font-semibold">Cliente</th>
                <th className="p-3 font-semibold">Vehículo</th>
                <th className="w-36 p-3 font-semibold">Sector</th>
                <th className="w-32 p-3 font-semibold">Estado</th>
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
                  <td colSpan={7} className="p-8 text-center text-text-soft">No hay órdenes activas en este momento.</td>
                </tr>
              )}
              {sortedOccupancy.map((row) => (
                <tr key={row.workOrderId} className="border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt">
                  <td data-primary className="p-3">
                    <Link to={`/orden/${row.workOrderNumber}`} className="font-mono font-semibold text-text hover:text-accent-deep hover:underline">
                      {row.workOrderNumber}
                    </Link>
                  </td>
                  <td data-label="Cliente" className="p-3">{row.customerName}</td>
                  <td data-label="Vehículo" className="p-3">{row.vehicleLabel}</td>
                  <td data-label="Sector" className="p-3 text-text-soft">{row.workplace ?? '—'}</td>
                  <td data-label="Estado" className="p-3">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                      <span aria-hidden className="inline-block h-2 w-2" style={{ backgroundColor: row.statusColor }} />
                      {row.statusLabel}
                    </span>
                  </td>
                  <td data-label="Días" className="p-3 text-right font-mono text-text-soft">{row.daysInShop}</td>
                  <td data-label="Entrega estimada" className="p-3">
                    <input
                      type="date"
                      value={row.estimatedDeliveryDate ?? ''}
                      onChange={(e) => handleDeliveryChange(row.workOrderId, e.target.value)}
                      className="w-full rounded border border-line bg-panel px-2 py-1 text-xs focus:border-accent-deep focus:outline-none"
                    />
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
