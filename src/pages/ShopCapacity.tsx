import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { cn, formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage, setEstimatedDeliveryDate } from '@/src/lib/workOrders';
import { SIZE_CLASS_LABELS } from '@/src/lib/vehicles';
import { fetchCompanySettings } from '@/src/lib/companySettings';
import {
  fetchYardCapacities,
  fetchYardOccupancy,
  projectReleases,
  summarizeYard,
  tieneFechaFutura,
  type YardCapacityRow,
  type YardOccupant,
  type YardSizeSummary,
} from '@/src/lib/yardCapacity';

/**
 * Cuánto lugar queda en la playa, hoy y en los próximos días.
 *
 * Todo lo que está en el taller ocupa playa: cada ingreso sin OT y cada OT
 * cuyo estado no la libera. No se reparte por sector ni se deduce de quién
 * atiende el vehículo — dónde está parado un camión no depende de eso.
 *
 * La proyección depende de que la OT tenga cargada la entrega estimada: sin
 * ese dato no hay forma confiable de saber cuándo se libera el lugar, así que
 * esos vehículos quedan afuera de la proyección pero siguen ocupando.
 */
export function ShopCapacity() {
  const { role } = useAuth();
  const [capacities, setCapacities] = React.useState<YardCapacityRow[]>([]);
  const [occupancy, setOccupancy] = React.useState<YardOccupant[]>([]);
  const [graceDays, setGraceDays] = React.useState(2);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [caps, rows, settings] = await Promise.all([
        fetchYardCapacities(),
        fetchYardOccupancy(),
        fetchCompanySettings(),
      ]);
      setCapacities(caps);
      setOccupancy(rows);
      setGraceDays(settings?.yardPickupGraceDays ?? 2);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const summary: YardSizeSummary[] = React.useMemo(
    () => summarizeYard(capacities, occupancy),
    [capacities, occupancy]
  );

  const upcoming = React.useMemo(
    () => projectReleases(occupancy, graceDays),
    [occupancy, graceDays]
  );

  // Incluye tanto los que nunca tuvieron fecha estimada como los que la
  // tienen pero ya vencida: projectReleases tampoco puede proyectar esos
  // últimos, así que para esta pantalla son el mismo caso ("no hay una
  // fecha de salida a futuro"), aunque ocupen lugar igual que cualquier otro.
  const sinFechaFutura = occupancy.filter((row) => !tieneFechaFutura(row, graceDays));

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

  const sinConfigurar = capacities.every((c) => c.capacity === 0);

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
        subtitle="Cuánto lugar queda en la playa, según los ingresos y las OT en curso."
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {!loading && sinConfigurar && (
        <div className="rounded-md border border-line bg-panel-alt px-4 py-3 text-sm text-text-soft">
          El cupo de la playa todavía no está configurado. Cargalo en{' '}
          <Link to="/configuracion" className="font-semibold text-accent-deep hover:underline">Configuración</Link>{' '}
          para que esta pantalla pueda decir cuánto lugar queda.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {summary.map((size) => {
          // Cupo 0 es "no configurado", igual que en el alta de OT: no hay
          // cupo real contra el cual comparar, así que "excedido" no aplica
          // y no se puede afirmar que alguien se pasó de un límite que nadie
          // cargó todavía.
          const sinConfigurarEsteTamano = size.capacity === 0;
          const over = !sinConfigurarEsteTamano && size.occupied > size.capacity;
          const full = !sinConfigurarEsteTamano && size.occupied === size.capacity;
          return (
            <Panel key={size.sizeClass} className="p-4">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                {SIZE_CLASS_LABELS[size.sizeClass]}
              </span>
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'font-display text-3xl font-medium',
                    sinConfigurarEsteTamano
                      ? 'text-text'
                      : over
                        ? 'text-danger'
                        : full
                          ? 'text-state-wait'
                          : 'text-state-done'
                  )}
                >
                  {loading ? '—' : size.occupied}
                </span>
                {!sinConfigurarEsteTamano && (
                  <span className="text-sm text-text-soft">/ {size.capacity} cupo</span>
                )}
              </div>
              {!loading && sinConfigurarEsteTamano && (
                <span className="mt-1 block text-[11px] text-text-soft">Sin cupo configurado</span>
              )}
              {!loading && !sinConfigurarEsteTamano && !over && (
                <span className="mt-1 block text-[11px] text-text-soft">
                  Quedan {size.free} lugar{size.free === 1 ? '' : 'es'}
                </span>
              )}
              {over && (
                <span className="mt-1 block text-[11px] font-semibold text-danger">
                  {size.occupied - size.capacity} por encima del cupo
                </span>
              )}
            </Panel>
          );
        })}
      </div>

      {upcoming.length > 0 && (
        <Panel className="p-4">
          <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            <CalendarClock size={14} /> Próximas salidas
          </span>
          <p className="mb-3 text-[11px] text-text-soft">
            Proyección, no promesa: sale de la entrega estimada de cada OT más {graceDays} día
            {graceDays === 1 ? '' : 's'} de margen para el retiro.
          </p>
          <div className="space-y-1.5">
            {upcoming.map(({ date, bySize }) => (
              <div key={date} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono font-semibold text-text">{formatDate(date)}</span>
                <span className="text-text-soft">
                  {Object.entries(bySize)
                    .map(([size, n]) => `${SIZE_CLASS_LABELS[size as keyof typeof SIZE_CLASS_LABELS]}: libera ${n}`)
                    .join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {!loading && sinFechaFutura.length > 0 && (
        <div className="rounded-md border border-line bg-panel-alt px-4 py-3 text-sm text-text-soft">
          {sinFechaFutura.length} vehículo{sinFechaFutura.length === 1 ? '' : 's'} sin fecha de
          salida a futuro: no entran en la proyección, pero ocupan lugar igual.
        </div>
      )}

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
                      La OT se enlaza por número y el ingreso por id: la ruta
                      /orden/:id resuelve con fetchWorkOrderByNumber, así que
                      ese parámetro lleva el número aunque se llame id.
                    */}
                    <Link
                      to={row.kind === 'OT' ? `/orden/${row.number}` : `/ingresos/${row.id}`}
                      className="font-mono font-semibold text-accent-deep hover:underline"
                    >
                      {row.number}
                    </Link>
                    {row.otrosRegistros > 0 && (
                      <span
                        className="mt-0.5 block text-[10px] font-normal text-text-soft"
                        title="Este vehículo tiene más ingresos u OT abiertos; se deduplica a un solo lugar en la playa"
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
