import React from 'react';
import { Link, Navigate } from 'react-router-dom';
import { CalendarClock, CalendarPlus, Pencil, Trash2 } from 'lucide-react';
import { cn, formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
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
import {
  deleteYardReservation,
  fetchYardReservations,
  reservasVigentes,
  reservaSigueVigente,
  type YardReservation,
} from '@/src/lib/yardReservations';
import { NewReservationModal } from '@/src/components/NewReservationModal';

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
  const [reservations, setReservations] = React.useState<YardReservation[]>([]);
  const [reservando, setReservando] = React.useState(false);
  // La reserva que se está editando. Null mientras se crea una nueva.
  const [editandoReserva, setEditandoReserva] = React.useState<YardReservation | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [celdas, rows, reservas] = await Promise.all([
        fetchYardCells(),
        fetchYardOccupancy(),
        fetchYardReservations(),
      ]);
      setCells(celdas);
      setOccupancy(rows);
      setReservations(reservas);
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
  /**
   * Las reservas de hoy que todavía reservan algo: dentro de su rango y sin que
   * el vehículo haya llegado. Una reserva cuyo camión ya está adentro no
   * descuenta — la celda la ocupa la orden.
   */
  const reservasDeHoy = React.useMemo(
    () => reservasVigentes(reservations, occupancy, hoy),
    [reservations, occupancy, hoy]
  );

  // Ocupación sola, para poder mostrarla separada de lo reservado.
  const soloOcupado = React.useMemo(() => disponibilidad(cells, occupancy), [cells, occupancy]);
  // Y el total, que es contra lo que de verdad se decide si entra otro.
  const disponible = React.useMemo(
    () => disponibilidad(cells, [...occupancy, ...reservasDeHoy]),
    [cells, occupancy, reservasDeHoy]
  );
  const libres = disponible.freeCells;
  const celdasOcupadasHoy = cells - soloOcupado.freeCells;
  const celdasReservadasHoy = soloOcupado.freeCells - disponible.freeCells;

  const linea = React.useMemo(
    () => proyectarDisponibilidad(cells, occupancy, 14, hoy, reservations),
    [cells, occupancy, hoy, reservations]
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

  async function handleDeleteReservation(r: YardReservation) {
    if (!window.confirm(`¿Borrar la reserva de ${r.licensePlate}? El lugar vuelve a quedar disponible.`)) return;
    setError(null);
    try {
      await deleteYardReservation(r.id);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
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
                Celdas
              </span>
              <span className={cn(
                'font-display text-2xl font-medium',
                libres < 0 ? 'text-danger' : 'text-text-soft'
              )}>
                {loading ? '—' : libres}
              </span>
              <span className="ml-1 text-sm text-text-soft">libres de {cells}</span>
              {/* Ocupado y reservado se muestran aparte: no es lo mismo tener
                  el camión que esperarlo, aunque las dos cosas tomen celda. */}
              {!loading && (
                <span className="mt-1 block text-[11px] text-text-soft">
                  {celdasOcupadasHoy} ocupada{celdasOcupadasHoy === 1 ? '' : 's'}
                  {celdasReservadasHoy > 0 && (
                    <> · <span className="font-semibold text-state-open">{celdasReservadasHoy} reservada{celdasReservadasHoy === 1 ? '' : 's'}</span></>
                  )}
                </span>
              )}
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
                {/* Cuánto de lo tomado ese día es reserva y no vehículo
                    presente. En azul, el color de las reservas en toda la
                    pantalla. */}
                {dia.reservedCells > 0 && (
                  <span className="mt-1 block border-t border-state-open/30 pt-1 text-[10px] font-semibold text-state-open">
                    {dia.reservedCells} res.
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </Panel>

      {/* ── Reservas ────────────────────────────────────────────────────
          Separadas de la ocupación y con su propio color: una reserva toma
          celda igual que un vehículo presente, pero no es lo mismo tener el
          camión que esperarlo, y quien mira la playa necesita distinguirlo. */}
      <Panel className="p-5">
        <SectionHeader
          title={<><CalendarPlus size={15} className="mr-1.5 inline-block align-[-2px] text-state-open" />Reservas</>}
          actions={
            <Button type="button" variant="ghost" onClick={() => setReservando(true)}>
              <CalendarPlus size={16} /> Reservar celda
            </Button>
          }
        />

        {reservations.length === 0 ? (
          <p className="text-xs text-text-soft">
            No hay reservas. Sirven para comprometer lugar antes de que el vehículo llegue.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {reservations.map((r) => {
              // Una reserva cuyo vehículo ya está adentro dejó de reservar: la
              // celda la ocupa la orden. Se muestra igual, apagada, para que se
              // entienda por qué dejó de descontar.
              const vigente = reservaSigueVigente(r, occupancy);
              const futura = r.startsOn > hoy;
              const vencida = r.endsOn < hoy;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                  <span
                    aria-hidden
                    className={cn('inline-block h-2 w-2 shrink-0', vigente && !vencida ? 'bg-state-open' : 'bg-state-idle')}
                  />
                  <span className="font-mono font-semibold text-text">{r.licensePlate}</span>
                  <span className="text-text-soft">{r.customerName}</span>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                    {SIZE_CLASS_LABELS[r.sizeClass]}
                  </span>
                  <span className="text-text-soft">
                    {formatDate(r.startsOn)} → {formatDate(r.endsOn)}
                  </span>
                  {!vigente && (
                    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-state-done">
                      Ya ingresó · no descuenta
                    </span>
                  )}
                  {vigente && vencida && (
                    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                      Vencida
                    </span>
                  )}
                  {vigente && futura && (
                    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-state-open">
                      Desde {formatDate(r.startsOn)}
                    </span>
                  )}
                  {r.notes && <span className="text-[11px] text-text-soft">{r.notes}</span>}
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => { setEditandoReserva(r); setReservando(true); }}
                      aria-label={`Modificar la reserva de ${r.licensePlate}`}
                      className="p-1 text-text-soft transition-colors hover:text-accent-deep"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteReservation(r)}
                      aria-label={`Borrar la reserva de ${r.licensePlate}`}
                      className="p-1 text-text-soft transition-colors hover:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
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

      {reservando && (
        <NewReservationModal
          reserva={editandoReserva}
          onClose={() => { setReservando(false); setEditandoReserva(null); }}
          onCreated={() => { setReservando(false); setEditandoReserva(null); load(); }}
        />
      )}
    </div>
  );
}
