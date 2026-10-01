import React from 'react';
import { Download, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchCustomers, type Customer } from '@/src/lib/customers';
import { CargaSaldosEnPantalla } from '@/src/components/CargaSaldosEnPantalla';
import {
  contarSaldosInicialesCargados,
  descargarPlanillaModelo,
  importarSaldosIniciales,
  leerPlanillaDeSaldos,
  type FilaSaldoInicial,
  type ResultadoImportacion,
} from '@/src/lib/saldosIniciales';

/** A qué cliente va a ir cada fila: el mismo criterio que la base al importar. */
function clienteDe(fila: FilaSaldoInicial, clientes: Customer[]): Customer | null {
  const cuit = fila.cuit.replace(/\D/g, '');
  if (cuit) {
    const porCuit = clientes.find((c) => (c.taxId ?? '') === cuit);
    if (porCuit) return porCuit;
  }
  const nombre = fila.cliente.trim().toLowerCase();
  return (nombre && clientes.find((c) => c.name.trim().toLowerCase() === nombre)) || null;
}

/**
 * Carga de la composición inicial de saldos de clientes: lo que cada uno
 * debía (o tenía a favor) en el sistema anterior al empezar a usar la app.
 *
 * Se revisa la planilla entera antes de importar —qué cliente existe, cuál se
 * va a crear, qué filas tienen errores— y recién ahí se confirma. La
 * importación es todo o nada.
 */
