import { formatDate, formatMoney } from '@/src/lib/utils';
import { formatCuit, TAX_CONDITION_LABELS, type TaxCondition } from '@/src/lib/fiscal';
import { formatAddress, type TallerHeader } from '@/src/lib/companySettings';
import logo from '@/src/assets/logo-luciano-diesel.png';

const IVA_RATE = 0.21;

export interface QuotationDocumentItem {
  code: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface QuotationDocumentData {
  number: string;
  issueDate: string;
  validUntil: string | null;
  component: string | null;
  notes: string | null;
  customerName: string;
  customerTaxId: string | null;
  customerAddress: string | null;
  customerTaxCondition: TaxCondition | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  licensePlate: string | null;
  workOrderNumber: string | null;
  items: QuotationDocumentItem[];
}

/**
 * El presupuesto tal como se entrega: es lo que se imprime, lo que se baja en
 * PDF desde el link del cliente y lo que viaja adjunto por mail o WhatsApp.
 *
 * Vive en un componente propio porque esas tres salidas tienen que ser el
 * mismo papel. Antes cada pantalla dibujaba el suyo —la interna una tabla
 * seca, la del cliente unos paneles de pantalla— y ninguno decía de qué taller
 * venía.
 */
export function QuotationDocument({
  quotation,
  taller,
}: {
  quotation: QuotationDocumentData;
  taller: TallerHeader | null;
}) {
  const neto = quotation.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const iva = neto * IVA_RATE;

  const vehiculo =
    [quotation.vehicleBrand, quotation.vehicleModel].filter(Boolean).join(' ') || '—';
  const domicilioTaller = taller ? formatAddress(taller) : '';

  return (
    <div className="print-document border border-line bg-panel p-6 md:p-10">
      {/* Membrete: el taller a la izquierda, el comprobante a la derecha */}
      <div className="grid grid-cols-1 gap-6 border-b-2 border-ink pb-5 sm:grid-cols-[1fr_auto]">
        <div>
          <img src={logo} alt={taller?.tradeName ?? 'Luciano Diesel'} className="h-12 w-auto" />
          {taller && (
            <>
              <h2 className="mt-3 font-display text-xl font-medium uppercase leading-tight text-text">
                {taller.legalName}
              </h2>
              <dl className="mt-2 space-y-0.5 text-[13px] text-text-soft">
                {domicilioTaller && <dd>{domicilioTaller}</dd>}
                <dd>{TAX_CONDITION_LABELS[taller.taxCondition]}</dd>
                {taller.taxId && <dd className="font-mono">CUIT {formatCuit(taller.taxId)}</dd>}
                {taller.grossIncome && <dd>Ingresos Brutos {taller.grossIncome}</dd>}
                {taller.activityStartDate && (
                  <dd>Inicio de actividades {formatDate(taller.activityStartDate)}</dd>
                )}
                {(taller.phone || taller.email) && (
                  <dd>{[taller.phone, taller.email].filter(Boolean).join(' · ')}</dd>
                )}
              </dl>
            </>
          )}
        </div>

        <div className="sm:text-right">
          <h3 className="font-display text-xl uppercase tracking-[0.08em] text-text-faint">
            Presupuesto
          </h3>
          <p className="mt-1 font-mono text-lg font-semibold text-text">{quotation.number}</p>
          <dl className="mt-2 space-y-0.5 text-[13px] text-text-soft">
            <dd>Fecha de emisión: {formatDate(quotation.issueDate)}</dd>
            {quotation.validUntil && <dd>Válido hasta: {formatDate(quotation.validUntil)}</dd>}
            {quotation.workOrderNumber && (
              <dd className="font-mono">Orden {quotation.workOrderNumber}</dd>
            )}
          </dl>
        </div>
      </div>

      {/* Cliente y trabajo. Cada dato se muestra solo si está: el presupuesto
          que ve el cliente por el link no lleva su CUIT ni su domicilio, y una
          fila con un guión no informa nada. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-line py-4 text-[14px] sm:grid-cols-2">
        <Campo label="Señor(es)" value={quotation.customerName} />
        {quotation.customerTaxId && (
          <Campo label="CUIT / CUIL" value={formatCuit(quotation.customerTaxId)} mono />
        )}
        {quotation.customerAddress && (
          <Campo label="Domicilio" value={quotation.customerAddress} />
        )}
        {quotation.customerTaxCondition && (
          <Campo
            label="Condición frente al IVA"
            value={TAX_CONDITION_LABELS[quotation.customerTaxCondition]}
          />
        )}
        <Campo
          label="Vehículo / Equipo"
          value={quotation.licensePlate ? `${vehiculo} · ${quotation.licensePlate}` : vehiculo}
        />
        {quotation.component && <Campo label="Trabajo a realizar" value={quotation.component} />}
      </div>

      {/* Renglones */}
      <div className="overflow-x-auto py-4">
        <table className="w-full text-left text-[14px]">
          <thead className="border-b-2 border-line-strong text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="w-24 py-1.5 pr-2">Código</th>
              <th className="py-1.5 pr-2">Descripción</th>
              <th className="w-16 py-1.5 pr-2 text-right">Cant.</th>
              <th className="w-28 py-1.5 pr-2 text-right">P. unitario</th>
              <th className="w-28 py-1.5 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {quotation.items.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-text-soft">
                  Este presupuesto todavía no tiene detalle cargado.
                </td>
              </tr>
            )}
            {quotation.items.map((item, idx) => (
              <tr key={idx} className="border-b border-line">
                <td className="py-1.5 pr-2 font-mono text-text-soft">{item.code ?? ''}</td>
                <td className="py-1.5 pr-2">{item.description}</td>
                <td className="py-1.5 pr-2 text-right">{item.quantity.toFixed(2)}</td>
                <td className="py-1.5 pr-2 text-right">$ {formatMoney(item.unitPrice)}</td>
                <td className="py-1.5 text-right font-semibold">
                  $ {formatMoney(item.quantity * item.unitPrice)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totales */}
      <div className="flex justify-end border-t-2 border-ink pt-4">
        <div className="w-full space-y-1.5 sm:w-72">
          <Renglon label="Neto gravado" value={neto} />
          <Renglon label="IVA 21%" value={iva} />
          <div className="flex items-baseline justify-between border-t-2 border-accent pt-2">
            <span className="text-[13px] font-semibold uppercase tracking-[0.08em] text-text-soft">
              Total
            </span>
            <span className="font-display text-2xl font-medium text-text">
              $ {formatMoney(neto + iva)}
            </span>
          </div>
        </div>
      </div>

      {quotation.notes && (
        <div className="mt-5 border-t border-line pt-3">
          <span className="mb-1 block text-[12px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Observaciones
          </span>
          <p className="whitespace-pre-line text-[14px] text-text-soft">{quotation.notes}</p>
        </div>
      )}

      <p className="mt-6 border-t border-line pt-3 text-center text-[12px] text-text-faint">
        Presupuesto sin validez fiscal: no reemplaza a la factura.
        {quotation.validUntil
          ? ` Los precios se mantienen hasta el ${formatDate(quotation.validUntil)}.`
          : ''}
      </p>
    </div>
  );
}

function Campo({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <p className="flex gap-1.5">
      <span className="shrink-0 text-text-faint">{label}:</span>
      <span className={mono ? 'font-mono font-semibold text-text' : 'font-semibold text-text'}>
        {value}
      </span>
    </p>
  );
}

function Renglon({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-[14px] text-text-soft">
      <span>{label}</span>
      <span className="text-text">$ {formatMoney(value)}</span>
    </div>
  );
}
