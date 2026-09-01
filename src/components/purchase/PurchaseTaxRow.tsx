import { Trash2 } from 'lucide-react';
import { formatMoney } from '@/src/lib/utils';
import type { TaxRate } from '@/src/lib/taxRates';
import type { PurchaseFootTax } from '@/src/lib/purchases';

/** Un renglón del pie de percepciones/impuestos de un comprobante de compra. */
export function PurchaseTaxRow({
  tax,
  rate,
  suggested,
  onAmountChange,
  onRemove,
}: {
  tax: PurchaseFootTax;
  rate: TaxRate | undefined;
  suggested: number;
  onAmountChange: (amount: number) => void;
  onRemove: () => void;
}) {
  const edited = Math.abs(tax.amount - suggested) > 0.009;
  return (
    <li className="flex items-center gap-2 border border-line bg-panel-alt px-3 py-2">
      <span className="min-w-0 flex-1 text-xs">
        <span className="block truncate font-semibold text-text">{rate?.name}</span>
        <span className="text-[10px] text-text-soft">
          {rate?.rate}% s/ {rate?.base === 'TOTAL' ? 'total' : 'neto'}
          {edited && ` · calculado $ ${formatMoney(suggested)}`}
        </span>
      </span>
      <input
        type="number" step="0.01" min="0"
        value={tax.amount}
        onChange={(e) => onAmountChange(Number(e.target.value))}
        className="w-28 rounded border border-line bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Quitar impuesto"
        className="text-text-soft transition-colors hover:text-danger"
      >
        <Trash2 size={15} />
      </button>
    </li>
  );
}
