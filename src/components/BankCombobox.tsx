import React from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { createBank, describeBankError, type Bank } from '@/src/lib/banks';

/**
 * Campo de banco con sugerencias por código o nombre. El valor que maneja
 * sigue siendo texto libre (lo que se guarda en el cheque, como siempre) —
 * el catálogo solo alimenta las sugerencias. Si el banco no está en el
 * catálogo, se puede agregar sin salir del campo: solo pide el código.
 */
export function BankCombobox({
  value,
  onChange,
  banks,
  onBankCreated,
  className,
  placeholder,
}: {
  value: string;
  onChange: (name: string) => void;
  banks: Bank[];
  onBankCreated: (bank: Bank) => void;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [addingCode, setAddingCode] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAddingCode(null);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, []);

  const query = value.trim().toLowerCase();
  const matches = (
    query
      ? banks.filter((b) => b.active && (b.code.toLowerCase().includes(query) || b.name.toLowerCase().includes(query)))
      : banks.filter((b) => b.active)
  ).slice(0, 8);
  const exactMatch = banks.some((b) => b.name.toLowerCase() === query);

  async function handleCreate() {
    if (!addingCode?.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const bank = await createBank({ code: addingCode, name: value.trim(), active: true });
      onBankCreated(bank);
      onChange(bank.name);
      setAddingCode(null);
      setOpen(false);
    } catch (err) {
      setCreateError(describeBankError(err instanceof Error ? err.message : 'No se pudo crear el banco.'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setAddingCode(null);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder ?? 'Banco'}
        className={className}
      />
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-line bg-panel shadow-lg">
          {matches.length === 0 && !query && (
            <p className="px-3 py-2 text-xs text-text-soft">No hay bancos cargados todavía.</p>
          )}
          {matches.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                onChange(b.name);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-panel-alt"
            >
              <span className="font-mono text-[11px] text-text-faint">{b.code}</span>
              <span>{b.name}</span>
            </button>
          ))}

          {query && !exactMatch && addingCode === null && (
            <button
              type="button"
              onClick={() => setAddingCode('')}
              className="flex w-full items-center gap-1.5 border-t border-line px-3 py-1.5 text-left text-sm text-accent-deep hover:bg-panel-alt"
            >
              <Plus size={13} /> Agregar "{value.trim()}" como banco nuevo
            </button>
          )}

          {addingCode !== null && (
            <div className="border-t border-line p-2">
              {createError && <p className="mb-1 text-[11px] text-danger">{createError}</p>}
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={addingCode}
                  onChange={(e) => setAddingCode(e.target.value)}
                  placeholder="Código BCRA"
                  className="w-24 rounded border border-line bg-panel px-2 py-1 text-xs font-mono focus:border-accent-deep focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={creating || !addingCode.trim()}
                  className={cn(
                    'rounded bg-accent px-2 py-1 text-[11px] font-semibold text-accent-ink',
                    (creating || !addingCode.trim()) && 'opacity-50'
                  )}
                >
                  {creating ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
