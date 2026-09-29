import React from 'react';
import { ArrowLeft, Download, Upload, CheckCircle2 } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import { CONDICION_VENTA_LABELS } from '@/src/lib/invoices';
import { fetchCustomers, type Customer } from '@/src/lib/customers';
import {
  descargarPlanillaModeloClientes,
  importarClientes,
  leerPlanillaDeClientes,
  type FilaCliente,
} from '@/src/lib/importacionClientes';

/** El mismo criterio que la base: por CUIT y, si no trae, por nombre exacto. */
function existenteDe(fila: FilaCliente, clientes: Customer[]): Customer | null {
  const cuit = fila.cuit.replace(/\D/g, '');
  if (cuit) {
    const porCuit = clientes.find((c) => (c.taxId ?? '') === cuit);
    if (porCuit) return porCuit;
  }
  const nombre = fila.nombre.trim().toLowerCase();
  return clientes.find((c) => c.name.trim().toLowerCase() === nombre) ?? null;
}

/**
 * Alta masiva de clientes desde una planilla. Se revisa entera antes de
 * importar: cuáles son nuevos, cuáles ya existen (y se completan con lo que
 * trae la planilla, sin borrar nada) y qué filas tienen errores.
 */
export function CustomersImport() {
  const { role } = useAuth();
  const [clientes, setClientes] = React.useState<Customer[]>([]);
  const [filas, setFilas] = React.useState<FilaCliente[] | null>(null);
  const [archivo, setArchivo] = React.useState<string | null>(null);
  const [leyendo, setLeyendo] = React.useState(false);
  const [importando, setImportando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resultado, setResultado] = React.useState<{ creados: number; actualizados: number } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const cargarClientes = React.useCallback(() => {
    fetchCustomers().then(setClientes).catch((err) => setError(getErrorMessage(err)));
  }, []);

  React.useEffect(() => { cargarClientes(); }, [cargarClientes]);

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
      setFilas(await leerPlanillaDeClientes(file));
      setArchivo(file.name);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLeyendo(false);
    }
  }

  const conErrores = filas?.filter((f) => f.errores.length > 0).length ?? 0;
  const existentes = filas?.filter((f) => f.errores.length === 0 && existenteDe(f, clientes)).length ?? 0;
  const nuevos = (filas?.length ?? 0) - conErrores - existentes;

  async function importar() {
    if (!filas || conErrores > 0) return;
    if (
      !window.confirm(
        `Importar ${filas.length} clientes: ${nuevos} nuevos y ${existentes} que ya existen ` +
          '(a esos se les completa lo que traiga la planilla, sin borrarles nada).'
      )
    ) {
      return;
    }
    setImportando(true);
    setError(null);
    try {
      setResultado(await importarClientes(filas));
      setFilas(null);
      setArchivo(null);
      cargarClientes();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Importar clientes"
        subtitle="Alta masiva desde una planilla de Excel."
        actions={
          <>
            <Link to="/clientes">
              <Button variant="ghost" type="button"><ArrowLeft size={16} /> Volver</Button>
            </Link>
            <Button variant="ghost" type="button" onClick={descargarPlanillaModeloClientes}>
              <Download size={16} /> Planilla modelo
            </Button>
            <Button type="button" onClick={() => inputRef.current?.click()} disabled={leyendo || importando}>
              <Upload size={16} /> {leyendo ? 'Leyendo…' : 'Elegir planilla'}
            </Button>
            <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" onChange={elegirArchivo} className="hidden" />
          </>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {resultado && (
        <div className="flex items-start gap-2 rounded-md border border-state-done/40 bg-panel px-4 py-3 text-sm text-text">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-state-done" />
          <span>
            Listo: {resultado.creados} clientes nuevos y {resultado.actualizados} actualizados.{' '}
            <Link to="/clientes" className="font-semibold text-accent-deep hover:underline">Ver clientes</Link>
          </span>
        </div>
      )}

      {!filas && (
        <Panel className="space-y-3 p-5 text-sm text-text-soft">
          <p>
            Una fila por cliente. Columnas que se reconocen:{' '}
            <strong className="text-text">
              Nombre, Razón social, CUIT, Condición IVA, Condición de venta, Email, Teléfono, Domicilio,
              Localidad, Provincia, CP, Observaciones
            </strong>
            . La única obligatoria es el nombre (o la razón social); el orden de las columnas no importa.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Condición IVA: Responsable Inscripto (o RI), Monotributo, Exento o Consumidor Final (o CF).
              Vacía, queda Consumidor Final.
            </li>
            <li>Condición de venta: Contado o Cuenta corriente. Vacía, queda sin definir.</li>
            <li>
              Si el cliente ya existe (mismo CUIT o, sin CUIT, mismo nombre), se le completan los datos que
              trae la planilla. Una celda vacía no le borra nada, y el nombre no se cambia.
            </li>
            <li>El teléfono se guarda también en el formato de WhatsApp, igual que al cargarlo a mano.</li>
          </ul>
        </Panel>
      )}

      {filas && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Resumen label="Filas" valor={filas.length} />
            <Resumen label="Nuevos" valor={nuevos} />
            <Resumen label="Ya existen" valor={existentes} />
            <Resumen label="Con errores" valor={conErrores} peligro={conErrores > 0} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-text-soft">
              {archivo}
              {conErrores > 0 && (
                <span className="ml-2 font-semibold text-danger">
                  Corregí las filas marcadas en la planilla y volvé a elegirla.
                </span>
              )}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" type="button" onClick={() => { setFilas(null); setArchivo(null); }}>
                Cancelar
              </Button>
              <Button type="button" onClick={importar} disabled={importando || conErrores > 0 || filas.length === 0}>
                {importando ? 'Importando…' : `Importar ${filas.length} clientes`}
              </Button>
            </div>
          </div>

          <Panel className="overflow-x-auto overflow-y-hidden">
            <table className="w-full text-left text-[14px]">
              <thead className="h-9 bg-panel-head text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                <tr>
                  <th className="w-14 px-3 py-1">Fila</th>
                  <th className="px-3 py-1">Cliente</th>
                  <th className="px-3 py-1">CUIT</th>
                  <th className="px-3 py-1">Cond. IVA</th>
                  <th className="px-3 py-1">Cond. venta</th>
                  <th className="px-3 py-1">Contacto</th>
                  <th className="px-3 py-1">Estado</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => {
                  const existente = existenteDe(f, clientes);
                  return (
                    <tr key={f.filaExcel} className={cn('border-b border-line', f.errores.length > 0 && 'bg-danger-soft')}>
                      <td className="px-3 py-1.5 font-mono text-text-faint">{f.filaExcel}</td>
                      <td className="px-3 py-1.5">
                        <span className="font-semibold">{f.nombre || '—'}</span>
                        {f.razonSocial && f.razonSocial !== f.nombre && (
                          <span className="block text-[12px] text-text-soft">{f.razonSocial}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 font-mono">{f.cuit || '—'}</td>
                      <td className="px-3 py-1.5">{f.condicionIva ? TAX_CONDITION_LABELS[f.condicionIva] : '—'}</td>
                      <td className="px-3 py-1.5">{f.condicionVenta ? CONDICION_VENTA_LABELS[f.condicionVenta] : '—'}</td>
                      <td className="px-3 py-1.5 text-[13px] text-text-soft">
                        {[f.telefono, f.email].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-1.5 text-[13px]">
                        {f.errores.length > 0 ? (
                          <span className="font-semibold text-danger">{f.errores.join(' ')}</span>
                        ) : existente ? (
                          <span className="text-text-soft">Ya existe ({existente.name}): se completa</span>
                        ) : (
                          <span className="font-semibold text-state-done">Nuevo</span>
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
    </div>
  );
}

function Resumen({ label, valor, peligro }: { label: string; valor: number; peligro?: boolean }) {
  return (
    <Panel className="p-4">
      <span className="mb-1 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-faint">{label}</span>
      <span className={cn('block font-display text-xl font-medium', peligro ? 'text-danger' : 'text-text')}>{valor}</span>
    </Panel>
  );
}
