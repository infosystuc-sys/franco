import React from 'react';
import { X, CalendarPlus } from 'lucide-react';
import { Button, Label, fieldClass } from '@/src/components/ui';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  fetchVehicles,
  SIZE_CLASS_LABELS,
  SIZE_CLASSES,
  type SizeClass,
  type Vehicle,
} from '@/src/lib/vehicles';
import {
  createYardReservation,
  normalizarPatente,
  type YardReservationInput,
} from '@/src/lib/yardReservations';

const HOY = () => new Date().toISOString().slice(0, 10);

/**
 * Reservar una celda.
 *
 * La patente se escribe a mano a propósito: el cliente reserva por teléfono
 * para un camión que a veces nunca vino al taller, y obligar a cargar la ficha
 * completa en ese momento haría que la reserva no se cargue. Si la patente ya
 * existe, se traen su cliente y su tamaño para no contradecir la ficha.
 */
export function NewReservationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reconocido, setReconocido] = React.useState<Vehicle | null>(null);

  const [form, setForm] = React.useState<YardReservationInput>({
    customerId: '',
    licensePlate: '',
    sizeClass: '',
    startsOn: HOY(),
    endsOn: HOY(),
    notes: '',
  });

  React.useEffect(() => {
    let cancelado = false;
    fetchCustomers(true)
      .then((d) => !cancelado && setCustomers(d))
      .catch((err) => !cancelado && setError(getErrorMessage(err)));
    // El padrón es ayuda: si falla, la reserva se puede cargar a mano igual.
    fetchVehicles().then((d) => !cancelado && setVehicles(d)).catch(() => {});
    return () => { cancelado = true; };
  }, []);

  function patch(cambios: Partial<YardReservationInput>) {
    setForm((actual) => ({ ...actual, ...cambios }));
  }

  /**
   * Si la patente coincide con una ficha cargada, se completan cliente y
   * tamaño. Es el mismo criterio que el ingreso de vehículos: la patente
   * identifica al equipo, y el equipo ya sabe de quién es y cuánto ocupa.
   */
  function handlePatente(valor: string) {
    const patente = valor.toUpperCase();
    patch({ licensePlate: patente });

    const limpia = normalizarPatente(patente);
    if (limpia.length < 5) {
      if (reconocido) setReconocido(null);
      return;
    }
    const encontrado = vehicles.find((v) => normalizarPatente(v.licensePlate) === limpia);
    if (!encontrado) {
      if (reconocido) setReconocido(null);
      return;
    }
    if (reconocido?.id === encontrado.id) return;

    setReconocido(encontrado);
    patch({ customerId: encontrado.customerId, sizeClass: encontrado.sizeClass });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customerId) {
      setError('Elegí el cliente que reserva.');
      return;
    }
    if (!normalizarPatente(form.licensePlate)) {
      setError('Poné la patente del vehículo que va a ocupar la celda.');
      return;
    }
    if (!form.sizeClass) {
      setError('Elegí el tamaño: de eso depende cuánta celda se está comprometiendo.');
      return;
    }
    // La base también lo rechaza, pero acá el mensaje explica qué pasó en vez
    // de mostrar el nombre de una restricción.
    if (form.endsOn < form.startsOn) {
      setError('La fecha de fin no puede ser anterior a la de inicio.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createYardReservation(form);
      onCreated();
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col border border-line-strong bg-panel">
        <div className="flex items-center justify-between border-b border-line bg-panel-head px-5 py-3">
          <h2 className="font-display text-xl uppercase tracking-[0.04em] text-text-faint">
            Reservar celda
          </h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          {reconocido && (
            <p className="border border-state-open/40 bg-state-open/10 px-3 py-2 text-[11px] text-state-open">
              Esa patente ya está cargada: se completaron el cliente y el tamaño con los datos de su ficha.
            </p>
          )}

          <Label>
            Patente
            <input
              value={form.licensePlate}
              onChange={(e) => handlePatente(e.target.value)}
              className={fieldClass(true, 'font-mono uppercase')}
              placeholder="ABC-123"
            />
            <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
              Si el vehículo todavía no está cargado, se escribe igual.
            </span>
          </Label>

          <Label>
            Cliente
            <select
              value={form.customerId}
              onChange={(e) => patch({ customerId: e.target.value })}
              className={fieldClass(true, 'font-normal normal-case')}
            >
              <option value="">Elegí un cliente…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.taxId ? ` — ${formatCuit(c.taxId)}` : ''}
                </option>
              ))}
            </select>
          </Label>

          <Label>
            Tamaño
            <select
              value={form.sizeClass}
              onChange={(e) => patch({ sizeClass: e.target.value as SizeClass })}
              className={fieldClass(true, 'font-normal normal-case bg-panel')}
            >
              <option value="">Elegí el tamaño…</option>
              {SIZE_CLASSES.map((s) => (
                <option key={s} value={s}>{SIZE_CLASS_LABELS[s]}</option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
              Un grande toma una celda entera; tres medianos comparten una.
            </span>
          </Label>

          <div className="grid grid-cols-2 gap-4">
            <Label>
              Desde
              <input
                type="date"
                value={form.startsOn}
                onChange={(e) => patch({ startsOn: e.target.value })}
                className={fieldClass(true, 'font-normal normal-case')}
              />
            </Label>
            <Label>
              Hasta
              <input
                type="date"
                value={form.endsOn}
                min={form.startsOn}
                onChange={(e) => patch({ endsOn: e.target.value })}
                className={fieldClass(true, 'font-normal normal-case')}
              />
            </Label>
          </div>

          <Label>
            Observaciones
            <textarea
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              rows={2}
              placeholder="Quién avisó, por qué trabajo viene…"
              className={fieldClass(false, 'font-normal normal-case resize-y')}
            />
          </Label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              <CalendarPlus size={16} /> {saving ? 'Reservando…' : 'Reservar'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
