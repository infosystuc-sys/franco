import React from 'react';
import { Plus, Pencil, Trash2, X, Search, UserCheck, Eye, EyeOff } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, Label, PageHeader, Panel, fieldClass } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  cambiarCargo,
  cambiarClave,
  createEmployee,
  darAcceso,
  deleteEmployee,
  describeEmployeeError,
  fetchEmployees,
  updateEmployee,
  CARGO_LABELS,
  CARGOS,
  type Cargo,
  type Employee,
  type EmployeeInput,
} from '@/src/lib/employees';

const EMPTY_FORM: EmployeeInput = { name: '', role: '', phone: '', active: true };

export function Users() {
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

  // El padrón de usuarios es gestión: solo admin. El operario ni ve el ítem
  // en el menú (Sidebar.tsx), pero si escribe la URL a mano lo mandamos afuera.
  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Usuarios"
        subtitle="Quién trabaja en el taller, quién tiene usuario para entrar al sistema y con qué cargo."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus size={16} /> Nuevo usuario
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
                <th className="p-3 font-semibold w-32">Cargo</th>
                <th className="p-3 font-semibold w-20 text-center">Estado</th>
                <th className="p-3 font-semibold w-24 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="p-6 text-center text-text-soft">Cargando...</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-text-soft">
                    {search ? 'Ningún usuario coincide con la búsqueda.' : 'No hay usuarios cargados.'}
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
                  <td data-label="Cargo" className="p-3 text-text-soft">
                    {employee.cargo ? CARGO_LABELS[employee.cargo] : <span className="text-text-faint">—</span>}
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
        <UserModal
          employee={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadEmployees();
          }}
          onAccessChanged={loadEmployees}
        />
      )}
    </div>
  );
}

