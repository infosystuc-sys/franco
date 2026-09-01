import { Trash2, Package } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import type { ExpenseConcept } from '@/src/lib/expenseConcepts';
import type { TaxRate } from '@/src/lib/taxRates';
import type { PurchaseLine } from '@/src/lib/purchases';

/**
 * Una fila de la tabla de renglones de un comprobante de compra, sea
 * artículo o concepto. Compartida entre la carga manual (PurchaseNew) y la
 * revisión de una factura leída por IA — misma edición en los dos lugares.
 */
export function PurchaseItemRow({
  line,
  idx,
  isArticles,
  concepts,
  vatRates,
  onPatch,
  onRemove,
}: {
  line: PurchaseLine;
  idx: number;
  isArticles: boolean;
  concepts: ExpenseConcept[];
  vatRates: TaxRate[];
  onPatch: (patch: Partial<PurchaseLine>) => void;
  onRemove: () => void;
}) {
  const net = line.quantity * line.unitPrice * (1 - (line.discountPercent || 0) / 100);

  return (
    <tr className={cn('h-9 border-b border-line', idx % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
      {isArticles ? (
        <>
          <td data-primary className="px-2 py-1 font-mono font-semibold text-text-soft">
            <span className="inline-flex items-center gap-1.5">
              <Package size={12} className="text-accent-deep" />
              {line.code}
            </span>
          </td>
          <td data-label="Descripción" className="px-2 py-1">{line.description}</td>
        </>
      ) : (
        <>
          <td data-label="Concepto" className="px-1 py-1">
            <select
              value={line.conceptId ?? ''}
              onChange={(e) => onPatch({ conceptId: e.target.value || null })}
              className="w-full bg-transparent px-1 py-1 text-[12px] focus:outline-none"
            >
              <option value="">— texto libre —</option>
              {concepts.map((concept) => (
                <option key={concept.id} value={concept.id}>{concept.name}</option>
              ))}
            </select>
          </td>
          <td data-label="Detalle" className="px-1 py-1">
            <input
              value={line.description}
              onChange={(e) => onPatch({ description: e.target.value })}
              placeholder="Detalle del gasto"
              className={cn(
                'w-full bg-transparent px-2 py-1',
                line.description.trim() === '' && 'bg-danger-soft'
              )}
            />
          </td>
        </>
      )}

      <td data-label="Cant." className="px-1 py-1">
        <input
          type="number" step="0.01" min="0"
          value={line.quantity}
          onChange={(e) => onPatch({ quantity: Number(e.target.value) })}
          className="w-full bg-transparent px-2 py-1 text-right"
        />
      </td>
      <td data-label="P. unitario" className="px-1 py-1">
        <input
          type="number" step="0.01" min="0"
          value={line.unitPrice}
          onChange={(e) => onPatch({ unitPrice: Number(e.target.value) })}
          className="w-full bg-transparent px-2 py-1 text-right"
        />
      </td>
      <td data-label="Bonif. %" className="px-1 py-1">
        <input
          type="number" step="0.01" min="0" max="100"
          value={line.discountPercent}
          onChange={(e) => onPatch({ discountPercent: Number(e.target.value) })}
          className="w-full bg-transparent px-2 py-1 text-right"
        />
      </td>
      <td data-label="IVA" className="px-1 py-1">
        <select
          value={line.vatRateId}
          onChange={(e) => onPatch({ vatRateId: e.target.value })}
          className={cn(
            'w-full bg-transparent px-1 py-1 text-[12px] focus:outline-none',
            !line.vatRateId && 'bg-danger-soft'
          )}
        >
          <option value="">— elegir —</option>
          {vatRates.map((rate) => (
            <option key={rate.id} value={rate.id}>{rate.name}</option>
          ))}
        </select>
      </td>
      <td data-label="Neto" className="px-2 py-1 text-right font-semibold">
        $ {formatMoney(net)}
      </td>
      <td className="px-1 py-1 text-center">
        <button
          type="button"
          onClick={onRemove}
          aria-label="Quitar renglón"
          className="text-text-soft transition-colors hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}
