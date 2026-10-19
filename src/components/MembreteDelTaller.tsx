import React from 'react';
import { formatDate } from '@/src/lib/utils';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import { fetchTallerHeader, formatAddress, type TallerHeader } from '@/src/lib/companySettings';
import logoPorDefecto from '@/src/assets/logo-luciano-diesel.png';

/**
 * Membrete del taller para los informes que se mandan al cliente (la
 * composición de saldos): el logo y los datos de la empresa a la izquierda,
 * qué documento es a la derecha. Igual que el del presupuesto.
 *
 * En pantalla no se ve —arriba ya están el título y la botonera—: sale al
 * imprimir y en el PDF que se manda (pdf.ts muestra lo marcado con
 * data-solo-pdf).
 */
export function MembreteDelTaller({ titulo, lineas }: { titulo: string; lineas: React.ReactNode[] }) {
  const [taller, setTaller] = React.useState<TallerHeader | null>(null);

  React.useEffect(() => {
    let vigente = true;
    fetchTallerHeader()
      .then((t) => vigente && setTaller(t))
      .catch(() => {/* sin datos, sale solo el logo */});
    return () => { vigente = false; };
  }, []);

  const domicilio = taller ? formatAddress(taller) : '';

  return (
    <div
      data-solo-pdf
      className="mb-4 hidden grid-cols-[1fr_auto] gap-6 border-b-2 border-ink pb-4 print:grid"
    >
      <div>
        <img src={taller?.logo ?? logoPorDefecto} alt={taller?.tradeName ?? ''} className="h-12 w-auto object-contain" />
        {taller && (
          <>
            <h2 className="mt-2 font-display text-xl font-medium uppercase leading-tight text-text">
              {taller.legalName}
            </h2>
            <dl className="mt-1 space-y-0.5 text-[13px] text-text-soft">
              {domicilio && <dd>{domicilio}</dd>}
              <dd>
                {TAX_CONDITION_LABELS[taller.taxCondition]}
                {taller.taxId && <span className="font-mono"> · CUIT {formatCuit(taller.taxId)}</span>}
              </dd>
              {taller.grossIncome && <dd>Ingresos Brutos {taller.grossIncome}</dd>}
              {taller.activityStartDate && <dd>Inicio de actividades {formatDate(taller.activityStartDate)}</dd>}
              {(taller.phone || taller.email) && <dd>{[taller.phone, taller.email].filter(Boolean).join(' · ')}</dd>}
            </dl>
          </>
        )}
      </div>
      <div className="text-right">
        <h3 className="font-display text-xl uppercase tracking-[0.08em] text-text-faint">{titulo}</h3>
        <dl className="mt-1 space-y-0.5 text-[14px] text-text-soft">
          {lineas.map((l, i) => (
            <dd key={i}>{l}</dd>
          ))}
        </dl>
      </div>
    </div>
  );
}
