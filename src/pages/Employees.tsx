import React from 'react';
import { Plus, Pencil, Trash2, X, Search, UserCheck } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, Label, PageHeader, Panel, fieldClass } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  createEmployee,
  deleteEmployee,
  describeEmployeeError,
  fetchEmployees,
  updateEmployee,
  type Employee,
  type EmployeeInput,
} from '@/src/lib/employees';

const EMPTY_FORM: EmployeeInput = { name: '', role: '', phone: '', active: true };

export function Employees() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<Employee | 'new' | null>(null);

  const loadEmployees = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEmployees(await fetchEmployees());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadEmployees();
  }, [isAdmin, loadEmployees]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return employees;
    return employees.filter((e) =>
      [e.name, e.role, e.phone].filter(Boolean).some((field) => String(field).toLowerCase().includes(term))
    );
  }, [employees, search]);

  async function handleDelete(employee: Employee) {
    if (!window.confirm(`¿Eliminar a "${employee.name}"?`)) return;
    setError(null);
    try {
      await deleteEmployee(employee.id);
      loadEmployees();
    } catch (err) {
      setError(describeEmployeeError(getErrorMessage(err)));
    }
  }

  // El padrón de empleados es gestión: solo admin. El operario ni ve el ítem
  // en el menú (Sidebar.tsx), pero si escribe la URL a mano lo mandamos afuera.
  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Empleados"
        subtitle="Quién trabaja en el taller y quién de ellos tiene usuario para entrar al sistema."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus size={16} /> Nuevo empleado
          </Button>
        }
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}

      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, puesto, teléfono..."
          className="h-9 w-full border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      <Panel>
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="p-3 font-semibold">Nombre</th>
                <th className="p-3 font-semibold w-40">Puesto</th>
                <th className="p-3 font-semibold w-36">Teléfono</th>
                <th className="p-3 font-semibold w-52">Usuario</th>
                <th className="p-3 font-semibold w-20 text-center">Estado</th>
                <th className="p-3 font-semibold w-24 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="p-6 text-center text-text-soft">Cargando...</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-text-soft">
                    {search ? 'Ningún empleado coincide con la búsqueda.' : 'No hay empleados cargados.'}
                  </td>
                </tr>
              )}
              {filtered.map((employee) => (
                <tr key={employee.id} className={cn(
                  "border-b border-line hover:bg-panel-alt transition-colors",
                  !employee.active && "opacity-55"
                )}>
                  <td data-primary className="p-3 font-bold text-text">{employee.name}</td>
                  <td data-label="Puesto" className="p-3 text-text-soft">
                    {employee.role || <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Teléfono" className="p-3 font-mono text-[11px] text-text-soft">
                    {employee.phone || <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Usuario" className="p-3">
                    {employee.profileId ? (
                      <span className="inline-flex items-center gap-1.5 text-text-soft">
                        <UserCheck size={13} className="text-state-done" />
                        {employee.email ?? 'Con acceso al sistema'}
                      </span>
                    ) : (
                      // Estado válido, no un error: recibe órdenes sin entrar al sistema.
                      <span className="text-text-faint">Sin acceso</span>
                    )}
                  </td>
                  <td data-label="Estado" className="p-3 text-center">
                    <span className={cn(
                      "text-[10px] font-bold uppercase tracking-wider",
                      employee.active ? "text-state-done" : "text-text-faint"
                    )}>
                      {employee.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => setEditing(employee)} title="Editar" className="text-text-soft hover:text-text p-1">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(employee)} title="Eliminar" className="text-text-soft hover:text-danger p-1">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {editing && (
        <EmployeeModal
          employee={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadEmployees();
          }}
        />
      )}
    </div>
  );
}

function EmployeeModal({
  employee,
  onClose,
  onSaved,
}: {
  employee: Employee | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<EmployeeInput>(
    employee
      ? { name: employee.name, role: employee.role ?? '', phone: employee.phone ?? '', active: employee.active }
      : EMPTY_FORM
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<EmployeeInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre del empleado es obligatorio.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (employee) await updateEmployee(employee.id, form);
      else await createEmployee(form);
      onSaved();
    } catch (err) {
      setError(describeEmployeeError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">
            {employee ? 'Editar empleado' : 'Nuevo empleado'}
          </h2>
          <button onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto">
          {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

          <Label>
            Nombre
            <input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={fieldClass(true, 'font-normal normal-case')}
              placeholder="Carlos Méndez"
            />
          </Label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Label>
              Puesto
              <input
                value={form.role}
                onChange={(e) => patch({ role: e.target.value })}
                className={fieldClass(false, 'font-normal normal-case')}
                placeholder="Mecánico inyección"
              />
            </Label>
            <Label>
              Teléfono
              <input
                value={form.phone}
                onChange={(e) => patch({ phone: e.target.value })}
                className={fieldClass(false, 'font-normal normal-case')}
                placeholder="+54 9 11 5555-0001"
              />
            </Label>
          </div>

          <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => patch({ active: e.target.checked })}
              className="w-4 h-4 accent-accent-deep"
            />
            Activo (disponible para asignar a órdenes de trabajo)
          </label>

          {employee && (
            // Solo informativo: el acceso al sistema (crear el usuario y vincularlo)
            // no se gestiona desde acá, así que no hay campo para editarlo.
            <div className="border-t border-line pt-4 text-xs text-text-soft">
              <span className="font-semibold uppercase tracking-wider text-text-faint">Acceso al sistema: </span>
              {employee.profileId
                ? (employee.email ?? 'Tiene usuario, pero no vemos su email desde acá.')
                : 'Sin acceso: este empleado no tiene usuario para entrar a la app.'}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <button type="button" onClick={onClose} className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt">
              Cancelar
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
