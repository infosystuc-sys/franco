import React from 'react';
import { XCircle, FileSpreadsheet, Play, Search, Printer, ChevronRight, ChevronDown } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { cn, todayLocal, coincideBusqueda } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { ordenarFilas, type Orden } from '@/src/lib/ordenar';
import { ThOrdenable } from '@/src/components/ThOrdenable';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  agruparFilas,
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

/** "FACTURA A" → { clase: 'FACTURA', letra: 'A' }; "NOTA DE CREDITO B" → { 'NOTA DE CREDITO', 'B' }. */
function partirTipo(tipo: unknown): { clase: string; letra: string } {
  const t = String(tipo ?? '').trim();
  const m = t.match(/^(.*?)\s+([A-Z])$/);
  return m ? { clase: m[1], letra: m[2] } : { clase: t, letra: '' };
}

function nombreDeClase(clase: string): string {
  return clase === 'FACTURA' ? 'Facturas' : clase === 'NOTA DE CREDITO' ? 'Notas de crédito' : clase === 'NOTA DE DEBITO' ? 'Notas de débito' : clase;
}

/** Botones de a uno, que se prenden y apagan: para elegir uno o varios. */
function ChipsDeFiltro({
  titulo,
  opciones,
  elegidos,
  onChange,
}: {
  titulo: string;
  opciones: { valor: string; etiqueta: string }[];
  elegidos: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-text-soft">{titulo}</span>
      <div className="flex gap-1">
        {opciones.map((o) => {
          const prendido = elegidos.includes(o.valor);
          return (
            <button
              key={o.valor}
              type="button"
              aria-pressed={prendido}
              onClick={() => onChange(prendido ? elegidos.filter((x) => x !== o.valor) : [...elegidos, o.valor])}
              className={cn(
                'h-9 min-w-9 rounded-[3px] border px-3 text-[15px] font-semibold transition-colors',
                prendido ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-panel text-text-soft hover:text-text'
              )}
            >
              {o.etiqueta}
            </button>
          );
        })}
      </div>
    </div>
  );
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
  /** Grupos desplegados. Arrancan todos cerrados: la primera vista es un renglón por grupo. */
  const [abiertos, setAbiertos] = React.useState<Set<string>>(new Set());
  // Tipos de comprobante elegidos (letra y clase). Vacío = todos.
  const [letras, setLetras] = React.useState<string[]>([]);
  const [clases, setClases] = React.useState<string[]>([]);

  // Qué letras y clases hay en lo consultado: "FACTURA A" → clase FACTURA, letra A.
  const tiposPresentes = React.useMemo(() => {
    const ls = new Set<string>();
    const cs = new Set<string>();
    for (const r of rows ?? []) {
      const { clase, letra } = partirTipo(r.tipo);
      if (letra) ls.add(letra);
      if (clase) cs.add(clase);
    }
    return { letras: [...ls].sort(), clases: [...cs].sort() };
  }, [rows]);

  React.useEffect(() => {
    setLetras([]);
    setClases([]);
    setOrden(null);
  }, [rows]);

  const filtradas = React.useMemo(() => {
    if (!rows) return [];
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (report?.filtraPorTipo && (letras.length > 0 || clases.length > 0)) {
        const { clase, letra } = partirTipo(row.tipo);
        if (letras.length > 0 && !letras.includes(letra)) return false;
        if (clases.length > 0 && !clases.includes(clase)) return false;
      }
      return !term || coincideBusqueda(term, Object.values(row));
    });
  }, [rows, search, letras, clases, report]);

  // Orden por columna: un click en el título ordena, otro invierte, otro
  // vuelve al orden del informe. Lo que se imprime y se exporta sale así.
  const [orden, setOrden] = React.useState<Orden | null>(null);
  const filtered = React.useMemo(
    () => ordenarFilas(filtradas, orden, (row, columna) => row[columna]),
    [filtradas, orden]
  );

  // Los totales se calculan sobre lo FILTRADO, no sobre todo: si alguien
  // busca un cliente, el total tiene que ser el de ese cliente. Un total que
  // no se corresponde con lo que se ve en pantalla es peor que no mostrarlo.
  const totals = React.useMemo(
    () => (report ? computeTotals(filtered, report.columns) : {}),
    [filtered, report]
  );

  const grupos = React.useMemo(
    () => (report?.agruparPor ? agruparFilas(filtered, report.agruparPor) : null),
    [filtered, report]
  );

  function alternarGrupo(clave: string) {
    setAbiertos((actual) => {
      const nuevo = new Set(actual);
      if (nuevo.has(clave)) nuevo.delete(clave);
      else nuevo.add(clave);
      return nuevo;
    });
  }

  if (role !== 'admin' && role !== 'contador') return <Navigate to="/" replace />;
  if (!report) return <Navigate to="/informes" replace />;
  // El contador solo entra a informes del área impositiva — a uno de otra
  // área no llega por el catálogo (ya está filtrado), pero si fuerza la URL
  // directo, se lo manda de vuelta acá en vez de mostrárselo.
  if (role === 'contador' && report.area !== 'IMPOSITIVO') return <Navigate to="/informes" replace />;

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
    <div className="w-full">
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

            {report.filtraPorTipo && rows && rows.length > 0 && (
              <>
                {tiposPresentes.letras.length > 1 && (
                  <ChipsDeFiltro
                    titulo="Letra"
                    opciones={tiposPresentes.letras.map((l) => ({ valor: l, etiqueta: l }))}
                    elegidos={letras}
                    onChange={setLetras}
                  />
                )}
                {tiposPresentes.clases.length > 1 && (
                  <ChipsDeFiltro
                    titulo="Comprobante"
                    opciones={tiposPresentes.clases.map((c) => ({ valor: c, etiqueta: nombreDeClase(c) }))}
                    elegidos={clases}
                    onChange={setClases}
                  />
                )}
              </>
            )}

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
              {grupos && (
                <>
                  {grupos.length} {grupos.length === 1 ? 'grupo' : 'grupos'} ·{' '}
                  <button
                    type="button"
                    onClick={() =>
                      setAbiertos(
                        abiertos.size === grupos.length ? new Set() : new Set(grupos.map((g) => g.clave))
                      )
                    }
                    className="no-print font-semibold text-accent-deep hover:underline"
                  >
                    {abiertos.size === grupos.length ? 'Ocultar el detalle' : 'Ver el detalle de todos'}
                  </button>
                  {' · '}
                </>
              )}
              {filtered.length === rows.length
                ? `${rows.length} ${rows.length === 1 ? 'registro' : 'registros'}`
                : `${filtered.length} de ${rows.length} registros`}
            </span>
            {ranWith && report.usesPeriod && (
              <span className="font-mono text-[13px]">
                {ranWith.from} — {ranWith.to}
              </span>
            )}
          </div>

          <Panel className="overflow-x-auto overflow-y-hidden">
            <table className="w-full text-left text-[14px]">
              <thead className="h-9 bg-panel-head text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <tr>
                  {report.columns.map((column) => (
                    <ThOrdenable
                      key={column.key}
                      columna={column.key}
                      orden={orden}
                      onOrden={setOrden}
                      className={cn('px-3 py-1', isNumeric(column.format) && 'text-right')}
                    >
                      {column.label}
                    </ThOrdenable>
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

                {grupos &&
                  grupos.map((grupo) => {
                    const abierto = abiertos.has(grupo.clave);
                    const sub = computeTotals(grupo.filas, report.columns);
                    return (
                      <React.Fragment key={grupo.clave}>
                        <tr
                          onClick={() => alternarGrupo(grupo.clave)}
                          className="h-9 cursor-pointer border-b border-line bg-panel-head/60 font-semibold hover:bg-panel-head"
                        >
                          {report.columns.map((column, index) => {
                            const negative = column.total && Number(sub[column.key]) < 0;
                            return (
                              <td
                                key={column.key}
                                className={cn(
                                  'px-3 py-1',
                                  isNumeric(column.format) && 'text-right font-mono',
                                  negative && 'text-state-done'
                                )}
                              >
                                {index === 0 ? (
                                  <span className="inline-flex items-center gap-1">
                                    {abierto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    {grupo.clave}
                                    <span className="ml-1 text-[12px] font-normal text-text-faint">
                                      ({grupo.filas.length})
                                    </span>
                                  </span>
                                ) : column.total ? (
                                  formatCell(sub[column.key], column.format)
                                ) : (
                                  ''
                                )}
                              </td>
                            );
                          })}
                        </tr>
                        {abierto &&
                          grupo.filas.map((row, idx) => (
                            <tr key={idx} className="h-8 border-b border-line bg-panel">
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
                                    {column.key === report.agruparPor ? '' : formatCell(value, column.format)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                      </React.Fragment>
                    );
                  })}

                {!grupos && filtered.map((row, idx) => (
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
