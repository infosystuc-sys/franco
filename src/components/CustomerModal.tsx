import React from 'react';
import { X, Truck, Plus, Trash2, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { getErrorMessage } from '@/src/lib/workOrders';
import { FiscalFields, labelClass, inputClass } from '@/src/components/FiscalFields';
import { CONDICION_VENTA_LABELS, type CondicionVenta } from '@/src/lib/invoices';
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
  type CustomerSectorInput,
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
    customer
      ? {
          ...fiscalEntityToForm(customer),
          condicionVenta: customer.condicionVenta ?? '',
          sectors: customer.sectors.map((s) => ({
            id: s.id,
            name: s.name,
            responsable: s.responsable ?? '',
            phone: s.phone ?? '',
            email: s.email ?? '',
          })),
        }
      : { ...EMPTY_FISCAL_FORM, condicionVenta: '', sectors: [] }
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
    // Un CUIT que no valida (o un DNI, o alguien que ARCA no tiene) no frena
    // el alta: el cliente igual existe y hay que poder atenderlo. Se avisa y se
    // pide confirmar, porque con ese dato no se le puede hacer Factura A.
    if (
      form.taxId.trim() !== '' &&
      !isValidCuit(form.taxId) &&
      !window.confirm(
        `El CUIT/CUIL "${form.taxId}" no es válido (o es un DNI).

` +
          'Se puede guardar igual, pero no sirve para Factura A ni para consultar ARCA. ¿Guardar el cliente así?'
      )
    ) {
      return;
    }
    const sectores = form.sectors ?? [];
    if (sectores.some((s) => s.name.trim() === '' && (s.responsable.trim() !== '' || s.phone.trim() !== '' || s.email.trim() !== ''))) {
      setError('Cada sector necesita un nombre (Compras, Administración…).');
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
      {/* Del mismo ancho que el ingreso de vehículos: son los mismos veinte
          campos, y en una ventana angosta obligaban a scrollear para llegar a
          los vehículos del cliente y a los botones. */}
      <div className="bg-panel w-full flex flex-col max-h-[92vh]">
        <div className="flex justify-between items-center px-6 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">
            {customer ? `Editar cliente` : 'Nuevo cliente'}
          </h2>
          <button onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
            {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

            {/* Con el ancho de sobra, los vehículos van al costado en vez de
                debajo: el ancho es lo que sobra y el alto lo que falta. */}
            <div className={cn('grid gap-6', customer && 'lg:grid-cols-3')}>
              <div className={cn(customer ? 'lg:col-span-2' : 'lg:max-w-4xl')}>
                <FiscalFields
                  form={form}
                  patch={patch}
                  nameLabel="Nombre / Denominación comercial"
                  namePlaceholder="Transportes G&M"
                  legalNamePlaceholder="Transportes G&M S.R.L."
                  activeLabel="Activo (disponible para nuevas órdenes de trabajo)"
                />

                {/* Va acá y no adentro de FiscalFields porque no es un dato
                    fiscal ni lo comparte el padrón de proveedores: es cómo
                    compra este cliente. */}
                <label className={cn(labelClass, 'mt-4 block max-w-sm')}>
                  Condición de venta habitual
                  <select
                    value={form.condicionVenta}
                    onChange={(e) =>
                      patch({ condicionVenta: e.target.value as CustomerInput['condicionVenta'] })
                    }
                    className={inputClass}
                  >
                    <option value="">Sin definir — se elige en cada factura</option>
                    {(Object.keys(CONDICION_VENTA_LABELS) as CondicionVenta[]).map((c) => (
                      <option key={c} value={c}>{CONDICION_VENTA_LABELS[c]}</option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[12px] font-normal normal-case text-text-soft">
                    Se propone al facturar y se puede cambiar ahí mismo.
                  </span>
                </label>

                <SectoresSection
                  sectores={form.sectors ?? []}
                  onChange={(sectors) => patch({ sectors })}
                />
              </div>

              {/* Vehículos: solo al editar, porque necesitan un cliente ya existente */}
              {customer && <VehiclesSection customer={customer} />}
            </div>
          </div>

          {/* Fuera del área que scrollea: guardar y cerrar tienen que estar a
              mano sin importar cuánto se haya bajado. */}
          <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
            <button type="button" onClick={onClose} className="px-4 py-2 text-[13px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt">
              Cerrar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-accent text-accent-ink font-semibold text-[13px] uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
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
    <div className="space-y-3 border-t border-line pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
          <Truck size={14} /> Vehículos / Equipos
        </h3>
        <Link to="/vehiculos" className="text-[13px] font-bold uppercase tracking-wider text-accent-deep hover:underline">
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
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-faint">Inactivo</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Los sectores del cliente, cada uno con su teléfono y mail. Si el cliente
 * tiene sectores, al asignarlo a una OT, cotización o factura se puede elegir
 * a cuál va, y los envíos salen a ese contacto.
 */
function SectoresSection({
  sectores,
  onChange,
}: {
  sectores: CustomerSectorInput[];
  onChange: (sectores: CustomerSectorInput[]) => void;
}) {
  function cambiar(i: number, cambios: Partial<CustomerSectorInput>) {
    onChange(sectores.map((s, j) => (j === i ? { ...s, ...cambios } : s)));
  }

  return (
    <div className="mt-6 space-y-3 border-t border-line pt-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-bold uppercase tracking-wider text-accent-deep">
          <Users size={14} /> Sectores
        </h3>
        <button
          type="button"
          onClick={() => onChange([...sectores, { name: '', responsable: '', phone: '', email: '' }])}
          className="inline-flex items-center gap-1 text-[13px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
        >
          <Plus size={14} /> Agregar sector
        </button>
      </div>

      {sectores.length === 0 ? (
        <p className="text-xs text-text-soft">
          Sin sectores: los comprobantes se mandan al teléfono y mail generales del cliente.
          Agregá uno (Compras, Administración, Taller…) si cada área tiene su propio contacto.
        </p>
      ) : (
        <div className="space-y-2">
          {sectores.map((s, i) => (
            <div key={s.id ?? `nuevo-${i}`} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.2fr_1fr_1.4fr_auto] sm:items-end">
              <label className={labelClass}>
                Sector
                <input
                  value={s.name}
                  onChange={(e) => cambiar(i, { name: e.target.value })}
                  placeholder="Compras"
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                Responsable
                <input
                  value={s.responsable}
                  onChange={(e) => cambiar(i, { responsable: e.target.value })}
                  placeholder="Juan Pérez"
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                Teléfono
                <input
                  value={s.phone}
                  onChange={(e) => cambiar(i, { phone: e.target.value })}
                  placeholder="381 4123456"
                  className={inputClass}
                />
              </label>
              <label className={labelClass}>
                Mail
                <input
                  type="email"
                  value={s.email}
                  onChange={(e) => cambiar(i, { email: e.target.value })}
                  placeholder="compras@empresa.com"
                  className={inputClass}
                />
              </label>
              <button
                type="button"
                onClick={() => onChange(sectores.filter((_, j) => j !== i))}
                title="Quitar el sector"
                aria-label="Quitar el sector"
                className="mb-1 flex h-9 w-9 items-center justify-center text-text-soft hover:text-danger"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
