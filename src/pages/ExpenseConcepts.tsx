import React from 'react';
import { Plus, Pencil, Trash2, Check, Search } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  createExpenseConcept,
  deleteExpenseConcept,
  describeExpenseConceptError,
  fetchExpenseConcepts,
  updateExpenseConcept,
  type ExpenseConcept,
} from '@/src/lib/expenseConcepts';

/**
 * Conceptos de gasto. El padrón es de una sola columna, así que se edita en
 * la propia fila en vez de abrir un modal: para un nombre y un tilde, la
 * ventana emergente es más ceremonia que el dato que guarda.
 */
export function ExpenseConcepts() {
  const { role } = useAuth();
  const [concepts, setConcepts] = React.useState<ExpenseConcept[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConcepts(await fetchExpenseConcepts());
    } catch (err) {
      setError(describeExpenseConceptError(getErrorMessage(err), ''));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return concepts;
    return concepts.filter((concept) => concept.name.toLowerCase().includes(term));
  }, [concepts, search]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function run(action: () => Promise<unknown>, name: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(describeExpenseConceptError(getErrorMessage(err), name));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    await run(() => createExpenseConcept({ name, active: true }), name);
    setNewName('');
  }

  async function handleRename(concept: ExpenseConcept) {
    const name = draft.trim();
    setEditingId(null);
    if (!name || name === concept.name) return;
    await run(() => updateExpenseConcept(concept.id, { name, active: concept.active }), name);
  }

  async function handleToggleActive(concept: ExpenseConcept) {
    await run(
      () => updateExpenseConcept(concept.id, { name: concept.name, active: !concept.active }),
      concept.name
    );
  }

  async function handleDelete(concept: ExpenseConcept) {
    if (!window.confirm(`¿Eliminar el concepto "${concept.name}"?`)) return;
    await run(() => deleteExpenseConcept(concept.id), concept.name);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Conceptos de gasto"
        subtitle="Clasifican las compras que no llevan artículos: fletes, servicios, honorarios."
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="p-4">
        <form onSubmit={handleCreate} className="flex flex-col gap-2 sm:flex-row">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nombre del concepto nuevo…"
            className="flex-1 rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
          />
          <Button type="submit" disabled={busy || newName.trim() === ''}>
            <Plus size={16} /> Agregar
          </Button>
        </form>
      </Panel>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar concepto…"
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none sm:w-72"
        />
      </div>

      <Panel className="overflow-x-auto overflow-y-hidden">
        <table className="table-stack w-full text-left text-[13px]">
          <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-4 py-1">Concepto</th>
              <th className="px-3 py-1 w-24">Estado</th>
              <th className="px-3 py-1 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-text-soft">Cargando conceptos…</td>
              </tr>
            )}

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-text-soft">
                  {concepts.length === 0
                    ? 'No hay conceptos cargados.'
                    : 'Ningún concepto coincide con la búsqueda.'}
                </td>
              </tr>
            )}

            {!loading &&
              filtered.map((concept) => (
                <tr
                  key={concept.id}
                  className={cn(
                    'h-10 border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt',
                    !concept.active && 'text-text-faint'
                  )}
                >
                  <td data-primary className="px-4 py-1">
                    {editingId === concept.id ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => handleRename(concept)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(concept);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="w-full border border-accent-deep bg-panel px-2 py-1 text-sm focus:outline-none"
                      />
                    ) : (
                      <span className="font-semibold">{concept.name}</span>
                    )}
                  </td>

                  <td data-label="Estado" className="px-3 py-1">
                    <button
                      onClick={() => handleToggleActive(concept)}
                      disabled={busy}
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors',
                        concept.active
                          ? 'bg-green-100 text-green-700 hover:bg-green-200'
                          : 'bg-panel-head text-text-soft hover:bg-line'
                      )}
                    >
                      {concept.active ? 'Activo' : 'Inactivo'}
                    </button>
                  </td>

                  <td className="px-3 py-1 text-right">
                    {editingId === concept.id ? (
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleRename(concept)}
                        aria-label="Confirmar"
                        className="p-1 text-text-soft transition-colors hover:text-state-done"
                      >
                        <Check size={15} />
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingId(concept.id);
                          setDraft(concept.name);
                        }}
                        aria-label={`Renombrar ${concept.name}`}
                        className="p-1 text-text-soft transition-colors hover:text-accent-deep"
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(concept)}
                      aria-label={`Eliminar ${concept.name}`}
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

      <p className="text-xs text-text-soft">
        Un concepto que ya se usó en un comprobante no se puede eliminar: la
        base lo rechaza para no romper el gasto ya registrado. Desactivalo y
        deja de ofrecerse en los comprobantes nuevos.
      </p>
    </div>
  );
}
