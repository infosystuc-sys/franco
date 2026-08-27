import React from 'react';
import { X, Truck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { getErrorMessage } from '@/src/lib/workOrders';
import { FiscalFields } from '@/src/components/FiscalFields';
import {
  EMPTY_FISCAL_FORM,
  fiscalEntityToForm,
  isValidCuit,
} from '@/src/lib/fiscal';
import {
  createCustomer,
  describeCustomerError,
  updateCustomer,
  type Customer,
  type CustomerInput,
} from '@/src/lib/customers';

/**
 * Alta/edición de cliente. Compartido entre la pantalla de Clientes y el
 * ingreso de vehículos (que necesita poder cargar un cliente nuevo sin salir
 * de esa pantalla).
 */
export function CustomerModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: Customer | null;
  onClose: () => void;
  onSaved: (customer: Customer) => void;
}) {
  const [form, setForm] = React.useState<CustomerInput>(
    customer ? fiscalEntityToForm(customer) : EMPTY_FISCAL_FORM
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<CustomerInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre del cliente es obligatorio.');
      return;
    }
    if (form.taxId.trim() !== '' && !isValidCuit(form.taxId)) {
      setError('El CUIT/CUIL ingresado no es válido.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = customer ? await updateCustomer(customer.id, form) : await createCustomer(form);
      onSaved(saved);
    } catch (err) {
      setError(describeCustomerError(getErrorMessage(err), form.name));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">
            {customer ? `Editar cliente` : 'Nuevo cliente'}
          </h2>
          <button onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5 overflow-y-auto">
          {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

          <FiscalFields
            form={form}
            patch={patch}
            nameLabel="Nombre / Denominación comercial"
            namePlaceholder="Transportes G&M"
            legalNamePlaceholder="Transportes G&M S.R.L."
            activeLabel="Activo (disponible para nuevas órdenes de trabajo)"
          />

          {/* Vehículos: solo al editar, porque necesitan un cliente ya existente */}
          {customer && <VehiclesSection customer={customer} />}

          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <button type="button" onClick={onClose} className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt">
              Cerrar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-accent text-accent-ink font-semibold text-[11px] uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
            >
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Listado de solo lectura: la ficha técnica completa se administra en el ABM
 * de Vehículos, así que acá solo se muestran y se enlaza a esa sección.
 */
function VehiclesSection({ customer }: { customer: Customer }) {
  return (
    <div className="border-t border-line pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
          <Truck size={14} /> Vehículos / Equipos
        </h3>
        <Link to="/vehiculos" className="text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline">
          Administrar →
        </Link>
      </div>

      {customer.vehicles.length === 0 ? (
        <p className="text-xs text-text-soft">
          Este cliente todavía no tiene vehículos cargados. Agregalos desde la sección Vehículos.
        </p>
      ) : (
        <ul className="space-y-1">
          {customer.vehicles.map((vehicle) => (
            <li key={vehicle.id} className={cn(
              "flex items-center justify-between bg-panel-alt border border-line px-3 py-2 text-sm",
              !vehicle.active && "opacity-55"
            )}>
              <span>
                <span className="font-semibold text-text">
                  {[vehicle.brand, vehicle.model].filter(Boolean).join(' ')}
                </span>
                {vehicle.licensePlate && <span className="ml-2 font-mono text-xs text-text-soft">{vehicle.licensePlate}</span>}
                {vehicle.year && <span className="ml-2 text-xs text-text-soft">({vehicle.year})</span>}
              </span>
              {!vehicle.active && (
                <span className="text-[9px] font-bold uppercase tracking-wider text-text-faint">Inactivo</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
