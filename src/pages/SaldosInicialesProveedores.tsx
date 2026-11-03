import React from 'react';
import { CheckCircle2, Plus, Save, Trash2, X } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { ClienteCombobox } from '@/src/components/ClienteCombobox';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { describePurchaseError, eliminarComprobanteDeCompra } from '@/src/lib/purchases';
import {
  cargarSaldosInicialesProveedores,
  describeSaldoInicialProveedorError,
  fetchSaldosInicialesProveedores,
  type SaldoInicialProveedor,
} from '@/src/lib/saldosIniciales';

interface Fila {
  supplierId: string;
  comprobante: string;
  fecha: string;
  vencimiento: string;
  importe: string;
}

const FILA_VACIA: Fila = { supplierId: '', comprobante: '', fecha: '', vencimiento: '', importe: '' };

const celda = 'h-9 w-full rounded-[3px] border border-line bg-panel px-2 text-[13px] text-text focus:border-accent focus:outline-none';

function importeDe(fila: Fila): number {
  const n = Number(fila.importe);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Una fila vacía no cuenta: se ignora al guardar. */
function estaVacia(fila: Fila): boolean {
  return !fila.supplierId && !fila.comprobante.trim() && !fila.importe.trim();
}

function estaCompleta(fila: Fila, fechaInicio: string): boolean {
  const fecha = fila.fecha || fechaInicio;
  return !!fila.supplierId && !!fecha && importeDe(fila) > 0 && (!fila.vencimiento || fila.vencimiento >= fecha);
}

/**
 * Saldos iniciales de proveedores: lo que se les debía al empezar a usar la
 * app. Cada deuda queda pendiente en Pagos y se cancela con una orden de pago
 * —en efectivo, transferencia o endosando cheques de la cartera—, sin pasar
 * por el Libro IVA Compras.
 */
export function SaldosInicialesProveedores() {
  const { role } = useAuth();
  const [fechaInicio, setFechaInicio] = React.useState(todayLocal());
  const [filas, setFilas] = React.useState<Fila[]>([{ ...FILA_VACIA }]);
  const [proveedores, setProveedores] = React.useState<Supplier[]>([]);
  const [cargados, setCargados] = React.useState<SaldoInicialProveedor[]>([]);
  const [guardando, setGuardando] = React.useState(false);
  const [borrando, setBorrando] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);

  const recargar = React.useCallback(async () => {
    try {
      setCargados(await fetchSaldosInicialesProveedores());
    } catch (err) {
      setError(describeSaldoInicialProveedorError(getErrorMessage(err)));
    }
  }, []);

  React.useEffect(() => {
    if (role !== 'admin') return;
    fetchSuppliers(true).then(setProveedores).catch((err) => setError(getErrorMessage(err)));
    recargar();
  }, [role, recargar]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  function cambiar(i: number, cambio: Partial<Fila>) {
    setFilas((actuales) => actuales.map((f, j) => (j === i ? { ...f, ...cambio } : f)));
  }

  const aCargar = filas.filter((f) => !estaVacia(f));
  const incompletas = aCargar.filter((f) => !estaCompleta(f, fechaInicio)).length;
  const total = aCargar.reduce((s, f) => s + importeDe(f), 0);
  const pendienteCargado = cargados.reduce((s, c) => s + c.importe - c.pagado, 0);
  const puedeGuardar = aCargar.length > 0 && incompletas === 0 && !guardando;

  async function guardar() {
    if (!puedeGuardar) return;
    if (
      !window.confirm(
        `Cargar ${aCargar.length} saldo${aCargar.length === 1 ? '' : 's'} a pagar por $ ${formatMoney(total)}?`
      )
    ) return;
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const n = await cargarSaldosInicialesProveedores(
        aCargar.map((f) => ({
          supplierId: f.supplierId,
          comprobante: f.comprobante,
          fecha: f.fecha || fechaInicio,
          vencimiento: f.vencimiento,
          importe: importeDe(f),
        }))
      );
      setAviso(`Se cargaron ${n} saldo${n === 1 ? '' : 's'}. Ya figuran como pendientes en Pagos.`);
      setFilas([{ ...FILA_VACIA }]);
      await recargar();
    } catch (err) {
      setError(describeSaldoInicialProveedorError(getErrorMessage(err)));
    } finally {
      setGuardando(false);
    }
  }

  async function borrar(s: SaldoInicialProveedor) {
    if (!window.confirm(`¿Borrar el saldo inicial de ${s.supplierName} por $ ${formatMoney(s.importe)}?`)) return;
    setBorrando(s.id);
    setError(null);
    setAviso(null);
    try {
      await eliminarComprobanteDeCompra(s.id);
      await recargar();
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
    } finally {
      setBorrando(null);
    }
  }

  return (
    <div className="w-full">
      <PageHeader
        title="Saldos iniciales de proveedores"
        subtitle="Lo que se le debía a cada proveedor al empezar a usar la app."
        actions={
          <>
            <Link to="/pagos">
              <Button variant="ghost" type="button"><X size={16} /> Ir a Pagos</Button>
            </Link>
            <Button onClick={guardar} disabled={!puedeGuardar}>
              <Save size={16} /> {guardando ? 'Cargando…' : 'Cargar saldos'}
            </Button>
          </>
        }
      />

      {error && <div className="mb-4 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}
      {aviso && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-line-strong bg-panel-alt px-4 py-3 text-sm text-text">
          <CheckCircle2 size={16} className="text-state-ok" /> {aviso}
        </div>
      )}

      <Panel className="mb-6 space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-4">
          <label className={labelClass}>
            Fecha de inicio
            <input
              type="date"
              value={fechaInicio}
              onChange={(e) => setFechaInicio(e.target.value)}
              className={cn(inputClass, !fechaInicio && 'field-required')}
            />
          </label>
          <p className="max-w-xl flex-1 text-xs text-text-soft">
            Se usa como fecha de la deuda cuando la fila no tiene una. Cada saldo queda pendiente en Pagos y se cancela
            con una orden de pago, también endosando cheques de la cartera. No es una compra: no entra al Libro IVA
            Compras. En Comprobante podés poner el número del proveedor (“A 0001-00001234”) o cualquier referencia.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-text-faint">
                <th className="pb-1.5 pr-2">Proveedor *</th>
                <th className="w-48 pb-1.5 pr-2">Comprobante</th>
                <th className="w-36 pb-1.5 pr-2">Fecha</th>
                <th className="w-36 pb-1.5 pr-2">Vencimiento</th>
                <th className="w-36 pb-1.5 pr-2 text-right">Importe *</th>
                <th className="w-8 pb-1.5" />
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => {
                const marcar = !estaVacia(f);
                const fecha = f.fecha || fechaInicio;
                return (
                  <tr key={i} className="align-top">
                    <td className="py-1 pr-2">
                      <ClienteCombobox
                        entidad="proveedor"
                        clientes={proveedores}
                        value={f.supplierId}
                        onChange={(id) => cambiar(i, { supplierId: id })}
                        className={cn(marcar && !f.supplierId && 'field-required')}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        value={f.comprobante}
                        onChange={(e) => cambiar(i, { comprobante: e.target.value })}
                        placeholder="A 0001-00001234"
                        className={cn(celda, 'font-mono')}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input type="date" value={f.fecha} onChange={(e) => cambiar(i, { fecha: e.target.value })} className={celda} />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="date"
                        value={f.vencimiento}
                        onChange={(e) => cambiar(i, { vencimiento: e.target.value })}
                        className={cn(celda, f.vencimiento && fecha && f.vencimiento < fecha && 'field-required')}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={f.importe}
                        onChange={(e) => cambiar(i, { importe: e.target.value })}
                        onKeyDown={(e) => {
                          // Enter en el importe de la última fila agrega otra: se carga de corrido.
                          if (e.key === 'Enter' && i === filas.length - 1) {
                            e.preventDefault();
                            setFilas((actuales) => [...actuales, { ...FILA_VACIA }]);
                          }
                        }}
                        className={cn(celda, 'text-right font-mono', marcar && importeDe(f) <= 0 && 'field-required')}
                      />
                    </td>
                    <td className="py-1">
                      <button
                        type="button"
                        onClick={() => setFilas((actuales) => (actuales.length > 1 ? actuales.filter((_, j) => j !== i) : [{ ...FILA_VACIA }]))}
                        title="Quitar esta fila"
                        aria-label="Quitar esta fila"
                        className="flex h-9 w-8 items-center justify-center text-text-soft hover:text-danger"
                      >
                        <X size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => setFilas((actuales) => [...actuales, { ...FILA_VACIA }])}
            className="inline-flex items-center gap-1 text-[12px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
          >
            <Plus size={14} /> Otro saldo
          </button>
          {incompletas > 0 && (
            <span className="text-xs font-semibold text-danger">
              {incompletas} fila{incompletas === 1 ? '' : 's'} sin completar: proveedor, fecha e importe (y que no venza antes de la fecha).
            </span>
          )}
          <span className="ml-auto text-sm text-text-soft">
            {aCargar.length} saldo{aCargar.length === 1 ? '' : 's'} · Total{' '}
            <strong className="text-text">$ {formatMoney(total)}</strong>
          </span>
        </div>
      </Panel>

      <Panel className="p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold uppercase tracking-wider text-text">Ya cargados como saldo inicial</h3>
          <span className="text-sm text-text-soft">
            {cargados.length} · Pendiente <strong className="text-text">$ {formatMoney(pendienteCargado)}</strong>
          </span>
        </div>
        {cargados.length === 0 ? (
          <p className="text-sm text-text-soft">Todavía no se cargó ninguno.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] font-bold uppercase tracking-wider text-text-faint">
                  <th className="py-1.5 pr-2">Proveedor</th>
                  <th className="py-1.5 pr-2">Comprobante</th>
                  <th className="py-1.5 pr-2">Fecha</th>
                  <th className="py-1.5 pr-2">Vence</th>
                  <th className="py-1.5 pr-2 text-right">Importe</th>
                  <th className="py-1.5 pr-2 text-right">Pendiente</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {cargados.map((s) => (
                  <tr key={s.id} className="border-b border-line/60">
                    <td className="py-1.5 pr-2">{s.supplierName}</td>
                    <td className="py-1.5 pr-2 font-mono">{s.comprobante}</td>
                    <td className="py-1.5 pr-2">{formatDate(s.fecha)}</td>
                    <td className="py-1.5 pr-2">{formatDate(s.vencimiento)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">$ {formatMoney(s.importe)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">
                      {s.importe - s.pagado <= 0 ? <span className="text-state-ok">Pagado</span> : `$ ${formatMoney(s.importe - s.pagado)}`}
                    </td>
                    <td className="py-1.5 text-right">
                      {s.pagado === 0 && (
                        <button
                          type="button"
                          onClick={() => borrar(s)}
                          disabled={borrando === s.id}
                          title="Borrar: se cargó por error"
                          aria-label="Borrar saldo"
                          className="inline-flex h-7 w-7 items-center justify-center text-text-soft hover:text-danger disabled:opacity-50"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
