import React from 'react';
import { Plus, X, Pencil, Trash2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  createBank,
  deleteBank,
  describeBankError,
  fetchBanks,
  updateBank,
  type Bank,
  type BankInput,
} from '@/src/lib/banks';

const EMPTY_FORM: BankInput = { code: '', name: '', active: true };

/**
 * Catálogo de bancos: código (BCRA) + nombre, para las sugerencias al
 * cargar un cheque. Arranca vacío — se completa acá o al vuelo desde el
 * mismo campo de banco con "+ Agregar banco nuevo".
 */
export function Banks() {
  const { role } = useAuth();
  const [banks, setBanks] = React.useState<Bank[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Bank | null>(null);
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBanks(await fetchBanks());
    } catch (err) {
      setError(describeBankError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleDelete(bank: Bank) {
    if (!window.confirm(`¿Eliminar el banco "${bank.name}"?`)) return;
    setError(null);
    try {
      await deleteBank(bank.id);
      load();
    } catch (err) {
      setError(describeBankError(getErrorMessage(err)));
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Bancos"
        subtitle="Código y nombre, para sugerir al cargar un cheque."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Nuevo banco
          </Button>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading && <p className="text-center text-text-soft">Cargando bancos…</p>}

      {!loading && (
        <Panel className="overflow-x-auto overflow-y-hidden">
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="w-24 px-4 py-1">Código</th>
                <th className="px-3 py-1">Nombre</th>
                <th className="w-24 px-3 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {banks.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-text-soft">
                    No hay bancos cargados todavía.
                  </td>
                </tr>
              )}
              {banks.map((bank) => (
                <tr
                  key={bank.id}
                  className={cn(
                    'h-10 border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt',
                    !bank.active && 'text-text-faint'
                  )}
                >
                  <td data-primary className="px-4 py-1 font-mono font-semibold">{bank.code}</td>
                  <td data-label="Nombre" className="px-3 py-1">
                    {bank.name}
                    {!bank.active && (
                      <span className="ml-2 rounded bg-panel-head px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                        Inactivo
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1 text-right">
                    <button
                      onClick={() => setEditing(bank)}
                      aria-label={`Editar ${bank.name}`}
                      className="p-1 text-text-soft transition-colors hover:text-accent-deep"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => handleDelete(bank)}
                      aria-label={`Eliminar ${bank.name}`}
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
        <BankModal
          bank={editing}
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

function BankModal({
  bank,
  onClose,
  onSaved,
}: {
  bank: Bank | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<BankInput>(
    bank ? { code: bank.code, name: bank.name, active: bank.active } : EMPTY_FORM
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<BankInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) {
      setError('Código y nombre son obligatorios.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (bank) await updateBank(bank.id, form);
      else await createBank(form);
      onSaved();
    } catch (err) {
      setError(describeBankError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-sm flex-col rounded-lg bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-bold text-text">{bank ? 'Editar banco' : 'Nuevo banco'}</h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <label className={labelClass}>
            Código (BCRA) *
            <input
              value={form.code}
              onChange={(e) => patch({ code: e.target.value })}
              className={cn(inputClass, 'font-mono', form.code.trim() === '' && 'field-required')}
              placeholder="011"
            />
          </label>

          <label className={labelClass}>
            Nombre *
            <input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={cn(inputClass, form.name.trim() === '' && 'field-required')}
              placeholder="Banco de la Nación Argentina"
            />
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => patch({ active: e.target.checked })}
              className="h-4 w-4 accent-accent-deep"
            />
            Activo (aparece como sugerencia al cargar un cheque)
          </label>

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
