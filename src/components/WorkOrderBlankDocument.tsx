import { formatDate } from '@/src/lib/utils';
import { formatCuit, TAX_CONDITION_LABELS, type TaxCondition } from '@/src/lib/fiscal';
import { formatAddress, type TallerHeader } from '@/src/lib/companySettings';
import logoPorDefecto from '@/src/assets/logo-luciano-diesel.png';

export interface WorkOrderBlankData {
  number: string;
  component: string | null;
  customerName: string;
  customerPhone: string | null;
  customerTaxId: string | null;
  customerTaxCondition: TaxCondition | null;
  customerAddress: string | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  licensePlate: string | null;
  year: number | null;
  engineBrand: string | null;
  engineModel: string | null;
}

/**
 * La orden en papel, para cuando el mostrador o el taller trabajan sin la
 * pantalla a mano: se completa el detalle a lápiz y se carga después.
 *
 * Lleva los datos del cliente y del vehículo ya impresos —es lo que ya está
 * cargado en el sistema y volver a copiarlo a mano es trabajo de más y una
 * fuente de errores de transcripción— y deja en blanco lo que todavía no
 * existe: los renglones del trabajo.
 *
 * Es un documento de uso interno, no un comprobante: sin CAE, sin QR, sin
 * importes. Por eso no comparte componente con la factura ni con el
 * presupuesto, aunque el membrete sea el mismo.
 */
export function WorkOrderBlankDocument({
  order,
  taller,
  filas = 18,
}: {
  order: WorkOrderBlankData;
  taller: TallerHeader | null;
  /** Cuántos renglones en blanco entran cómodos en una hoja A4. */
  filas?: number;
}) {
  const vehiculo = [order.vehicleBrand, order.vehicleModel].filter(Boolean).join(' ') || '';
  const motor = [order.engineBrand, order.engineModel].filter(Boolean).join(' ');
  const domicilioTaller = taller ? formatAddress(taller) : '';

  return (
    <div className="print-document border border-line bg-panel p-6 md:p-10">
      {/* Membrete: mismo criterio que factura y presupuesto. */}
      <div className="grid grid-cols-1 gap-6 border-b-2 border-ink pb-5 sm:grid-cols-[1fr_auto]">
        <div>
          <img
            src={taller?.logo ?? logoPorDefecto}
            alt={taller?.tradeName ?? ''}
            className="h-12 w-auto object-contain"
          />
          {taller && (
            <>
              <h2 className="mt-3 font-display text-2xl font-medium uppercase leading-tight text-text">
                {taller.legalName}
              </h2>
              <dl className="mt-2 space-y-0.5 text-[15px] text-text-soft">
                {domicilioTaller && <dd>{domicilioTaller}</dd>}
                {taller.taxId && <dd className="font-mono">CUIT {formatCuit(taller.taxId)}</dd>}
                {(taller.phone || taller.email) && (
                  <dd>{[taller.phone, taller.email].filter(Boolean).join(' · ')}</dd>
                )}
              </dl>
            </>
          )}
        </div>

        <div className="sm:text-right">
          <h3 className="font-display text-2xl uppercase tracking-[0.08em] text-text-faint">
            Orden de trabajo
          </h3>
          <p className="mt-1 font-mono text-xl font-semibold text-text">{order.number}</p>
          <dl className="mt-2 space-y-0.5 text-[15px] text-text-soft">
            {/* La fecha de recepción se completa a mano: no se sabe todavía
                cuándo va a entrar el vehículo cuando esto se imprime. */}
            <dd>Fecha de ingreso: ______ / ______ / __________</dd>
            <dd>Hora: ______ : ______</dd>
          </dl>
        </div>
      </div>

      {/* Cliente y vehículo, ya cargados. Cada dato se muestra solo si está:
          una fila con un guión no informa nada y ocupa lugar que le hace
          falta a los renglones. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 border-b border-line py-4 text-[16px] sm:grid-cols-2">
        <Campo label="Señor(es)" value={order.customerName} />
        {order.customerPhone && <Campo label="Teléfono" value={order.customerPhone} />}
        {order.customerTaxId && (
          <Campo label="CUIT / CUIL" value={formatCuit(order.customerTaxId)} mono />
        )}
        {order.customerTaxCondition && (
          <Campo
            label="Condición frente al IVA"
            value={TAX_CONDITION_LABELS[order.customerTaxCondition]}
          />
        )}
        {order.customerAddress && <Campo label="Domicilio" value={order.customerAddress} />}
        <Campo
          label="Vehículo / Equipo"
          value={
            [vehiculo || null, order.licensePlate, order.year ? String(order.year) : null]
              .filter(Boolean)
              .join(' · ') || '________________________'
          }
        />
        {motor && <Campo label="Motor" value={motor} />}
        {order.component && <Campo label="Trabajo a realizar" value={order.component} />}
      </div>

      {/* Renglones en blanco: lo único que todavía no existe. */}
      <div className="overflow-x-auto py-4">
        <table className="w-full table-fixed text-left text-[15px]">
          <thead className="border-b-2 border-line-strong text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="w-24 py-2 pr-2">Código</th>
              <th className="py-2 pr-2">Descripción</th>
              <th className="w-16 py-2 pr-2 text-right">Cant.</th>
              <th className="w-28 py-2 text-right">P. unitario</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: filas }).map((_, idx) => (
              <tr key={idx} className="h-9 border-b border-line">
                <td className="pr-2" />
                <td className="pr-2" />
                <td className="pr-2" />
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Observaciones y firma, a mano. */}
      <div className="mt-2 grid grid-cols-1 gap-6 border-t border-line pt-4 sm:grid-cols-2">
        <div>
          <span className="mb-1 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-faint">
            Observaciones
          </span>
          <div className="h-24 border border-line-strong" />
        </div>
        <div className="flex flex-col justify-end">
          <div className="border-t border-ink pt-1 text-center text-[13px] text-text-soft">
            Firma del cliente
          </div>
        </div>
      </div>

      <p className="mt-6 border-t border-line pt-3 text-center text-[13px] text-text-faint">
        Comprobante interno de uso del taller: no reemplaza al presupuesto ni a
        la factura. Impreso el {formatDate(new Date().toISOString().slice(0, 10))}.
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
