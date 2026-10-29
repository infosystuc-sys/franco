// src/components/purchase/ReferenciaNotaDeCredito.tsx
import React from 'react';
import { AlertTriangle, Copy, FileText } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import { inputClass, labelClass } from '@/src/components/FiscalFields';
import { Button } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  fetchFacturasAcreditables,
  formatDate,
  pendienteDeAcreditar,
  type FacturaAcreditable,
  type PurchaseKind,
} from '@/src/lib/purchases';

export type ModoNotaDeCredito = 'TOTAL' | 'PARCIAL';

/**
 * La factura a la que acredita una nota de crédito de compra, y si la acredita
 * entera o en parte. Toda NC se carga contra una factura: al guardarse se
 * aplica sola contra lo que esa factura debe.
 *
 * Sin `onModoChange` no se ofrece elegir: la NC es por lo que digan sus
 * renglones (la revisión de la IA, donde los renglones salen del papel).
 */
export function ReferenciaNotaDeCredito({
  supplierId,
  kind,
  invoiceId,
  onInvoiceChange,
  modo,
  onModoChange,
  onCopiarRenglones,
  totalNota,
}: {
  supplierId: string;
  kind: PurchaseKind;
  invoiceId: string;
  onInvoiceChange: (factura: FacturaAcreditable | null) => void;
  modo?: ModoNotaDeCredito;
  onModoChange?: (modo: ModoNotaDeCredito) => void;
  /** Arranca la NC parcial con los renglones de la factura. */
  onCopiarRenglones?: () => void;
  /** El total de la NC que se está cargando, para avisar si se pasa. */
  totalNota: number;
}) {
  const [facturas, setFacturas] = React.useState<FacturaAcreditable[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!supplierId) {
      setFacturas([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFacturasAcreditables(supplierId)
      .then((todas) => {
        if (cancelled) return;
        const delTipo = todas.filter((f) => f.kind === kind);
        setFacturas(delTipo);
        // Llegó con la factura ya elegida (desde su ficha): se completan sus datos.
        if (invoiceId) onInvoiceChange(delTipo.find((f) => f.id === invoiceId) ?? null);
      })
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [supplierId, kind]);

  const factura = facturas.find((f) => f.id === invoiceId) ?? null;
  const pendiente = factura ? pendienteDeAcreditar(factura) : 0;
  // Una total no se puede hacer si ya hay parciales: lo que queda va como parcial.
  const totalPosible = !!factura && factura.acreditado === 0;
  const seExcede = !!factura && modo !== 'TOTAL' && totalNota > pendiente + 0.01;

  return (
    <div className="mt-4 space-y-3 border border-line bg-panel-alt p-4">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-accent-deep">
        <FileText size={14} /> Factura que acredita
      </p>

      {!supplierId ? (
        <p className="text-sm text-text-soft">Elegí el proveedor para ver sus facturas.</p>
      ) : loading ? (
        <p className="text-sm text-text-soft">Buscando las facturas del proveedor…</p>
      ) : error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : facturas.length === 0 ? (
        <p className="text-sm text-danger">
          Este proveedor no tiene facturas cargadas para acreditar. La nota de crédito siempre va contra una factura:
          cargá primero la factura.
        </p>
      ) : (
        <label className={labelClass}>
          Factura *
          <select
            value={invoiceId}
            onChange={(e) => onInvoiceChange(facturas.find((f) => f.id === e.target.value) ?? null)}
            className={cn(inputClass, 'bg-panel font-mono', !invoiceId && 'field-required')}
          >
            <option value="">Elegí la factura…</option>
            {facturas.map((f) => {
              const queda = pendienteDeAcreditar(f);
              return (
                <option key={f.id} value={f.id} disabled={queda <= 0}>
                  {f.letter} {f.fullNumber} · {formatDate(f.issueDate)} · $ {formatMoney(f.totalAmount)}
                  {queda <= 0 ? ' · ya acreditada entera' : f.acreditado > 0 ? ` · queda $ ${formatMoney(queda)}` : ''}
                </option>
              );
            })}
          </select>
        </label>
      )}

      {factura && (
        <>
          <p className="text-[13px] text-text-soft">
            Total $ {formatMoney(factura.totalAmount)}
            {factura.acreditado > 0 && ` · ya acreditado $ ${formatMoney(factura.acreditado)}`}
            {' · '}queda para acreditar <b className="text-text">$ {formatMoney(pendiente)}</b>
            {' · '}adeudado hoy $ {formatMoney(Math.max(0, factura.totalAmount - factura.settledAmount))}
          </p>

          {onModoChange && (
            <div className="flex flex-wrap gap-4 text-sm">
              <label className={cn('flex items-start gap-2', !totalPosible && 'opacity-50')}>
                <input
                  type="radio"
                  checked={modo === 'TOTAL'}
                  disabled={!totalPosible}
                  onChange={() => onModoChange('TOTAL')}
                  className="mt-0.5 h-4 w-4 accent-accent-deep"
                />
                <span>
                  <span className="font-semibold text-text">Total</span>
                  <span className="block text-[12px] text-text-soft">
                    {totalPosible
                      ? 'Cancela la factura completa: se copia tal cual, al centavo.'
                      : 'Ya tiene notas de crédito parciales: lo que queda va como parcial.'}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  checked={modo === 'PARCIAL'}
                  onChange={() => onModoChange('PARCIAL')}
                  className="mt-0.5 h-4 w-4 accent-accent-deep"
                />
                <span>
                  <span className="font-semibold text-text">Parcial</span>
                  <span className="block text-[12px] text-text-soft">
                    Una devolución, una bonificación o un ajuste: cargás sus renglones.
                  </span>
                </span>
              </label>
            </div>
          )}

          {modo === 'PARCIAL' && onCopiarRenglones && (
            <Button type="button" variant="ghost" onClick={onCopiarRenglones} className="px-3">
              <Copy size={15} /> Copiar los renglones de la factura
            </Button>
          )}

          {seExcede && (
            <p className="flex items-center gap-1.5 text-xs text-danger">
              <AlertTriangle size={14} />
              La nota de crédito ($ {formatMoney(totalNota)}) supera lo que queda para acreditar de la factura
              ($ {formatMoney(pendiente)}).
            </p>
          )}
        </>
      )}
    </div>
  );
}
