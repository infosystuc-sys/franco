import React from 'react';
import { Save, AlertTriangle, History, Link2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { formatDate } from '@/src/lib/invoices';
import { fetchCustomers, type Customer } from '@/src/lib/customers';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import {
  fetchCuenta,
  fetchHistorialImputacion,
  guardarImputacion,
  type CambioDeImputacion,
  type Circuito,
  type Credito,
  type CuentaDeLaParte,
} from '@/src/lib/imputaciones';
import { labelClass, inputClass } from '@/src/components/FiscalFields';

/**
 * Imputación de comprobantes.
 *
 * Se elige una parte —un cliente o un proveedor— y se ve su cuenta entera: lo
 * que tiene a favor y lo que debe. Ver la foto completa es el punto: imputando
 * de a un comprobante por vez es fácil dejar una factura cancelada dos veces y
 * otra sin cancelar, y los totales siguen cerrando igual.
 *
 * Nada se guarda hasta apretar Guardar, y lo que se manda es el cuadro
 * completo, no las diferencias.
 */
export function Imputaciones() {
  const { role } = useAuth();

  const [circuito, setCircuito] = React.useState<Circuito>('VENTAS');
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [parteId, setParteId] = React.useState('');
  const [cuenta, setCuenta] = React.useState<CuentaDeLaParte | null>(null);
  const [creditos, setCreditos] = React.useState<Credito[]>([]);
  const [elegido, setElegido] = React.useState<string | null>(null);
  const [motivo, setMotivo] = React.useState('');
  const [historial, setHistorial] = React.useState<CambioDeImputacion[]>([]);
  const [verHistorial, setVerHistorial] = React.useState(false);
  const [cargando, setCargando] = React.useState(false);
  const [guardando, setGuardando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    fetchCustomers(true).then(setCustomers).catch(() => setCustomers([]));
    fetchSuppliers(true).then(setSuppliers).catch(() => setSuppliers([]));
  }, [role]);

  const cargarCuenta = React.useCallback(async (c: Circuito, id: string) => {
    if (!id) {
      setCuenta(null);
      setCreditos([]);
      return;
    }
    setCargando(true);
    setError(null);
    setAviso(null);
    try {
      const data = await fetchCuenta(c, id);
      setCuenta(data);
      setCreditos(data.creditos.map((x) => ({ ...x, allocations: [...x.allocations] })));
      setElegido(data.creditos[0]?.id ?? null);
      setHistorial(await fetchHistorialImputacion(id).catch(() => []));
    } catch (err) {
      setError(getErrorMessage(err));
      setCuenta(null);
    } finally {
      setCargando(false);
    }
  }, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  function cambiarCircuito(c: Circuito) {
    setCircuito(c);
    setParteId('');
    setCuenta(null);
    setCreditos([]);
    setElegido(null);
  }

  function elegirParte(id: string) {
    setParteId(id);
    cargarCuenta(circuito, id);
  }

  /** Cuánto de un crédito está repartido. En compras los signos se suman. */
  function repartido(c: Credito): number {
    return round2(c.allocations.reduce((s, a) => s + Math.abs(a.amount), 0));
  }

  /** Cuánto de una deuda quedó imputado con el cuadro que se está armando. */
  function imputadoAhora(deudaId: string): number {
    return round2(
      creditos.reduce(
        (s, c) => s + (c.allocations.find((a) => a.deudaId === deudaId)?.amount ?? 0),
        0
      )
    );
  }

  function setMonto(creditoId: string, deudaId: string, valor: number) {
    setCreditos((prev) =>
      prev.map((c) => {
        if (c.id !== creditoId) return c;
        const otras = c.allocations.filter((a) => a.deudaId !== deudaId);
        return valor === 0
          ? { ...c, allocations: otras }
          : { ...c, allocations: [...otras, { deudaId, amount: valor }] };
      })
    );
  }

  async function guardar() {
    if (!parteId) return;
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      await guardarImputacion(circuito, parteId, creditos, motivo);
      setMotivo('');
      await cargarCuenta(circuito, parteId);
      setAviso('Imputación guardada.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGuardando(false);
    }
  }

  const partes = circuito === 'VENTAS' ? customers : suppliers;
  const creditoElegido = creditos.find((c) => c.id === elegido) ?? null;
  const esVentas = circuito === 'VENTAS';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Imputación de comprobantes"
        subtitle="Corregir contra qué comprobante se aplicó cada cobro, pago o nota de crédito."
        actions={
          <>
            {historial.length > 0 && (
              <Button variant="ghost" type="button" onClick={() => setVerHistorial((v) => !v)}>
                <History size={16} /> {verHistorial ? 'Ocultar historial' : 'Historial'}
              </Button>
            )}
            <Button type="button" onClick={guardar} disabled={!cuenta || guardando}>
              <Save size={16} /> {guardando ? 'Guardando…' : 'Guardar imputación'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {aviso && !error && (
        <div className="rounded-md border border-line-strong bg-panel-alt px-4 py-3 text-sm text-text">
          {aviso}
        </div>
      )}

      <Panel className="space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="inline-flex overflow-hidden rounded-md border border-line">
            {(['VENTAS', 'COMPRAS'] as Circuito[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => cambiarCircuito(c)}
                className={cn(
                  'px-4 py-1.5 text-[13px] font-bold uppercase tracking-wider transition-colors',
                  circuito === c
                    ? 'bg-accent text-accent-ink'
                    : 'bg-panel text-text-soft hover:bg-panel-alt'
                )}
              >
                {c === 'VENTAS' ? 'Ventas' : 'Compras'}
              </button>
            ))}
          </div>

          <label className={cn(labelClass, 'min-w-64 flex-1')}>
            {esVentas ? 'Cliente' : 'Proveedor'}
            <select
              value={parteId}
              onChange={(e) => elegirParte(e.target.value)}
              className={inputClass}
            >
              <option value="">Elegí {esVentas ? 'un cliente' : 'un proveedor'}…</option>
              {partes.map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      {cargando && <p className="text-center text-sm text-text-soft">Cargando la cuenta…</p>}

      {cuenta && !cargando && (
        <>
          {cuenta.creditos.length === 0 && (
            <p className="flex items-start gap-2 rounded-md border border-line bg-panel-head px-4 py-3 text-sm">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-text-soft" />
              {esVentas
                ? 'Este cliente no tiene recibos ni notas de crédito para imputar.'
                : 'Este proveedor no tiene órdenes de pago para imputar.'}
            </p>
          )}

          {cuenta.creditos.length > 0 && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[22rem_1fr]">
              {/* Lo que tiene a favor */}
              <Panel className="p-5">
                <SectionHeader title={esVentas ? 'A favor del cliente' : 'Órdenes de pago'} />
                <div className="mt-3 space-y-2">
                  {creditos.map((c) => {
                    const usado = repartido(c);
                    const libre = round2(c.totalAmount - usado);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setElegido(c.id)}
                        className={cn(
                          'block w-full border px-3 py-2 text-left text-sm transition-colors',
                          elegido === c.id
                            ? 'border-accent bg-panel-alt'
                            : 'border-line hover:bg-panel-alt'
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-mono font-semibold">{c.fullNumber}</span>
                          <span className="text-[12px] uppercase tracking-[0.06em] text-text-faint">
                            {c.clase === 'NOTA_CREDITO' ? 'NC' : c.clase === 'RECIBO' ? 'Recibo' : 'OP'}
                          </span>
                        </span>
                        <span className="mt-1 flex items-center justify-between gap-2 text-text-soft">
                          <span>{formatDate(c.fecha)}</span>
                          <span>$ {formatMoney(c.totalAmount)}</span>
                        </span>
                        <span
                          className={cn(
                            'mt-1 block text-[12px]',
                            libre > 0 ? 'font-semibold text-accent-deep' : 'text-text-faint'
                          )}
                        >
                          {libre > 0 ? `Sin imputar $ ${formatMoney(libre)}` : 'Todo imputado'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Panel>

              {/* Contra qué se aplica */}
              <Panel className="p-5">
                <SectionHeader
                  title={
                    creditoElegido
                      ? `Imputar ${creditoElegido.fullNumber}`
                      : 'Elegí un comprobante de la izquierda'
                  }
                />

                {creditoElegido && (
                  <>
                    <p className="mt-1 text-xs text-text-soft">
                      Sin imputar de este comprobante:{' '}
                      <strong>
                        $ {formatMoney(round2(creditoElegido.totalAmount - repartido(creditoElegido)))}
                      </strong>
                      {!esVentas && ' · En compras la nota de crédito se imputa con importe negativo.'}
                    </p>

                    <table className="mt-3 w-full text-sm">
                      <thead>
                        <tr className="border-b border-line text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                          <th className="py-2">Comprobante</th>
                          <th className="py-2">Emisión</th>
                          <th className="py-2 text-right">Total</th>
                          <th className="py-2 text-right">Pendiente</th>
                          <th className="py-2 text-right">Imputar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cuenta.deudas.map((d) => {
                          const aqui =
                            creditoElegido.allocations.find((a) => a.deudaId === d.id)?.amount ?? 0;
                          // Lo pendiente descuenta lo que el resto del cuadro ya
                          // le está imputando, así se ve el efecto de lo que se
                          // está armando y no el de lo que había guardado.
                          const pendiente = round2(
                            d.totalAmount - (imputadoAhora(d.id) - aqui)
                          );
                          return (
                            <tr key={d.id} className="border-b border-line/60">
                              <td className="py-1.5 font-mono">{d.fullNumber}</td>
                              <td className="py-1.5 text-text-soft">{formatDate(d.issueDate)}</td>
                              <td className="py-1.5 text-right">$ {formatMoney(d.totalAmount)}</td>
                              <td
                                className={cn(
                                  'py-1.5 text-right',
                                  pendiente <= 0 ? 'text-text-faint' : 'font-semibold'
                                )}
                              >
                                $ {formatMoney(pendiente)}
                              </td>
                              <td className="py-1.5 text-right">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={aqui === 0 ? '' : aqui}
                                  onChange={(e) =>
                                    setMonto(creditoElegido.id, d.id, round2(Number(e.target.value) || 0))
                                  }
                                  placeholder="0,00"
                                  className={cn(inputClass, 'w-32 text-right font-mono')}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {cuenta.deudas.length === 0 && (
                      <p className="mt-3 text-sm text-text-soft">
                        No hay comprobantes con saldo para imputar.
                      </p>
                    )}
                  </>
                )}
              </Panel>
            </div>
          )}

          <Panel className="p-5">
            <label className={cn(labelClass, 'block')}>
              Motivo del cambio
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="El recibo estaba aplicado a la factura equivocada…"
                className={inputClass}
              />
            </label>
            <p className="mt-2 text-xs text-text-soft">
              Queda en el historial junto con quién y cuándo. Es plata que se mueve
              entre comprobantes sin que cambie ningún importe: sin el motivo, una
              diferencia es imposible de reconstruir.
            </p>
          </Panel>

          {verHistorial && historial.length > 0 && (
            <Panel className="p-5">
              <SectionHeader title="Historial de imputaciones" />
              <ul className="mt-3 space-y-2 text-sm">
                {historial.map((h) => (
                  <li key={h.id} className="flex items-start gap-2 border-b border-line/60 pb-2">
                    <Link2 size={14} className="mt-1 shrink-0 text-text-faint" />
                    <span>
                      <span className="text-text-soft">
                        {formatDate(h.createdAt.slice(0, 10))}
                      </span>
                      {h.motivo ? ` · ${h.motivo}` : ' · sin motivo anotado'}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
