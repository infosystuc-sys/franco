import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/src/components/ui';
import {
  deleteWorkOrders,
  fetchDeletionImpact,
  getErrorMessage,
  type WorkOrderDeletionImpact,
  type WorkOrderDeletionResult,
} from '@/src/lib/workOrders';

export interface DeletableWorkOrder {
  id: string;
  number: string;
  customerName: string;
}

/**
 * Confirmación del borrado de órdenes de trabajo.
 *
 * No es un "¿estás seguro?": el alcance cambia por fila —una arrastra su
 * cotización, otra ni se puede borrar porque está facturada— y una
 * confirmación que no lo distingue obliga a aceptar a ciegas. Así que primero
 * consulta qué cuelga de cada una y lo muestra desglosado.
 *
 * Las facturadas se listan aparte en vez de trabar el lote entero: si elegiste
 * seis y una está facturada, borrás las cinco sin volver a la tabla a
 * desmarcarla.
 */
export function DeleteWorkOrdersModal({
  orders,
  onClose,
  onDeleted,
}: {
  orders: DeletableWorkOrder[];
  onClose: () => void;
  onDeleted: (results: WorkOrderDeletionResult[]) => void;
}) {
  const [impact, setImpact] = React.useState<WorkOrderDeletionImpact[] | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchDeletionImpact(orders.map((o) => o.id))
      .then((data) => !cancelled && setImpact(data))
      .catch((err) => !cancelled && setError(getErrorMessage(err)));
    return () => {
      cancelled = true;
    };
    // Las órdenes se eligen antes de abrir el modal y no cambian mientras está
    // abierto; recalcular por identidad del array solo repetiría la consulta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deQue = React.useCallback(
    (id: string) => impact?.find((i) => i.workOrderId === id) ?? null,
    [impact]
  );

  const borrables = impact ? orders.filter((o) => !deQue(o.id)?.invoiceNumber) : [];
  const retenidas = impact ? orders.filter((o) => deQue(o.id)?.invoiceNumber) : [];

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      // Se mandan solo las borrables: las facturadas ya sabemos que la base va
      // a rechazarlas, y pedirlas igual solo llenaría el resultado de ruido.
      const results = await deleteWorkOrders(borrables.map((o) => o.id));
      onDeleted(results);
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col border border-line-strong bg-panel">
        <div className="flex items-center justify-between border-b border-line bg-panel-head px-5 py-3">
          <h2 className="font-display text-xl uppercase tracking-[0.04em] text-text-faint">
            Eliminar órdenes
          </h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5 text-sm">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          {!impact && !error && <p className="text-text-soft">Revisando qué cuelga de cada orden…</p>}

          {impact && borrables.length > 0 && (
            <div className="space-y-2">
              <p className="text-text">
                Vas a eliminar {borrables.length === 1 ? 'esta orden' : `estas ${borrables.length} órdenes`}:
              </p>
              <ul className="space-y-1">
                {borrables.map((order) => {
                  const cotizacion = deQue(order.id)?.quotationNumber;
                  return (
                    <li key={order.id} className="border-l-2 border-line-strong pl-3">
                      <span className="font-mono font-semibold">{order.number}</span>
                      <span className="text-text-soft"> — {order.customerName}</span>
                      {cotizacion && (
                        <span className="block text-[11px] text-state-wait">
                          se borra también la cotización {cotizacion}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {impact && retenidas.length > 0 && (
            <div className="space-y-2 border border-line bg-panel-alt p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <AlertTriangle size={13} /> No se pueden eliminar
              </p>
              <ul className="space-y-1">
                {retenidas.map((order) => (
                  <li key={order.id}>
                    <span className="font-mono font-semibold">{order.number}</span>
                    <span className="text-text-soft"> — {deQue(order.id)?.invoiceNumber} la retiene</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-text-soft">
                Una factura es un comprobante fiscal: mientras exista, su orden queda.
              </p>
            </div>
          )}

          {impact && borrables.length > 0 && (
            <p className="text-[11px] text-text-soft">
              Se van sus renglones, historial, etapas, piezas recibidas y fotos. El stock que hayan
              descontado vuelve al inventario. No se puede deshacer.
            </p>
          )}

          {impact && borrables.length === 0 && (
            <p className="text-text-soft">No queda ninguna orden que se pueda eliminar.</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={deleting || !impact || borrables.length === 0}
            onClick={handleDelete}
          >
            {deleting
              ? 'Eliminando…'
              : borrables.length === 1
                ? 'Eliminar la orden'
                : `Eliminar las ${borrables.length}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
