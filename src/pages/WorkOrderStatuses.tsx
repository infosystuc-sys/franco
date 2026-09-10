import React from 'react';
import { Plus, X, Pencil, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import {
  createWorkOrderStatus,
  deleteWorkOrderStatus,
  describeWorkOrderStatusError,
  fetchWorkOrderStatuses,
  getErrorMessage,
  updateWorkOrderStatus,
  ordenarWorkOrderStatuses,
  type WorkOrderStatusDef,
  type WorkOrderStatusInput,
} from '@/src/lib/workOrders';

const EMPTY_FORM: WorkOrderStatusInput = {
  label: '',
  clientDescription: '',
  color: '#9a9a9a',
  sortOrder: 0,
  active: true,
  isInitial: false,
  isTerminal: false,
  notifiesClient: false,
  freesYard: false,
};

function statusToForm(status: WorkOrderStatusDef): WorkOrderStatusInput {
  return {
    label: status.label,
    clientDescription: status.clientDescription,
    color: status.color,
    sortOrder: status.sortOrder,
    active: status.active,
    isInitial: status.isInitial,
    isTerminal: status.isTerminal,
    notifiesClient: status.notifiesClient,
    freesYard: status.freesYard,
  };
}

/**
 * ABM de estados de OT. Reemplaza lo que antes era un enum fijo en el
 * código: acá el admin agrega, renombra, reordena, desactiva o marca el
 * comportamiento de cada estado (inicial, terminal, si avisa al cliente)
 * sin depender de un cambio de código para algo tan operativo como sumar
 * "En laboratorio" al flujo del taller.
 */
export function WorkOrderStatuses() {
  const { role } = useAuth();
  const [statuses, setStatuses] = React.useState<WorkOrderStatusDef[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<WorkOrderStatusDef | null>(null);
  const [creating, setCreating] = React.useState(false);
  // El "+" del menu entra con ?nuevo=1 y abre el alta directo. Se limpia el
  // parametro para que recargar la pagina no vuelva a abrir el modal.
  const [searchParams, setSearchParams] = useSearchParams();
  React.useEffect(() => {
    if (searchParams.get('nuevo') !== '1') return;
    setCreating(true);
    setSearchParams((actuales) => {
      const proximos = new URLSearchParams(actuales);
      proximos.delete('nuevo');
      return proximos;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  const [reordering, setReordering] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatuses(await fetchWorkOrderStatuses());
    } catch (err) {
      setError(describeWorkOrderStatusError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleDelete(status: WorkOrderStatusDef) {
    if (!window.confirm(`¿Eliminar el estado "${status.label}"?`)) return;
    setError(null);
    try {
      await deleteWorkOrderStatus(status.id);
      load();
    } catch (err) {
      setError(describeWorkOrderStatusError(getErrorMessage(err)));
    }
  }

  /**
   * Mover uno de lugar es reescribir la secuencia entera: se arma la lista
   * como debería quedar y la base la numera de una. Así nunca quedan dos
   * estados compartiendo posición.
   */
  async function handleMover(status: WorkOrderStatusDef, desplazamiento: -1 | 1) {
    const desde = statuses.findIndex((s) => s.id === status.id);
    const hasta = desde + desplazamiento;
    if (desde < 0 || hasta < 0 || hasta >= statuses.length) return;

    const orden = statuses.map((s) => s.id);
    [orden[desde], orden[hasta]] = [orden[hasta], orden[desde]];

    setReordering(true);
    setError(null);
    try {
      await ordenarWorkOrderStatuses(orden);
      await load();
    } catch (err) {
      setError(describeWorkOrderStatusError(getErrorMessage(err)));
    } finally {
      setReordering(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Estados de OT"
        subtitle="Los estados por los que pasa una orden de trabajo, en el orden en que se muestran."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Nuevo estado
          </Button>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading && <p className="text-center text-text-soft">Cargando estados…</p>}

      {!loading && (
        <Panel className="overflow-x-auto overflow-y-hidden">
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="w-16 px-3 py-1"></th>
                <th className="px-4 py-1">Estado</th>
                <th className="w-28 px-3 py-1">Inicial</th>
                <th className="w-28 px-3 py-1">Terminal</th>
                <th className="w-28 px-3 py-1">Libera playa</th>
                <th className="w-32 px-3 py-1">Avisa cliente</th>
                <th className="w-24 px-3 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {statuses.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-text-soft">
                    No hay estados cargados todavía.
                  </td>
                </tr>
              )}

              {statuses.map((status, idx) => (
                <tr
                  key={status.id}
                  className={cn(
                    'h-11 border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt',
                    !status.active && 'text-text-faint'
                  )}
                >
                  <td className="px-3 py-1">
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => handleMover(status, -1)}
                        disabled={idx === 0 || reordering}
                        aria-label={`Subir ${status.label}`}
                        className="p-1 text-text-soft transition-colors hover:text-accent-deep disabled:opacity-30"
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        onClick={() => handleMover(status, 1)}
                        disabled={idx === statuses.length - 1 || reordering}
                        aria-label={`Bajar ${status.label}`}
                        className="p-1 text-text-soft transition-colors hover:text-accent-deep disabled:opacity-30"
                      >
                        <ArrowDown size={14} />
                      </button>
                    </div>
                  </td>
                  <td data-primary className="px-4 py-1 font-semibold">
                    <span className="inline-flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: status.color }}
                      />
                      {status.label}
                      {!status.active && (
                        <span className="rounded bg-panel-head px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                          Inactivo
                        </span>
                      )}
                    </span>
                  </td>
                  <td data-label="Inicial" className="px-3 py-1 text-text-soft">{status.isInitial ? 'Sí' : '—'}</td>
                  <td data-label="Terminal" className="px-3 py-1 text-text-soft">{status.isTerminal ? 'Sí' : '—'}</td>
                  <td data-label="Libera playa" className="px-3 py-1 text-text-soft">{status.freesYard ? 'Sí' : '—'}</td>
                  <td data-label="Avisa cliente" className="px-3 py-1 text-text-soft">{status.notifiesClient ? 'Sí' : '—'}</td>
                  <td className="px-3 py-1 text-right">
                    <button
                      onClick={() => setEditing(status)}
                      aria-label={`Editar ${status.label}`}
                      className="p-1 text-text-soft transition-colors hover:text-accent-deep"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => handleDelete(status)}
                      aria-label={`Eliminar ${status.label}`}
                      className="ml-1 p-1 text-text-soft transition-colors hover:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {(creating || editing) && (
        <WorkOrderStatusModal
          status={editing}
          statuses={statuses}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function WorkOrderStatusModal({
  status,
  statuses,
  onClose,
  onSaved,
}: {
  status: WorkOrderStatusDef | null;
  /** La secuencia actual, para elegir dónde entra el nuevo. */
  statuses: WorkOrderStatusDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<WorkOrderStatusInput>(
    status ? statusToForm(status) : { ...EMPTY_FORM, sortOrder: statuses.length + 1 }
  );
  /**
   * Detrás de cuál va el estado nuevo. Cadena vacía = va primero.
   *
   * Se pregunta "después de cuál" y no "qué número": el número de posición no
   * significa nada para quien está definiendo el circuito, y obliga a contar.
   * En cambio "después de Cotizado" es exactamente como se piensa el paso.
   */
  const [despuesDe, setDespuesDe] = React.useState<string>(
    statuses.length > 0 ? statuses[statuses.length - 1].id : ''
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<WorkOrderStatusInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.label.trim()) {
      setError('El nombre es obligatorio.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (status) {
        await updateWorkOrderStatus(status.id, form);
      } else {
        const creado = await createWorkOrderStatus(form);
        // Nace último y después se lo ubica: insertarlo en el medio requiere
        // correr a todos los que siguen, y eso lo hace la base de una sola vez.
        const orden = statuses.map((s) => s.id).filter((id) => id !== creado.id);
        const posicion = despuesDe ? orden.indexOf(despuesDe) + 1 : 0;
        orden.splice(posicion, 0, creado.id);
        await ordenarWorkOrderStatuses(orden);
      }
      onSaved();
    } catch (err) {
      setError(describeWorkOrderStatusError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-bold text-text">
            {status ? 'Editar estado' : 'Nuevo estado'}
          </h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <label className={labelClass}>
              Nombre *
              <input
                value={form.label}
                onChange={(e) => patch({ label: e.target.value })}
                className={cn(inputClass, form.label.trim() === '' && 'field-required')}
                placeholder="En laboratorio"
              />
            </label>

            <label className={labelClass}>
              Color
              <input
                type="color"
                value={form.color}
                onChange={(e) => patch({ color: e.target.value })}
                className="h-9 w-14 cursor-pointer rounded-md border border-line bg-panel p-1"
              />
            </label>
          </div>

          {/* Solo al crear: mover uno existente se hace con las flechas de la
              lista, donde se ve la secuencia completa mientras se mueve. */}
          {!status && statuses.length > 0 && (
            <label className={labelClass}>
              Dónde va en la secuencia
              <select
                value={despuesDe}
                onChange={(e) => setDespuesDe(e.target.value)}
                className={cn(inputClass, 'bg-panel')}
              >
                <option value="">Primero, antes de {statuses[0].label}</option>
                {statuses.map((s) => (
                  <option key={s.id} value={s.id}>Después de {s.label}</option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] font-normal normal-case text-text-soft">
                Los que vengan después se corren solos.
              </span>
            </label>
          )}

          <label className={labelClass}>
            Descripción para el cliente
            <textarea
              value={form.clientDescription}
              onChange={(e) => patch({ clientDescription: e.target.value })}
              rows={2}
              className={cn(inputClass, 'resize-none')}
              placeholder="El componente está siendo revisado en laboratorio."
            />
            <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
              Se muestra en el portal público de seguimiento (/seguimiento/…), no en el panel interno.
            </span>
          </label>

          <div className="space-y-2 rounded-md border border-line bg-panel-alt p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => patch({ active: e.target.checked })}
                className="h-4 w-4 accent-accent-deep"
              />
              Activo (se ofrece al cambiar el estado de una OT)
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={form.isInitial}
                onChange={(e) => patch({ isInitial: e.target.checked })}
                className="h-4 w-4 accent-accent-deep"
              />
              Inicial (con este estado nace una OT nueva — a lo sumo uno)
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={form.isTerminal}
                onChange={(e) => patch({ isTerminal: e.target.checked })}
                className="h-4 w-4 accent-accent-deep"
              />
              Terminal (cierra la orden y habilita facturarla)
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={form.freesYard}
                onChange={(e) => patch({ freesYard: e.target.checked })}
                className="h-4 w-4 accent-accent-deep"
              />
              Libera la playa (el vehículo ya salió del taller)
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={form.notifiesClient}
                onChange={(e) => patch({ notifiesClient: e.target.checked })}
                className="h-4 w-4 accent-accent-deep"
              />
              Avisa al cliente (manda WhatsApp al llegar acá)
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
