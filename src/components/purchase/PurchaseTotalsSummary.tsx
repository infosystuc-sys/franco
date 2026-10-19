import React from 'react';
import { AlertTriangle, Check, Pencil, RotateCcw } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { hayAjustes, SIN_AJUSTES, type PurchaseAjustes, type PurchaseTotals } from '@/src/lib/purchases';

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
 * Un importe del pie que se puede escribir a mano. Debajo, si difiere, lo
 * que daba la cuenta de los renglones, para no perder la referencia.
 */
function RowEditable({
  label,
  value,
  calculado,
  onChange,
}: {
  label: string;
  value: number;
  calculado: number;
  onChange: (value: number | undefined) => void;
}) {
  const [texto, setTexto] = React.useState(String(value));
  React.useEffect(() => {
    if (Number(texto) !== value) setTexto(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const ajustado = Math.abs(value - calculado) > 0.004;
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="pt-1 text-text-soft">
        {label}
        {ajustado && (
          <span className="block text-[12px] text-state-wait">
            calculado $ {formatMoney(calculado)}{' '}
            <button type="button" onClick={() => onChange(undefined)} className="font-semibold hover:underline">
              volver
            </button>
          </span>
        )}
      </dt>
      <dd>
        <input
          type="number"
          step="0.01"
          min="0"
          value={texto}
          onChange={(e) => {
            setTexto(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
          }}
          className={cn(
            'w-36 rounded border bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none',
            ajustado ? 'border-state-wait' : 'border-line'
          )}
        />
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
  calculados,
  ajustes,
  onAjustesChange,
}: {
  /** Los totales que se van a guardar (con los ajustes, si los hay). */
  totals: PurchaseTotals;
  generalDiscount: string;
  onGeneralDiscountChange: (value: string) => void;
  declaredTotal: string;
  onDeclaredTotalChange: (value: string) => void;
  /**
   * Con estos tres, los netos y el IVA se pueden escribir a mano para que
   * coincidan con el papel. `calculados` es lo que da la cuenta de los
   * renglones, sin ajustes.
   */
  calculados?: PurchaseTotals;
  ajustes?: PurchaseAjustes;
  onAjustesChange?: (ajustes: PurchaseAjustes) => void;
}) {
  const editable = !!(calculados && ajustes && onAjustesChange);
  const [editando, setEditando] = React.useState(false);
  const enEdicion = editable && (editando || hayAjustes(ajustes!));

  function ajustarAlicuota(rate: number, campo: 'net' | 'vat', valor: number | undefined) {
    const actual = ajustes!.porAlicuota[String(rate)] ?? {};
    onAjustesChange!({
      ...ajustes!,
      porAlicuota: { ...ajustes!.porAlicuota, [String(rate)]: { ...actual, [campo]: valor } },
    });
  }

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

      <dl className="space-y-1 text-[15px]">
        <Row label="Bruto" value={totals.gross} />
        {totals.lineDiscount > 0 && (
          <Row label="Bonificación por renglón" value={-totals.lineDiscount} muted />
        )}
        {totals.generalDiscount > 0 && (
          <Row label={`Bonificación general ${generalDiscount}%`} value={-totals.generalDiscount} muted />
        )}

        <div className="my-2 border-t border-line" />

        {editable && (
          <div className="mb-1 flex justify-end gap-3 text-[13px]">
            {hayAjustes(ajustes!) && (
              <button
                type="button"
                onClick={() => { onAjustesChange!(SIN_AJUSTES); setEditando(false); }}
                className="inline-flex items-center gap-1 font-semibold text-text-soft hover:text-text"
              >
                <RotateCcw size={13} /> Volver a lo calculado
              </button>
            )}
            {!enEdicion && (
              <button
                type="button"
                onClick={() => setEditando(true)}
                className="inline-flex items-center gap-1 font-semibold text-accent-deep hover:underline"
              >
                <Pencil size={13} /> Editar importes
              </button>
            )}
          </div>
        )}

        {enEdicion ? (
          <>
            {totals.vatByRate.map((entry) => {
              const calc = calculados!.vatByRate.find((c) => c.rate === entry.rate);
              return (
                <RowEditable
                  key={entry.rate}
                  label={`Neto gravado ${entry.rate}%`}
                  value={entry.net}
                  calculado={calc?.net ?? 0}
                  onChange={(v) => ajustarAlicuota(entry.rate, 'net', v)}
                />
              );
            })}
            {totals.netExempt > 0 && (
              <RowEditable
                label="Neto exento"
                value={totals.netExempt}
                calculado={calculados!.netExempt}
                onChange={(v) => onAjustesChange!({ ...ajustes!, netExempt: v })}
              />
            )}
            {totals.netUntaxed > 0 && (
              <RowEditable
                label="Neto no gravado"
                value={totals.netUntaxed}
                calculado={calculados!.netUntaxed}
                onChange={(v) => onAjustesChange!({ ...ajustes!, netUntaxed: v })}
              />
            )}
            {totals.vatByRate.map((entry) => {
              const calc = calculados!.vatByRate.find((c) => c.rate === entry.rate);
              return (
                <RowEditable
                  key={`iva-${entry.rate}`}
                  label={`IVA ${entry.rate}%`}
                  value={entry.vat}
                  calculado={calc?.vat ?? 0}
                  onChange={(v) => ajustarAlicuota(entry.rate, 'vat', v)}
                />
              );
            })}
            <p className="text-[12px] text-text-soft">
              Escribí los importes como figuran en el papel. La diferencia se carga en el renglón más
              grande de cada alícuota.
            </p>
          </>
        ) : (
          <>
            {totals.vatByRate.map((entry) => (
              <Row key={entry.rate} label={`Neto gravado ${entry.rate}%`} value={entry.net} />
            ))}
            {totals.netExempt > 0 && <Row label="Neto exento" value={totals.netExempt} />}
            {totals.netUntaxed > 0 && <Row label="Neto no gravado" value={totals.netUntaxed} />}
            {totals.vatByRate.map((entry) => (
              <Row key={`iva-${entry.rate}`} label={`IVA ${entry.rate}%`} value={entry.vat} />
            ))}
          </>
        )}
        {totals.otherTaxes > 0 && <Row label="Percepciones e impuestos" value={totals.otherTaxes} />}

        <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
          <dt className="text-[13px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</dt>
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
              : `Difiere en $ ${formatMoney(Math.abs(declaredDiff))}. Revisá los renglones o el pie${
                  editable ? ', o editá los importes para que coincidan con el papel' : ''
                }.`}
          </p>
        )}
      </div>
    </>
  );
}
