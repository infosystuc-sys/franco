import React from 'react';
import { Link } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { fetchSaldoDelCliente, type ValueInput } from '@/src/lib/receipts';

/**
 * La cuenta del cliente al momento de facturar.
 *
 * Si dejó plata a cuenta de una orden, el que la factura tiene que verlo sin
 * salir a la cuenta corriente, y poder imputarla en la misma factura. Imputar
 * es lo mismo que hace Cobranzas con el valor "Saldo a favor": al emitir se
 * registra un recibo que cancela la factura con ese saldo, sin plata nueva y
 * sin pasar por ninguna caja. En contado, el saldo es un medio más del cobro.
 */

export interface SaldoDelCliente {
  deuda: number;
  aFavor: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function useSaldoDelCliente(customerId: string | null | undefined): SaldoDelCliente | null {
  const [saldo, setSaldo] = React.useState<SaldoDelCliente | null>(null);
  React.useEffect(() => {
    setSaldo(null);
    if (!customerId) return;
    let cancelado = false;
    // Sin el saldo se puede facturar igual: si la consulta falla, no se muestra.
    fetchSaldoDelCliente(customerId)
      .then((s) => !cancelado && setSaldo(s))
      .catch(() => {});
    return () => { cancelado = true; };
  }, [customerId]);
  return saldo;
}

/** Cuánto del saldo a favor se imputa: lo elegido, sin pasar lo que hay ni el total. */
export function saldoAImputar(
  saldo: SaldoDelCliente | null,
  total: number,
  imputar: boolean,
  monto: number | null
): number {
  if (!saldo || !imputar || saldo.aFavor <= 0 || total <= 0) return 0;
  const tope = Math.min(saldo.aFavor, total);
  return round2(Math.max(0, Math.min(monto ?? tope, tope)));
}

/**
 * El recibo que se registra al emitir, si hace falta uno: en contado, todo
 * el total con los medios más el saldo imputado; en cuenta corriente, solo el
 * saldo imputado (el resto queda debiendo).
 */
export function reciboAlEmitir(
  total: number,
  contado: boolean,
  imputado: number,
  valoresDelContado: ValueInput[]
): { monto: number; valores: ValueInput[]; notas: string } | null {
  const valores: ValueInput[] = [
    ...(imputado > 0 ? [{ kind: 'SALDO_A_FAVOR' as const, amount: imputado }] : []),
    ...(contado ? valoresDelContado : []),
  ];
  if (valores.length === 0) return null;
  return {
    monto: contado ? total : imputado,
    valores,
    notas: contado
      ? imputado > 0 ? 'Factura de contado, con saldo a favor' : 'Factura de contado'
      : 'Saldo a favor imputado al emitir la factura',
  };
}

export function SaldoDelClienteAlFacturar({
  saldo,
  total,
  contado,
  imputar,
  onImputarChange,
  monto,
  onMontoChange,
  imputado,
}: {
  saldo: SaldoDelCliente | null;
  total: number;
  contado: boolean;
  imputar: boolean;
  onImputarChange: (v: boolean) => void;
  monto: number | null;
  onMontoChange: (v: number | null) => void;
  /** Lo que efectivamente se imputa (saldoAImputar). */
  imputado: number;
}) {
  if (!saldo) return <span className="block text-text-soft">—</span>;
  const { deuda, aFavor } = saldo;
  const resto = round2(total - imputado);

  return (
    <div className="space-y-1.5 normal-case">
      <div className="flex flex-wrap gap-x-4 gap-y-0.5">
        {deuda > 0 && (
          <span className="font-semibold text-danger">Debe $ {formatMoney(deuda)}</span>
        )}
        {aFavor > 0 && (
          <span className="font-semibold text-state-ok">Tiene $ {formatMoney(aFavor)} a favor</span>
        )}
        {deuda <= 0 && aFavor <= 0 && <span className="text-text-soft">Sin saldo: está al día</span>}
        <Link
          to="/cuenta-corriente-clientes"
          target="_blank"
          className="text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
        >
          Ver cuenta
        </Link>
      </div>

      {aFavor > 0 && total > 0 && (
        <>
          <label className="flex flex-wrap items-center gap-2 text-[13px]">
            <input type="checkbox" checked={imputar} onChange={(e) => onImputarChange(e.target.checked)} />
            Imputar en esta factura $
            <ImporteImputado
              value={imputar ? imputado : 0}
              disabled={!imputar}
              onChange={(n) => onMontoChange(n)}
            />
            {monto !== null && imputar && (
              <button
                type="button"
                onClick={() => onMontoChange(null)}
                className="text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
              >
                Todo lo posible
              </button>
            )}
          </label>
          <span className={cn('block text-[11px]', imputado > 0 ? 'text-text-soft' : 'text-text-faint')}>
            {imputado <= 0
              ? 'El saldo a favor queda en la cuenta del cliente.'
              : resto <= 0
                ? 'La factura queda pagada entera con el saldo a favor.'
                : contado
                  ? `Con los medios de pago se cobran los $ ${formatMoney(resto)} restantes.`
                  : `La factura queda debiendo $ ${formatMoney(resto)}.`}
          </span>
        </>
      )}
    </div>
  );
}

function ImporteImputado({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (n: number) => void;
}) {
  const [texto, setTexto] = React.useState(value ? String(value).replace('.', ',') : '');
  const editando = React.useRef(false);
  React.useEffect(() => {
    if (!editando.current) setTexto(value ? String(value).replace('.', ',') : '');
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={texto}
      disabled={disabled}
      onFocus={() => { editando.current = true; }}
      onBlur={() => {
        editando.current = false;
        setTexto(value ? String(value).replace('.', ',') : '');
      }}
      onChange={(e) => {
        setTexto(e.target.value);
        const limpio = e.target.value.includes(',')
          ? e.target.value.replace(/\./g, '').replace(',', '.')
          : e.target.value;
        const n = Number(limpio);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="h-8 w-32 rounded-[3px] border border-line bg-panel px-2 text-right font-mono text-[13px] text-text focus:border-accent focus:outline-none disabled:opacity-50"
    />
  );
}
