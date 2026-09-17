import React from 'react';
import { Navigate } from 'react-router-dom';
import { Wrench, ArrowLeft, Banknote } from 'lucide-react';
import { cn, formatDate, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { todayLocal } from '@/src/lib/invoices';
import {
  fetchMechanicBalances,
  fetchMechanicEntries,
  MECHANIC_ENTRY_LABELS,
  pagarAMecanico,
  type MechanicBalance,
  type MechanicEntry,
} from '@/src/lib/mechanics';

/**
 * La cuenta corriente de cada mecánico: lo que se le devengó por
 * sobrefacturación y lo que se le pagó.
 *
 * Solo admin. Acá se ve cuánto se le infló a cada cliente y cuánto se le debe
 * a cada persona: no es información para la pantalla de un operario.
 */
export function MechanicAccounts() {
  const { role } = useAuth();
  const [saldos, setSaldos] = React.useState<MechanicBalance[]>([]);
  const [elegido, setElegido] = React.useState<MechanicBalance | null>(null);
  const [cargando, setCargando] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    setCargando(true);
    try {
      setSaldos(await fetchMechanicBalances());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCargando(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (elegido) {
    return (
      <CuentaDeUno
        mecanico={elegido}
        onVolver={() => { setElegido(null); cargar(); }}
      />
    );
  }

  const totalAdeudado = saldos.reduce((s, m) => s + Math.max(0, m.saldo), 0);

  return (
    <div className="w-full">
      <PageHeader
        title="Cuentas de mecánicos"
        subtitle="Sobrefacturación devengada y pagos. Lo que figura acá es lo que se le debe a cada uno."
      />

      {error && (
        <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {cargando ? (
        <p className="p-8 text-center text-text-soft">Cargando…</p>
      ) : saldos.length === 0 ? (
        <Panel className="p-8 text-center text-text-soft">
          Todavía no hay movimientos. Se generan al facturar una orden que tenga
          mecánico y sobrefacturación definida.
        </Panel>
      ) : (
        <>
          <Panel className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line bg-panel-head text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                  <tr>
                    <th className="p-3">Mecánico</th>
                    <th className="p-3 text-right">Devengado</th>
                    <th className="p-3 text-right">Pagado</th>
                    <th className="p-3 text-right">Saldo</th>
                    <th className="w-28 p-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {saldos.map((m) => (
                    <tr key={m.mechanicId} className="border-b border-line last:border-b-0">
                      <td className="p-3 font-semibold text-text">
                        <span className="flex items-center gap-2">
                          <Wrench size={14} className="text-text-soft" /> {m.mechanicName}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono">$ {formatMoney(m.devengado)}</td>
                      <td className="p-3 text-right font-mono text-text-soft">$ {formatMoney(m.pagado)}</td>
                      <td className={cn(
                        'p-3 text-right font-mono font-bold',
                        m.saldo > 0 ? 'text-accent-deep' : m.saldo < 0 ? 'text-danger' : 'text-text-soft'
                      )}>
                        $ {formatMoney(m.saldo)}
                      </td>
                      <td className="p-3 text-right">
                        <button
                          type="button"
                          onClick={() => setElegido(m)}
                          className="text-[12px] font-semibold uppercase tracking-wider text-text-soft hover:text-accent-deep"
                        >
                          Ver cuenta
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <p className="mt-4 text-sm text-text-soft">
            Total a pagar a mecánicos:{' '}
            <span className="font-mono font-bold text-text">$ {formatMoney(totalAdeudado)}</span>
          </p>
        </>
      )}
    </div>
  );
}

/** El detalle de un mecánico, con el alta de pagos. */
function CuentaDeUno({ mecanico, onVolver }: { mecanico: MechanicBalance; onVolver: () => void }) {
  const [movimientos, setMovimientos] = React.useState<MechanicEntry[]>([]);
  const [cargando, setCargando] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [monto, setMonto] = React.useState('');
  const [fecha, setFecha] = React.useState(todayLocal());
  const [notas, setNotas] = React.useState('');
  const [pagando, setPagando] = React.useState(false);

  const cargar = React.useCallback(async () => {
    setCargando(true);
    try {
      setMovimientos(await fetchMechanicEntries(mecanico.mechanicId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCargando(false);
    }
  }, [mecanico.mechanicId]);

  React.useEffect(() => { cargar(); }, [cargar]);

  // El saldo se recalcula de los movimientos que se están viendo, así queda al
  // día apenas se registra un pago sin volver al listado.
  const saldo = movimientos.reduce((s, m) => s + m.amount, 0);
  const numero = Number(monto.replace(',', '.'));
  const puedePagar = monto.trim() !== '' && Number.isFinite(numero) && numero > 0 && !pagando;

  async function handlePagar() {
    if (!puedePagar) return;
    setPagando(true);
    setError(null);
    try {
      await pagarAMecanico(mecanico.mechanicId, numero, fecha, notas);
      setMonto('');
      setNotas('');
      await cargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPagando(false);
    }
  }

  const inputClass = 'mt-1 w-full border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none';
  const labelClass = 'block text-xs font-bold uppercase tracking-wider text-text-soft';

  return (
    <div className="w-full">
      <PageHeader
        title={mecanico.mechanicName}
        subtitle={
          <button
            type="button"
            onClick={onVolver}
            className="inline-flex items-center gap-1.5 text-text-soft hover:text-accent-deep"
          >
            <ArrowLeft size={14} /> Volver a cuentas de mecánicos
          </button>
        }
        actions={
          <div className="text-right">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-text-faint">Saldo</span>
            <span className={cn(
              'font-display text-2xl font-medium',
              saldo > 0 ? 'text-accent-deep' : saldo < 0 ? 'text-danger' : 'text-text-soft'
            )}>
              $ {formatMoney(saldo)}
            </span>
          </div>
        }
      />

      {error && (
        <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="mb-6 p-5">
        <SectionHeader title="Registrar un pago" className="mb-3" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end">
          <label className={labelClass}>
            Monto
            <input
              inputMode="decimal"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              className={cn(inputClass, 'text-right font-mono')}
              placeholder="0,00"
            />
          </label>
          <label className={labelClass}>
            Fecha
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={inputClass} />
          </label>
          <label className={cn(labelClass, 'sm:col-span-1')}>
            Observaciones
            <input
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              className={cn(inputClass, 'font-normal normal-case')}
              placeholder="Adelanto, quincena…"
            />
          </label>
          <Button type="button" disabled={!puedePagar} onClick={handlePagar} className="justify-center">
            <Banknote size={16} /> {pagando ? 'Registrando…' : 'Registrar pago'}
          </Button>
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-panel-head text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="p-3">Fecha</th>
                <th className="p-3">Concepto</th>
                <th className="p-3">Origen</th>
                <th className="p-3 text-right">Importe</th>
              </tr>
            </thead>
            <tbody>
              {cargando && (
                <tr><td colSpan={4} className="p-6 text-center text-text-soft">Cargando…</td></tr>
              )}
              {!cargando && movimientos.length === 0 && (
                <tr><td colSpan={4} className="p-6 text-center text-text-soft">Sin movimientos.</td></tr>
              )}
              {movimientos.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-b-0">
                  <td className="p-3 font-mono text-text-soft">{formatDate(m.entryDate)}</td>
                  <td className="p-3">
                    <span className="font-semibold text-text">{MECHANIC_ENTRY_LABELS[m.kind]}</span>
                    {m.notes && <span className="mt-0.5 block text-xs text-text-soft">{m.notes}</span>}
                  </td>
                  <td className="p-3 font-mono text-xs text-text-soft">
                    {[m.workOrderNumber, m.invoiceFullNumber].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className={cn(
                    'p-3 text-right font-mono font-semibold',
                    m.amount >= 0 ? 'text-accent-deep' : 'text-text-soft'
                  )}>
                    $ {formatMoney(m.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
