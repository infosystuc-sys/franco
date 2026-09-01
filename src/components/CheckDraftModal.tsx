import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Button, Panel } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { BankCombobox } from '@/src/components/BankCombobox';
import type { Bank } from '@/src/lib/banks';

export interface CheckDraft {
  amount: number;
  checkNumber: string;
  checkBank: string;
  checkDueDate: string;
}

interface DraftRow extends CheckDraft {
  rowKey: number;
}

let nextRowKey = 1;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Carga de uno o varios cheques a la vez, para cubrir un importe. Cada
 * cheque nuevo sugiere lo que falta cubrir después de descontar lo que ya
 * llevan los cheques cargados en esta misma tanda, no solo lo de afuera del
 * modal. Compartido entre Cobranzas (cheque como valor de cobro) y
 * Facturación (factura de contado cobrada con cheque).
 */
export function CheckDraftModal({
  remainingBase,
  banks,
  onBankCreated,
  onConfirm,
  onClose,
}: {
  remainingBase: number;
  banks: Bank[];
  onBankCreated: (bank: Bank) => void;
  onConfirm: (checks: CheckDraft[]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = React.useState<DraftRow[]>([
    { rowKey: nextRowKey++, amount: remainingBase, checkNumber: '', checkBank: '', checkDueDate: '' },
  ]);

  function patchRow(rowKey: number, patch: Partial<DraftRow>) {
    setRows((current) => current.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)));
  }

  function addRow() {
    const used = round2(rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0));
    setRows((current) => [
      ...current,
      {
        rowKey: nextRowKey++,
        amount: Math.max(0, round2(remainingBase - used)),
        checkNumber: '',
        checkBank: '',
        checkDueDate: '',
      },
    ]);
  }

  function removeRow(rowKey: number) {
    setRows((current) => current.filter((r) => r.rowKey !== rowKey));
  }

  const valid =
    rows.length > 0 &&
    rows.every((r) => r.checkNumber.trim() && r.checkBank.trim() && r.checkDueDate && Number(r.amount) > 0);

  function handleConfirm() {
    if (!valid) return;
    onConfirm(
      rows.map((r) => ({
        amount: Number(r.amount) || 0,
        checkNumber: r.checkNumber,
        checkBank: r.checkBank,
        checkDueDate: r.checkDueDate,
      }))
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Panel className="max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5">
        <h3 className="text-sm font-bold uppercase tracking-wider text-text">Cargar cheques</h3>

        <ul className="mt-3 space-y-3">
          {rows.map((row, idx) => (
            <li key={row.rowKey} className="border border-line bg-panel-alt p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-deep">
                  Cheque {idx + 1}
                </span>
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(row.rowKey)}
                    aria-label="Quitar cheque"
                    className="text-text-soft transition-colors hover:text-danger"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                <label className={labelClass}>
                  Número *
                  <input
                    value={row.checkNumber}
                    onChange={(e) => patchRow(row.rowKey, { checkNumber: e.target.value })}
                    className={cn(inputClass, 'font-mono', !row.checkNumber.trim() && 'field-required')}
                  />
                </label>
                <label className={labelClass}>
                  Banco *
                  <BankCombobox
                    value={row.checkBank}
                    onChange={(name) => patchRow(row.rowKey, { checkBank: name })}
                    banks={banks}
                    onBankCreated={onBankCreated}
                    className={cn(inputClass, !row.checkBank.trim() && 'field-required')}
                  />
                </label>
                <label className={labelClass}>
                  Fecha de cobro *
                  <input
                    type="date"
                    value={row.checkDueDate}
                    onChange={(e) => patchRow(row.rowKey, { checkDueDate: e.target.value })}
                    className={cn(inputClass, !row.checkDueDate && 'field-required')}
                  />
                </label>
                <label className={labelClass}>
                  Importe *
                  <input
                    type="number" step="0.01" min="0"
                    value={row.amount || ''}
                    onChange={(e) => patchRow(row.rowKey, { amount: Number(e.target.value) })}
                    className={cn(inputClass, 'font-mono', Number(row.amount) <= 0 && 'field-required')}
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>

        <Button type="button" variant="ghost" onClick={addRow} className="mt-3 px-3">
          <Plus size={15} /> Agregar otro cheque
        </Button>

        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="button" onClick={handleConfirm} disabled={!valid}>
            Confirmar {rows.length > 1 ? `(${rows.length} cheques)` : ''}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
