import React from 'react';
import { XCircle, FileSpreadsheet, Play, Search, Printer } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { cn, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  computeTotals,
  describeReportError,
  exportReportToExcel,
  findReport,
  formatCell,
  isNumeric,
  type ReportParams,
} from '@/src/lib/reports';

/** Primer día del mes corriente, que es el arranque natural de un período. */
function firstOfMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Visor genérico de informes.
 *
 * Una sola pantalla para todo el catálogo: los filtros, la grilla, los totales
 * y la exportación salen de la definición del informe. Si cada informe armara
 * lo suyo, terminarían con filtros distintos y el Excel de uno andando mejor
 * que el de otro.
 */
export function ReportView() {
  const { role } = useAuth();
  const { id } = useParams();
  const report = findReport(id ?? '');

  const [from, setFrom] = React.useState(firstOfMonth());
  const [to, setTo] = React.useState(todayLocal());
  const [rows, setRows] = React.useState<Record<string, unknown>[] | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [ranWith, setRanWith] = React.useState<ReportParams | null>(null);

  const filtered = React.useMemo(() => {
    if (!rows) return [];
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) =>
      Object.values(row).some((v) => v !== null && String(v).toLowerCase().includes(term))
    );
  }, [rows, search]);

  // Los totales se calculan sobre lo FILTRADO, no sobre todo: si alguien
  // busca un cliente, el total tiene que ser el de ese cliente. Un total que
  // no se corresponde con lo que se ve en pantalla es peor que no mostrarlo.
  const totals = React.useMemo(
    () => (report ? computeTotals(filtered, report.columns) : {}),
    [filtered, report]
  );

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (!report) return <Navigate to="/informes" replace />;

  const params: ReportParams = { from, to };
  const periodInvalid = report.usesPeriod && from > to;

  async function handleRun() {
    if (!report || periodInvalid) return;
    setRunning(true);
    setError(null);
    try {
      const data = await report.run(params);
      setRows(data);
      setRanWith(params);
    } catch (err) {
      setError(describeReportError(getErrorMessage(err)));
      setRows(null);
    } finally {
      setRunning(false);
    }
  }

  function handleExport() {
    if (!report || !rows) return;
    // Se exporta lo que se ve, filtro incluido.
    exportReportToExcel(report, filtered, ranWith ?? params);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="no-print">
        <PageHeader
          title={report.name}
          subtitle={report.description}
          actions={
            <>
              <Link to="/informes">
                <Button variant="ghost" type="button"><XCircle size={16} /> Volver</Button>
              </Link>
              {rows && rows.length > 0 && (
                <>
                  <Button variant="ghost" type="button" onClick={() => window.print()}>
                    <Printer size={16} /> Imprimir
                  </Button>
                  <Button variant="secondary" type="button" onClick={handleExport}>
                    <FileSpreadsheet size={16} /> Exportar a Excel
                  </Button>
                </>
              )}
            </>
          }
        />

        {error && (
          <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        <Panel className="mb-6 p-5">
          <div className="flex flex-wrap items-end gap-3">
            {report.usesPeriod ? (
              <>
                <label className={labelClass}>
                  Desde
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className={cn(inputClass, periodInvalid && 'border-danger bg-danger-soft')}
                  />
                </label>
                <label className={labelClass}>
                  Hasta
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className={cn(inputClass, periodInvalid && 'border-danger bg-danger-soft')}
                  />
                </label>
              </>
            ) : (
              <p className="text-sm text-text-soft">
                Este informe es a la fecha de hoy: no lleva período.
              </p>
            )}

            <Button onClick={handleRun} disabled={running || periodInvalid}>
              <Play size={16} /> {running ? 'Consultando…' : 'Consultar'}
            </Button>

            {rows && rows.length > 0 && (
              <div className="relative ml-auto w-full sm:w-64">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filtrar en el resultado…"
                  className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
                />
              </div>
            )}
          </div>

          {periodInvalid && (
            <p className="mt-2 text-xs text-danger">La fecha «desde» es posterior a «hasta».</p>
          )}
        </Panel>
      </div>

      {rows === null && !running && (
        <Panel className="p-10 text-center text-text-soft">
          Elegí el {report.usesPeriod ? 'período y ' : ''}apretá <strong>Consultar</strong>.
        </Panel>
      )}

      {rows !== null && (
        <div className="print-document">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-xs text-text-soft">
            <span>
              {filtered.length === rows.length
                ? `${rows.length} ${rows.length === 1 ? 'registro' : 'registros'}`
                : `${filtered.length} de ${rows.length} registros`}
            </span>
            {ranWith && report.usesPeriod && (
              <span className="font-mono text-[11px]">
                {ranWith.from} — {ranWith.to}
              </span>
            )}
          </div>

          <Panel className="overflow-x-auto overflow-y-hidden">
            <table className="w-full text-left text-[12px]">
              <thead className="h-9 bg-panel-head text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <tr>
                  {report.columns.map((column) => (
                    <th
                      key={column.key}
                      className={cn('px-3 py-1', isNumeric(column.format) && 'text-right')}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={report.columns.length}
                      className="px-4 py-10 text-center text-text-soft"
                    >
                      {rows.length === 0
                        ? 'El informe no devolvió datos para ese criterio.'
                        : 'Ningún registro coincide con el filtro.'}
                    </td>
                  </tr>
                )}

                {filtered.map((row, idx) => (
                  <tr
                    key={idx}
                    className={cn('h-8 border-b border-line', idx % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}
                  >
                    {report.columns.map((column) => {
                      const value = row[column.key];
                      const negative = isNumeric(column.format) && Number(value) < 0;
                      return (
                        <td
                          key={column.key}
                          className={cn(
                            'px-3 py-1',
                            isNumeric(column.format) && 'text-right font-mono',
                            negative && 'text-danger'
                          )}
                        >
                          {formatCell(value, column.format)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>

              {filtered.length > 0 && report.columns.some((c) => c.total) && (
                <tfoot className="border-t-2 border-ink bg-panel-head">
                  <tr className="h-10">
                    {report.columns.map((column, index) => (
                      <td
                        key={column.key}
                        className={cn(
                          'px-3 py-2 font-semibold',
                          isNumeric(column.format) && 'text-right font-mono'
                        )}
                      >
                        {column.total
                          ? formatCell(totals[column.key], column.format)
                          : index === 0
                            ? 'TOTALES'
                            : ''}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </Panel>
        </div>
      )}
    </div>
  );
}