export function SaldosInicialesClientes() {
  const { role } = useAuth();
  const [clientes, setClientes] = React.useState<Customer[]>([]);
  // Las dos formas de cargar: a mano, un cliente a la vez, o una planilla entera.
  const [modo, setModo] = React.useState<'pantalla' | 'excel'>('pantalla');
  const [yaCargados, setYaCargados] = React.useState(0);
  const [archivo, setArchivo] = React.useState<string | null>(null);
  const [filas, setFilas] = React.useState<FilaSaldoInicial[] | null>(null);
  const [leyendo, setLeyendo] = React.useState(false);
  const [importando, setImportando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resultado, setResultado] = React.useState<ResultadoImportacion | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const cargarContexto = React.useCallback(async () => {
    try {
      const [c, n] = await Promise.all([fetchCustomers(), contarSaldosInicialesCargados()]);
      setClientes(c);
      setYaCargados(n);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  React.useEffect(() => { cargarContexto(); }, [cargarContexto]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function elegirArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLeyendo(true);
    setError(null);
    setResultado(null);
    setFilas(null);
    try {
      setFilas(await leerPlanillaDeSaldos(file));
      setArchivo(file.name);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLeyendo(false);
    }
  }

  const conErrores = filas?.filter((f) => f.errores.length > 0).length ?? 0;
  const deudas = filas?.filter((f) => (f.importe ?? 0) > 0) ?? [];
  const aFavor = filas?.filter((f) => (f.importe ?? 0) < 0) ?? [];
  const totalDeuda = deudas.reduce((s, f) => s + (f.importe ?? 0), 0);
  const totalAFavor = aFavor.reduce((s, f) => s - (f.importe ?? 0), 0);
  const nuevos = new Set(
    (filas ?? [])
      .filter((f) => f.errores.length === 0 && !clienteDe(f, clientes))
      .map((f) => f.cuit.replace(/\D/g, '') || f.cliente.trim().toLowerCase())
  ).size;

  async function importar() {
    if (!filas || conErrores > 0) return;
    const aviso =
      yaCargados > 0
        ? `\n\nOjo: ya hay ${yaCargados} saldos iniciales cargados. Si esta planilla los repite, van a quedar dos veces.`
        : '';
    if (
      !window.confirm(
        `Importar ${filas.length} saldos iniciales: $ ${formatMoney(totalDeuda)} de deuda y ` +
          `$ ${formatMoney(totalAFavor)} a favor${nuevos > 0 ? `, creando ${nuevos} clientes nuevos` : ''}.${aviso}`
      )
    ) {
      return;
    }
    setImportando(true);
    setError(null);
    try {
      setResultado(await importarSaldosIniciales(filas));
      setFilas(null);
      setArchivo(null);
      await cargarContexto();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Saldos iniciales de clientes"
        subtitle="Lo que cada cliente debía, o tenía a favor, en el sistema anterior. Se carga a mano, cliente por cliente, o con una planilla."
        actions={
          modo === 'excel' && (
          <>
            <Button variant="ghost" type="button" onClick={descargarPlanillaModelo}>
              <Download size={16} /> Planilla modelo
            </Button>
            <Button type="button" onClick={() => inputRef.current?.click()} disabled={leyendo || importando}>
              <Upload size={16} /> {leyendo ? 'Leyendo…' : 'Elegir planilla'}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={elegirArchivo}
              className="hidden"
            />
          </>
          )
        }
      />

      <div className="flex gap-1 border-b border-line">
        {(
          [
            ['pantalla', 'Cargar en pantalla'],
            ['excel', 'Importar desde Excel'],
          ] as const
        ).map(([clave, rotulo]) => (
          <button
            key={clave}
            type="button"
            onClick={() => setModo(clave)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-semibold uppercase tracking-[0.06em] transition-colors',
              modo === clave
                ? 'border-accent text-text'
                : 'border-transparent text-text-soft hover:text-text'
            )}
          >
            {rotulo}
          </button>
        ))}
      </div>

      {modo === 'pantalla' && (
        <CargaSaldosEnPantalla
          clientes={clientes}
          onClienteNuevo={(c) => setClientes((cs) => [...cs, c].sort((x, y) => x.name.localeCompare(y.name)))}
          onCargado={cargarContexto}
        />
      )}

      {modo === 'excel' && (
      <>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {resultado && (
        <div className="flex items-start gap-2 rounded-md border border-state-done/40 bg-panel px-4 py-3 text-sm text-text">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-state-done" />
          <span>
            Listo: {resultado.deudas} deudas por $ {formatMoney(resultado.totalDeuda)}
            {resultado.aFavor > 0 && ` y ${resultado.aFavor} saldos a favor por $ ${formatMoney(resultado.totalAFavor)}`}
            {resultado.clientesCreados > 0 && `, y se crearon ${resultado.clientesCreados} clientes`}.
            {' '}
            <Link to="/cuenta-corriente-clientes" className="font-semibold text-accent-deep hover:underline">
              Ver la cuenta corriente
            </Link>
            {resultado.clientesCreados > 0 && (
              <>
                {' · '}
                <Link to="/clientes" className="font-semibold text-accent-deep hover:underline">
                  Completar la ficha de los clientes nuevos
                </Link>
              </>
            )}
          </span>
        </div>
      )}

      {!filas && (
        <Panel className="space-y-3 p-5 text-sm text-text-soft">
          <p>
            Una fila por comprobante pendiente del sistema anterior, con estas columnas:{' '}
            <strong className="text-text">Cliente, CUIT, Comprobante, Fecha, Vencimiento, Importe</strong>.
            Obligatorios: el cliente (o su CUIT) y el importe.
          </p>
          <p>
            También sirve tal cual la <strong className="text-text">composición de saldos del sistema anterior</strong>,
            con columnas <strong className="text-text">Debe</strong> y <strong className="text-text">Haber</strong>: la
            columna Total (el acumulado) no se lee, y cada cobro que viene en una fila aparte con{' '}
            <strong className="text-text">Comprobante aplicado</strong> se descuenta de la factura de arriba, que
            entra con lo que queda debiendo.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Importe positivo: lo que el cliente debe. Negativo: lo que tiene a favor.</li>
            <li>
              El cliente se busca por CUIT y, si no trae, por el nombre exacto. Si no existe, se crea
              —después conviene completarle la ficha: condición de IVA, domicilio, teléfono—.
            </li>
            <li>Sin vencimiento, vence el mismo día de la fecha. Sin fecha, se toma la de hoy.</li>
            <li>
              Un cliente nuevo con alguna factura A se crea como Responsable Inscripto; el resto, como
              Consumidor Final.
            </li>
            <li>
              Cada deuda se cobra con un recibo común, como una factura. No cuenta como venta ni
              entra en el Libro IVA: esas ventas ya se declararon en el sistema anterior.
            </li>
          </ul>
          {yaCargados > 0 && (
            <p className="flex items-center gap-1.5 text-state-wait">
              <AlertTriangle size={15} /> Ya hay {yaCargados} saldos iniciales cargados.
            </p>
          )}
        </Panel>
      )}

      {filas && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Resumen label="Filas" valor={String(filas.length)} />
            <Resumen label="Deuda" valor={`$ ${formatMoney(totalDeuda)}`} />
            <Resumen label="A favor" valor={`$ ${formatMoney(totalAFavor)}`} />
            <Resumen label="Clientes nuevos" valor={String(nuevos)} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-text-soft">
              {archivo}
              {conErrores > 0 && (
                <span className="ml-2 font-semibold text-danger">
                  {conErrores} {conErrores === 1 ? 'fila tiene' : 'filas tienen'} errores: corregí la planilla y volvé a elegirla.
                </span>
              )}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" type="button" onClick={() => { setFilas(null); setArchivo(null); }}>
                Cancelar
              </Button>
              <Button type="button" onClick={importar} disabled={importando || conErrores > 0 || filas.length === 0}>
                {importando ? 'Importando…' : `Importar ${filas.length} saldos`}
              </Button>
            </div>
          </div>

          <Panel className="overflow-x-auto overflow-y-hidden">
            <table className="w-full text-left text-[14px]">
              <thead className="h-9 bg-panel-head text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <tr>
                  <th className="w-14 px-3 py-1">Fila</th>
                  <th className="px-3 py-1">Cliente</th>
                  <th className="px-3 py-1">Comprobante</th>
                  <th className="px-3 py-1">Fecha</th>
                  <th className="px-3 py-1">Vence</th>
                  <th className="px-3 py-1 text-right">Importe</th>
                  <th className="px-3 py-1">Estado</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => {
                  const existente = clienteDe(f, clientes);
                  return (
                    <tr key={f.filaExcel} className={cn('border-b border-line', f.errores.length > 0 && 'bg-danger-soft')}>
                      <td className="px-3 py-1.5 font-mono text-text-faint">{f.filaExcel}</td>
                      <td className="px-3 py-1.5">
                        <span className="font-semibold">{f.cliente || '—'}</span>
                        {f.cuit && <span className="ml-2 font-mono text-[12px] text-text-soft">{f.cuit}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-text-soft">
                        {f.comprobante || '—'}
                        {f.aplicado.map((a) => (
                          <span key={a} className="block text-[12px] text-state-done">− {a}</span>
                        ))}
                      </td>
                      <td className="px-3 py-1.5">{fechaLegible(f.fecha, 'hoy')}</td>
                      <td className="px-3 py-1.5">{fechaLegible(f.vencimiento, '—')}</td>
                      <td
                        className={cn(
                          'px-3 py-1.5 text-right font-mono',
                          (f.importe ?? 0) < 0 && 'text-state-done'
                        )}
                      >
                        {f.importe === null ? '—' : `$ ${formatMoney(f.importe)}`}
                      </td>
                      <td className="px-3 py-1.5 text-[13px]">
                        {f.errores.length > 0 ? (
                          <span className="font-semibold text-danger">{f.errores.join(' ')}</span>
                        ) : existente ? (
                          <span className="text-text-soft">Cliente existente</span>
                        ) : (
                          <span className="font-semibold text-state-wait">Se crea el cliente</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </>
      )}
      </>
      )}
    </div>
  );
}

function Resumen({ label, valor }: { label: string; valor: string }) {
  return (
    <Panel className="p-4">
      <span className="mb-1 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-faint">{label}</span>
      <span className="block font-display text-xl font-medium text-text">{valor}</span>
    </Panel>
  );
}

/** La fecha como se lee, o lo que corresponde si falta o no se entendió. */
function fechaLegible(fecha: string, siFalta: string): string {
  if (!fecha) return siFalta;
  if (fecha === 'INVALIDA') return '?';
  return formatDate(fecha);
}
