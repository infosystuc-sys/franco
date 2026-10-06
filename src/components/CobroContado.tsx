import React from 'react';
import { Plus, X } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import type { PaymentMethod } from '@/src/lib/paymentMethods';
import type { CheckDraft } from '@/src/components/CheckDraftModal';

/** Una parte del cobro hecha con un medio de pago (efectivo, transferencia…). */
export interface PagoContado {
  paymentMethodId: string;
  amount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cuánto suman los medios y los cheques cargados. */
export function totalCobrado(pagos: PagoContado[], cheques: CheckDraft[] | null): number {
  return round2(
    pagos.reduce((s, p) => s + (p.amount > 0 ? p.amount : 0), 0) +
      (cheques ?? []).reduce((s, c) => s + c.amount, 0)
  );
}

/**
 * ¿Alcanza para emitir? Todo lo cobrado tiene un medio elegido y la suma da
 * exactamente el total de la factura.
 */
export function cobroCompleto(pagos: PagoContado[], cheques: CheckDraft[] | null, total: number): boolean {
  const conImporte = pagos.filter((p) => p.amount > 0);
  if (conImporte.some((p) => !p.paymentMethodId)) return false;
  if (conImporte.length === 0 && !(cheques ?? []).length) return false;
  return Math.abs(totalCobrado(pagos, cheques) - total) < 0.01;
}

/** Los valores del recibo de contado: un renglón por medio y uno por cheque. */
export function valoresDelCobro(pagos: PagoContado[], cheques: CheckDraft[] | null) {
  return [
    ...pagos
      .filter((p) => p.amount > 0)
      .map((p) => ({ kind: 'MEDIO_PAGO' as const, amount: round2(p.amount), paymentMethodId: p.paymentMethodId })),
    ...(cheques ?? []).map((c) => ({
      kind: 'CHEQUE' as const,
      amount: c.amount,
      checkNumber: c.checkNumber,
      checkBank: c.checkBank,
      checkDueDate: c.checkDueDate,
      checkElectronico: c.electronico ?? false,
    })),
  ];
}

/**
 * Con un solo medio, ese medio cubre lo que falte: el total menos los
 * cheques. Así el caso de siempre (todo en efectivo) no pide escribir el
 * importe.
 */
export function ajustarUnicoMedio(pagos: PagoContado[], cheques: CheckDraft[] | null, total: number): PagoContado[] {
  if (pagos.length !== 1) return pagos;
  const resto = round2(Math.max(0, total - (cheques ?? []).reduce((s, c) => s + c.amount, 0)));
  return pagos[0].amount === resto ? pagos : [{ ...pagos[0], amount: resto }];
}

function leerImporte(t: string): number {
  const limpio = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : 0;
}

/**
 * El cobro de una factura de contado, con uno o varios medios: parte en
 * efectivo y parte con transferencia, más cheques o eCheqs si hace falta. La
 * suma tiene que dar el total de la factura para poder emitirla.
 */
export function CobroContado({
  total,
  paymentMethods,
  pagos,
  onPagosChange,
  cheques,
  onAgregarCheque,
  onQuitarCheque,
}: {
  total: number;
  paymentMethods: PaymentMethod[];
  pagos: PagoContado[];
  onPagosChange: (pagos: PagoContado[]) => void;
  cheques: CheckDraft[] | null;
  /** Abre la carga de cheques (electronico = eCheq). */
  onAgregarCheque: (electronico: boolean) => void;
  onQuitarCheque: (indice: number) => void;
}) {
  // La cartera de cheques no se elige acá: se mueve desde la pantalla de
  // Cheques. Un cheque que el cliente entrega ahora se carga con "+ Cheque".
  const medios = paymentMethods.filter((m) => m.kind !== 'CARTERA_CHEQUES');
  const cobrado = totalCobrado(pagos, cheques);
  const diferencia = round2(total - cobrado);
  const varios = pagos.length > 1 || (cheques ?? []).length > 0;

  function cambiar(i: number, cambio: Partial<PagoContado>) {
    onPagosChange(pagos.map((p, j) => (j === i ? { ...p, ...cambio } : p)));
  }

  return (
    <div className="space-y-1.5 normal-case">
      {pagos.map((p, i) => (
        <div key={i} className="flex gap-1.5">
          <select
            value={p.paymentMethodId}
            onChange={(e) => cambiar(i, { paymentMethodId: e.target.value })}
            className={cn(
              'h-9 min-w-0 flex-1 rounded-[3px] border bg-panel px-2 text-[14px] text-text focus:border-accent focus:outline-none',
              p.amount > 0 && !p.paymentMethodId ? 'border-danger text-danger' : 'border-line'
            )}
          >
            <option value="">Elegí un medio…</option>
            {medios.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          {varios && (
            <ImporteDeMedio value={p.amount} onChange={(amount) => cambiar(i, { amount })} />
          )}
          {varios && (
            <button
              type="button"
              onClick={() => onPagosChange(pagos.filter((_, j) => j !== i))}
              title="Quitar este medio"
              aria-label="Quitar este medio"
              className="flex h-9 w-7 shrink-0 items-center justify-center text-text-soft hover:text-danger"
            >
              <X size={15} />
            </button>
          )}
        </div>
      ))}

      {(cheques ?? []).map((c, i) => (
        <div key={`ch-${i}`} className="flex items-center gap-1.5 rounded-[3px] border border-line bg-panel-alt px-2 py-1 text-[13px]">
          <span className="min-w-0 flex-1 truncate text-text">
            {c.electronico ? 'eCheq' : 'Cheque'} {c.checkNumber} — {c.checkBank}
          </span>
          <span className="shrink-0 font-semibold text-text">$ {formatMoney(c.amount)}</span>
          <button
            type="button"
            onClick={() => onQuitarCheque(i)}
            title="Quitar el cheque"
            aria-label="Quitar el cheque"
            className="flex h-6 w-6 shrink-0 items-center justify-center text-text-soft hover:text-danger"
          >
            <X size={14} />
          </button>
        </div>
      ))}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-bold uppercase tracking-wider text-accent-deep">
        <button
          type="button"
          onClick={() => onPagosChange([...pagos, { paymentMethodId: '', amount: diferencia > 0 ? diferencia : 0 }])}
          className="inline-flex items-center gap-0.5 hover:underline"
        >
          <Plus size={12} /> Otro medio
        </button>
        <button type="button" onClick={() => onAgregarCheque(false)} className="inline-flex items-center gap-0.5 hover:underline">
          <Plus size={12} /> Cheque
        </button>
        <button type="button" onClick={() => onAgregarCheque(true)} className="inline-flex items-center gap-0.5 hover:underline">
          <Plus size={12} /> eCheq
        </button>
      </div>

      <span
        className={cn(
          'block text-[11px]',
          Math.abs(diferencia) < 0.01 ? 'text-text-soft' : 'font-semibold text-danger'
        )}
      >
        {medios.length === 0
          ? 'No hay medios activos. Cargá uno desde Medios de pago.'
          : Math.abs(diferencia) < 0.01
            ? varios
              ? `Cobrado $ ${formatMoney(cobrado)} — se cobra al emitir`
              : 'Se cobra al emitir'
            : diferencia > 0
              ? `Falta asignar $ ${formatMoney(diferencia)} de $ ${formatMoney(total)}`
              : `Sobran $ ${formatMoney(-diferencia)}: lo cobrado supera el total`}
      </span>
    </div>
  );
}

function ImporteDeMedio({ value, onChange }: { value: number; onChange: (n: number) => void }) {
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
      placeholder="0,00"
      onFocus={(e) => {
        editando.current = true;
        e.target.select();
      }}
      onMouseUp={(e) => e.preventDefault()}
      onBlur={() => {
        editando.current = false;
        setTexto(value ? String(value).replace('.', ',') : '');
      }}
      onChange={(e) => {
        const t = e.target.value.replace(/[^0-9.,]/g, '');
        setTexto(t);
        onChange(leerImporte(t));
      }}
      aria-label="Importe de este medio"
      className="h-9 w-28 shrink-0 rounded-[3px] border border-line bg-panel px-2 text-right text-[14px] text-text focus:border-accent focus:outline-none"
    />
  );
}