function UserModal({
  employee,
  onClose,
  onSaved,
  onAccessChanged,
}: {
  employee: Employee | null;
  onClose: () => void;
  onSaved: () => void;
  onAccessChanged: () => void;
}) {
  const [form, setForm] = React.useState<EmployeeInput>(
    employee
      ? { name: employee.name, role: employee.role ?? '', phone: employee.phone ?? '', active: employee.active }
      : EMPTY_FORM
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // El vínculo puede crearse dentro de este mismo modal (botón "Dar acceso"),
  // así que se sigue localmente: esperar a que el padre recargue la lista y
  // vuelva a pasar `employee` dejaría el botón mostrando el estado viejo.
  const [hasAccess, setHasAccess] = React.useState(!!employee?.profileId);
  const [accessUsuario, setAccessUsuario] = React.useState('');
  const [accessPassword, setAccessPassword] = React.useState('');
  const [accessCargo, setAccessCargo] = React.useState<Cargo>('operario');
  // Oculta por defecto: el modal queda abierto un rato largo (el admin arma
  // el usuario, lo piensa, a veces lo corrige) y un taller no es una oficina
  // cerrada — cualquiera que pase por atrás o una captura de pantalla la vería.
  const [showAccessPassword, setShowAccessPassword] = React.useState(false);
  const [grantingAccess, setGrantingAccess] = React.useState(false);
  const [accessError, setAccessError] = React.useState<string | null>(null);
  const [accessSuccess, setAccessSuccess] = React.useState<string | null>(null);

  const [showChangePassword, setShowChangePassword] = React.useState(false);
  const [newPassword, setNewPassword] = React.useState('');
  const [showNewPassword, setShowNewPassword] = React.useState(false);
  const [changingPassword, setChangingPassword] = React.useState(false);
  const [changeError, setChangeError] = React.useState<string | null>(null);
  const [changeSuccess, setChangeSuccess] = React.useState(false);

  // El cargo actual se sigue localmente por el mismo motivo que hasAccess:
  // cambiarlo no espera a que el padre recargue la lista.
  const [cargo, setCargo] = React.useState<Cargo | null>(employee?.cargo ?? null);
  const [editingCargo, setEditingCargo] = React.useState(false);
  const [cargoDraft, setCargoDraft] = React.useState<Cargo>(employee?.cargo ?? 'operario');
  const [savingCargo, setSavingCargo] = React.useState(false);
  const [cargoError, setCargoError] = React.useState<string | null>(null);

  async function handleGrantAccess() {
    if (!employee) return;
    if (!accessUsuario.trim() || !accessPassword) {
      setAccessError('Completá usuario y contraseña.');
      return;
    }
    setGrantingAccess(true);
    setAccessError(null);
    try {
      await darAcceso(employee.id, accessUsuario.trim(), accessPassword, accessCargo);
      setHasAccess(true);
      setCargo(accessCargo);
      setAccessSuccess(`Acceso creado con usuario "${accessUsuario.trim()}". Comunicale la contraseña al empleado.`);
      onAccessChanged();
    } catch (err) {
      setAccessError(getErrorMessage(err));
    } finally {
      setGrantingAccess(false);
    }
  }

  async function handleChangePassword() {
    if (!employee) return;
    if (!newPassword) {
      setChangeError('Ingresá la contraseña nueva.');
      return;
    }
    setChangingPassword(true);
    setChangeError(null);
    try {
      await cambiarClave(employee.id, newPassword);
      setChangeSuccess(true);
      setNewPassword('');
      setShowChangePassword(false);
      onAccessChanged();
    } catch (err) {
      setChangeError(getErrorMessage(err));
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleChangeCargo() {
    if (!employee) return;
    setSavingCargo(true);
    setCargoError(null);
    try {
      await cambiarCargo(employee.id, cargoDraft);
      setCargo(cargoDraft);
      setEditingCargo(false);
      onAccessChanged();
    } catch (err) {
      setCargoError(getErrorMessage(err));
    } finally {
      setSavingCargo(false);
    }
  }

  function patch(changes: Partial<EmployeeInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre es obligatorio.');
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
            {employee ? 'Editar usuario' : 'Nuevo usuario'}
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
            <div className="border-t border-line pt-4 space-y-3">
              <span className="block font-semibold uppercase tracking-wider text-[11px] text-text-faint">
                Acceso al sistema
              </span>

              {!hasAccess && (
                <div className="space-y-2">
                  <p className="text-xs text-text-soft">
                    Sin acceso: este usuario no tiene con qué entrar a la app.
                  </p>
                  {accessError && (
                    <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{accessError}</div>
                  )}
                  {accessSuccess ? (
                    <p className="text-xs text-state-done">{accessSuccess}</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Label>
                          Usuario
                          <input
                            value={accessUsuario}
                            onChange={(e) => setAccessUsuario(e.target.value)}
                            className={fieldClass(false, 'font-normal normal-case')}
                            placeholder="carlos"
                          />
                        </Label>
                        <Label>
                          Contraseña inicial
                          <div className="relative">
                            <input
                              type={showAccessPassword ? 'text' : 'password'}
                              value={accessPassword}
                              onChange={(e) => setAccessPassword(e.target.value)}
                              className={fieldClass(false, 'font-normal normal-case pr-9')}
                              placeholder="Mínimo 6 caracteres"
                            />
                            <button
                              type="button"
                              onClick={() => setShowAccessPassword((v) => !v)}
                              title={showAccessPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-soft hover:text-text"
                            >
                              {showAccessPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                            </button>
                          </div>
                        </Label>
                      </div>
                      <Label>
                        Cargo
                        <select
                          value={accessCargo}
                          onChange={(e) => setAccessCargo(e.target.value as Cargo)}
                          className={fieldClass(false, 'font-normal normal-case bg-panel')}
                        >
                          {CARGOS.map((c) => (
                            <option key={c} value={c}>{CARGO_LABELS[c]}</option>
                          ))}
                        </select>
                        <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                          Administrativo y dueño acceden por igual a todo el sistema — el cargo es solo la etiqueta que se muestra.
                        </span>
                      </Label>
                      <button
                        type="button"
                        onClick={handleGrantAccess}
                        disabled={grantingAccess}
                        className="bg-accent text-accent-ink font-semibold text-[11px] uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
                      >
                        {grantingAccess ? 'Creando...' : 'Dar acceso'}
                      </button>
                    </>
                  )}
                </div>
              )}

              {hasAccess && (
                <div className="space-y-2">
                  <p className="text-xs text-text-soft">
                    {employee.email ?? 'Tiene usuario, pero no vemos su email desde acá.'}
                  </p>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-soft">Cargo:</span>
                    {!editingCargo ? (
                      <>
                        <span className="text-xs font-semibold text-text">
                          {cargo ? CARGO_LABELS[cargo] : '—'}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setCargoDraft(cargo ?? 'operario');
                            setCargoError(null);
                            setEditingCargo(true);
                          }}
                          className="text-[11px] font-semibold uppercase tracking-wider text-accent-deep hover:underline"
                        >
                          Cambiar
                        </button>
                      </>
                    ) : (
                      <>
                        <select
                          value={cargoDraft}
                          onChange={(e) => setCargoDraft(e.target.value as Cargo)}
                          className="border border-line bg-panel px-2 py-1 text-xs normal-case focus:border-accent-deep focus:outline-none"
                        >
                          {CARGOS.map((c) => (
                            <option key={c} value={c}>{CARGO_LABELS[c]}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={handleChangeCargo}
                          disabled={savingCargo}
                          className="text-[11px] font-semibold uppercase tracking-wider text-accent-deep hover:underline disabled:opacity-50"
                        >
                          {savingCargo ? 'Guardando...' : 'Guardar'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingCargo(false)}
                          className="text-[11px] font-semibold uppercase tracking-wider text-text-soft hover:text-text"
                        >
                          Cancelar
                        </button>
                      </>
                    )}
                  </div>
                  {cargoError && (
                    <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{cargoError}</div>
                  )}

                  {changeSuccess && <p className="text-xs text-state-done">Contraseña actualizada.</p>}
                  {!showChangePassword ? (
                    <button
                      type="button"
                      onClick={() => {
                        setShowChangePassword(true);
                        setChangeSuccess(false);
                      }}
                      className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt border border-line"
                    >
                      Cambiar contraseña
                    </button>
                  ) : (
                    <div className="space-y-2">
                      {changeError && (
                        <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{changeError}</div>
                      )}
                      <Label>
                        Contraseña nueva
                        <div className="relative">
                          <input
                            type={showNewPassword ? 'text' : 'password'}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className={fieldClass(false, 'font-normal normal-case pr-9')}
                            placeholder="Mínimo 6 caracteres"
                          />
                          <button
                            type="button"
                            onClick={() => setShowNewPassword((v) => !v)}
                            title={showNewPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-soft hover:text-text"
                          >
                            {showNewPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                      </Label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleChangePassword}
                          disabled={changingPassword}
                          className="bg-accent text-accent-ink font-semibold text-[11px] uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
                        >
                          {changingPassword ? 'Guardando...' : 'Guardar contraseña'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowChangePassword(false);
                            setChangeError(null);
                          }}
                          className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
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
