import { AlertTriangle, Check } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import type { PurchaseTotals } from '@/src/lib/purchases';

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-text-faint' : 'text-text-soft'}>{label}</dt>
      <dd className={cn('font-mono', muted ? 'text-text-faint' : 'text-text')}>
        {value < 0 ? '−' : ''}$ {formatMoney(Math.abs(value))}
      </dd>
    </div>
  );
}

/**
 * Panel de totales de un comprobante de compra: bonificación general, el
 * desglose por alícuota, y el control cruzado contra el total impreso en
 * el papel. Compartido entre la carga manual y la revisión de IA.
 */
export function PurchaseTotalsSummary({
  totals,
  generalDiscount,
  onGeneralDiscountChange,
  declaredTotal,
  onDeclaredTotalChange,
}: {
  totals: PurchaseTotals;
  generalDiscount: string;
  onGeneralDiscountChange: (value: string) => void;
  declaredTotal: string;
  onDeclaredTotalChange: (value: string) => void;
}) {
  const declared = Number(declaredTotal);
  const declaredDiff =
    declaredTotal.trim() === '' || !Number.isFinite(declared)
      ? null
      : Math.round((declared - totals.total) * 100) / 100;

  return (
    <>
      <label className={cn(labelClass, 'mb-4 block sm:w-1/2')}>
        Bonificación general %
        <input
          type="number" step="0.01" min="0" max="100"
          value={generalDiscount}
          onChange={(e) => onGeneralDiscountChange(e.target.value)}
          className={cn(inputClass, 'font-mono')}
        />
      </label>

      <dl className="space-y-1 text-[13px]">
        <Row label="Bruto" value={totals.gross} />
        {totals.lineDiscount > 0 && (
          <Row label="Bonificación por renglón" value={-totals.lineDiscount} muted />
        )}
        {totals.generalDiscount > 0 && (
          <Row label={`Bonificación general ${generalDiscount}%`} value={-totals.generalDiscount} muted />
        )}

        <div className="my-2 border-t border-line" />

        {totals.vatByRate.map((entry) => (
          <Row key={entry.rate} label={`Neto gravado ${entry.rate}%`} value={entry.net} />
        ))}
        {totals.netExempt > 0 && <Row label="Neto exento" value={totals.netExempt} />}
        {totals.netUntaxed > 0 && <Row label="Neto no gravado" value={totals.netUntaxed} />}
        {totals.vatByRate.map((entry) => (
          <Row key={`iva-${entry.rate}`} label={`IVA ${entry.rate}%`} value={entry.vat} />
        ))}
        {totals.otherTaxes > 0 && <Row label="Percepciones e impuestos" value={totals.otherTaxes} />}

        <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</dt>
          <dd className="font-display text-2xl font-medium text-text">$ {formatMoney(totals.total)}</dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-line pt-3">
        <label className={labelClass}>
          Total del comprobante (control)
          <input
            type="number" step="0.01" min="0"
            value={declaredTotal}
            onChange={(e) => onDeclaredTotalChange(e.target.value)}
            placeholder="Tipeá el total que figura en el papel"
            className={cn(
              inputClass, 'font-mono',
              declaredDiff !== null && declaredDiff !== 0 && 'border-danger bg-danger-soft'
            )}
          />
        </label>
        {declaredDiff !== null && (
          <p
            className={cn(
              'mt-1.5 flex items-center gap-1.5 text-xs',
              declaredDiff === 0 ? 'text-state-done' : 'text-danger'
            )}
          >
            {declaredDiff === 0 ? <Check size={14} /> : <AlertTriangle size={14} />}
            {declaredDiff === 0
              ? 'Coincide con el comprobante.'
              : `Difiere en $ ${formatMoney(Math.abs(declaredDiff))}. Revisá los renglones o el pie.`}
          </p>
        )}
      </div>
    </>
  );
}
