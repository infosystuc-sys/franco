import React from 'react';
import { BarChart3, ArrowRight, Clock } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { AREA_LABELS, AREAS, REPORTS, type ReportArea } from '@/src/lib/reports';

/**
 * Catálogo de informes, agrupado por área como el árbol de un sistema de
 * gestión. Cada tarjeta dice qué pregunta responde el informe: un nombre solo
 * ("Composición de saldos") no alcanza para elegir sin abrirlo.
 */
export function Reports() {
  const { role } = useAuth();
  if (role !== 'admin' && role !== 'contador') return <Navigate to="/" replace />;

  // El contador solo ve el área impositiva — el resto del catálogo (comercial,
  // cuentas corrientes, stock y tesorería) queda fuera de su acceso.
  const areas = role === 'contador' ? AREAS.filter((a) => a === 'IMPOSITIVO') : AREAS;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Informes"
        subtitle="Consultas de gestión. Todas se ven en pantalla y se exportan a Excel."
      />

      {areas.map((area) => {
        const reports = REPORTS.filter((r) => r.area === area);
        if (reports.length === 0) return <PendingArea key={area} area={area} />;

        return (
          <section key={area}>
            <SectionHeader title={AREA_LABELS[area]} />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {reports.map((report) => (
                <Link key={report.id} to={`/informe/${report.id}`} className="group">
                  <Panel className="flex h-full items-start gap-3 p-4 transition-colors hover:bg-panel-alt">
                    <BarChart3 size={18} className="mt-0.5 shrink-0 text-accent-deep" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="font-display text-base uppercase tracking-[0.04em] text-text">
                          {report.name}
                        </span>
                        <ArrowRight
                          size={14}
                          className="text-text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent-deep"
                        />
                      </span>
                      <span className="mt-1 block text-xs text-text-soft">{report.description}</span>
                      <span className="mt-1.5 block text-[10px] uppercase tracking-[0.08em] text-text-faint">
                        {report.usesPeriod ? 'Por período' : 'A la fecha'}
                      </span>
                    </span>
                  </Panel>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Un área sin informes todavía. Se muestra igual, para que se sepa qué falta
 * en vez de que el área simplemente no exista.
 */
function PendingArea({ area }: { area: ReportArea }) {
  return (
    <section>
      <SectionHeader title={AREA_LABELS[area]} />
      <Panel className="flex items-center gap-2 p-4 text-sm text-text-soft">
        <Clock size={16} className="shrink-0 text-text-faint" />
        {area === 'IMPOSITIVO'
          ? 'Libros de IVA y retenciones: llegan en la etapa siguiente.'
          : 'Stock valorizado, libro de caja y cheques: llegan en la etapa siguiente.'}
      </Panel>
    </section>
  );
}
