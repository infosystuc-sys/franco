import React from 'react';
import { X, Percent, DollarSign } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import { Button } from '@/src/components/ui';
import { montoDeSobrefacturacion, type Sobrefacturacion } from '@/src/lib/mechanics';

/**
 * Cuánto se le sobrefactura al cliente para el mecánico de esta orden.
 *
 * Aparece al cotizar, y solo si la orden tiene mecánico. El monto se reparte
 * DENTRO de los precios de los renglones —proporcional al peso de cada uno—,
 * así que el cliente ve precios más altos y ninguna línea delata el recargo.
 *
 * Se muestra el total resultante mientras se tipea: quien lo define está
 * eligiendo cuánto va a pagar el cliente, y ese número es el que importa.
 */
export function SobrefacturacionModal({
  mecanico,
  neto,
  onConfirm,
  onClose,
}: {
  mecanico: string;
  /** Neto de los renglones, sin recargo. */
  neto: number;
  onConfirm: (valor: Sobrefacturacion) => void;
  onClose: () => void;
}) {
  const [modo, setModo] = React.useState<'PORCENTAJE' | 'MONTO'>('PORCENTAJE');
  const [valor, setValor] = React.useState('');

  const numero = Number(valor.replace(',', '.'));
  const valido = valor.trim() !== '' && Number.isFinite(numero) && numero > 0;
  const elegido: Sobrefacturacion = modo === 'PORCENTAJE'
    ? { monto: null, porcentaje: valido ? numero : 0 }
    : { monto: valido ? numero : 0, porcentaje: null };
  const recargo = montoDeSobrefacturacion(neto, elegido);

  const inputClass = 'mt-1 w-full border border-line bg-panel px-3 py-2 text-right font-mono text-sm focus:border-accent-deep focus:outline-none';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-bold text-text">Sobrefacturación</h2>
          <button onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <p className="text-sm text-text-soft">
            Esta orden la hace <span className="font-semibold text-text">{mecanico}</span>.
            Lo que definas acá se reparte dentro de los precios de los renglones y es lo
            que se le va a acreditar cuando la orden se facture.
          </p>

          <div className="flex gap-2">
            {(['PORCENTAJE', 'MONTO'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setModo(m)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 border px-3 py-2 text-[13px] font-bold uppercase tracking-wider transition-colors',
                  modo === m
                    ? 'border-accent-deep bg-accent text-accent-ink'
                    : 'border-line text-text-soft hover:bg-panel-alt'
                )}
              >
                {m === 'PORCENTAJE' ? <Percent size={14} /> : <DollarSign size={14} />}
                {m === 'PORCENTAJE' ? 'Porcentaje' : 'Monto fijo'}
              </button>
            ))}
          </div>

          <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
            {modo === 'PORCENTAJE' ? 'Porcentaje sobre el neto' : 'Monto a repartir'}
            <input
              autoFocus
              inputMode="decimal"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valido) {
                  e.preventDefault();
                  onConfirm(elegido);
                }
              }}
              className={inputClass}
              placeholder={modo === 'PORCENTAJE' ? '20' : '5000'}
            />
          </label>

          <div className="border border-line bg-panel-alt p-3 text-sm">
            <Fila rotulo="Neto de los renglones" valor={neto} />
            <Fila rotulo="Sobrefacturación" valor={recargo} destacado />
            <div className="mt-2 flex justify-between border-t border-line pt-2">
              <span className="text-[13px] font-bold uppercase tracking-wider text-text">
                Neto que ve el cliente
              </span>
              <span className="font-mono font-bold text-text">$ {formatMoney(neto + recargo)}</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          {/* Tener mecánico no obliga a sobrefacturar: hay trabajos que se
              cobran sin recargo, y forzarlo llevaría a poner un cero a mano. */}
          <button
            type="button"
            onClick={() => onConfirm({ monto: null, porcentaje: null })}
            className="px-4 py-2 text-[13px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt"
          >
            Cotizar sin recargo
          </button>
          <Button type="button" disabled={!valido} onClick={() => onConfirm(elegido)}>
            Cotizar con recargo
          </Button>
        </div>
      </div>
    </div>
  );
}

function Fila({ rotulo, valor, destacado }: { rotulo: string; valor: number; destacado?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-soft">{rotulo}</span>
      <span className={cn('font-mono', destacado ? 'font-bold text-accent-deep' : 'text-text')}>
        $ {formatMoney(valor)}
      </span>
    </div>
  );
}
