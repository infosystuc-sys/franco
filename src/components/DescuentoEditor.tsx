import React from 'react';
import { cn, formatMoney } from '@/src/lib/utils';
import type { Descuento } from '@/src/lib/invoices';

/**
 * Descuento por porcentaje o por monto fijo, para la OT y la factura. Sin
 * valor (o en cero) no hay descuento. Muestra cuánto descuenta sobre la suma
 * de los renglones para que se vea el efecto antes de emitir.
 */
export function DescuentoEditor({
  value,
  onChange,
  bruto,
  disabled,
}: {
  value: Descuento | null;
  onChange: (descuento: Descuento | null) => void;
  /** Suma de los renglones, para mostrar cuánto se descuenta. */
  bruto: number;
  disabled?: boolean;
}) {
  const tipo = value?.tipo ?? 'PORCENTAJE';
  const [texto, setTexto] = React.useState(value?.valor ? String(value.valor).replace('.', ',') : '');

  React.useEffect(() => {
    setTexto(value?.valor ? String(value.valor).replace('.', ',') : '');
  }, [value?.valor, value?.tipo]);

  function cambiarValor(t: string, nuevoTipo = tipo) {
    const limpio = t.replace(/[^0-9.,]/g, '');
    setTexto(limpio);
    const n = Number(limpio.replace(/\./g, '').replace(',', '.'));
    onChange(limpio === '' || !(n > 0) ? null : { tipo: nuevoTipo, valor: n });
  }

  const monto = !value
    ? 0
    : value.tipo === 'PORCENTAJE'
      ? Math.round(bruto * value.valor) / 100
      : value.valor;
  const invalido =
    !!value && ((value.tipo === 'PORCENTAJE' && value.valor >= 100) || (value.tipo === 'MONTO' && monto >= bruto && bruto > 0));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">Descuento</span>
      <div className="flex">
        {(['PORCENTAJE', 'MONTO'] as const).map((t) => (
          <button
            key={t}
            type="button"
            disabled={disabled}
            onClick={() => cambiarValor(texto, t)}
            className={cn(
              'h-9 w-10 border border-line text-[14px] font-semibold first:rounded-l-[3px] last:-ml-px last:rounded-r-[3px]',
              tipo === t ? 'bg-accent text-accent-ink' : 'bg-panel text-text-soft hover:text-text'
            )}
            title={t === 'PORCENTAJE' ? 'Porcentaje sobre los renglones' : 'Monto fijo'}
          >
            {t === 'PORCENTAJE' ? '%' : '$'}
          </button>
        ))}
      </div>
      <input
        type="text"
        inputMode="decimal"
        value={texto}
        disabled={disabled}
        onChange={(e) => cambiarValor(e.target.value)}
        onFocus={(e) => e.target.select()}
        onMouseUp={(e) => e.preventDefault()}
        placeholder={tipo === 'PORCENTAJE' ? '0' : '0,00'}
        aria-label="Descuento"
        className={cn(
          'h-9 w-28 rounded-[3px] border bg-panel px-2 text-right text-[15px] text-text focus:border-accent focus:outline-none',
          invalido ? 'border-danger text-danger' : 'border-line'
        )}
      />
      {value && (
        <span className={cn('text-[13px]', invalido ? 'text-danger' : 'text-text-soft')}>
          {invalido
            ? 'El descuento no puede ser igual o mayor que los renglones.'
            : `− $ ${formatMoney(monto)}`}
        </span>
      )}
    </div>
  );
}

/** El descuento guardado en una OT (porcentaje o monto fijo), como Descuento. */
export function descuentoDe(percent: number | null | undefined, fixed: number | null | undefined): Descuento | null {
  if (percent && percent > 0) return { tipo: 'PORCENTAJE', valor: percent };
  if (fixed && fixed > 0) return { tipo: 'MONTO', valor: fixed };
  return null;
}
