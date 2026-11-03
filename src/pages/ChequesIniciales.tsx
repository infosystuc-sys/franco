import React from 'react';
import { CheckCircle2, Plus, Save, Trash2, X } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchBanks, type Bank } from '@/src/lib/banks';
import { BankCombobox } from '@/src/components/BankCombobox';
import {
  borrarChequeInicial,
  cargarChequesIniciales,
  CHECK_STATUS_BADGE,
  CHECK_STATUS_LABELS,
  describeCheckError,
  fetchChequesIniciales,
  type ThirdPartyCheck,
} from '@/src/lib/checks';

interface Fila {
  electronico: boolean;
  number: string;
  bankName: string;
  drawer: string;
  issueDate: string;
  dueDate: string;
  amount: string;
}

const FILA_VACIA: Fila = { electronico: false, number: '', bankName: '', drawer: '', issueDate: '', dueDate: '', amount: '' };

const celda = 'h-9 w-full rounded-[3px] border border-line bg-panel px-2 text-[13px] text-text focus:border-accent focus:outline-none';

function importeDe(fila: Fila): number {
  const n = Number(fila.amount);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Una fila vacía no cuenta: se ignora al guardar. */
function estaVacia(fila: Fila): boolean {
  return !fila.number.trim() && !fila.bankName.trim() && !fila.drawer.trim() && !fila.dueDate && !fila.amount.trim();
}

function estaCompleta(fila: Fila): boolean {
  return !!fila.number.trim() && !!fila.bankName.trim() && !!fila.dueDate && importeDe(fila) > 0;
}

/**
 * Carga inicial de cheques de terceros: los valores que había en la cartera
 * al empezar a usar la app. Se cargan todos juntos en una grilla y entran a
 * la cartera con la fecha de inicio, como saldo inicial. Desde ahí se
 * manejan en Cheques como cualquier otro.
 */
export function ChequesIniciales() {
  const { role } = useAuth();
  const [fecha, setFecha] = React.useState(todayLocal());
  const [filas, setFilas] = React.useState<Fila[]>([{ ...FILA_VACIA }]);
  const [bancos, setBancos] = React.useState<Bank[]>([]);
  const [cargados, setCargados] = React.useState<ThirdPartyCheck[]>([]);
  const [guardando, setGuardando] = React.useState(false);
  const [borrando, setBorrando] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);

  const recargar = React.useCallback(async () => {
    try {
      setCargados(await fetchChequesIniciales());
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
    }
  }, []);

  React.useEffect(() => {
    if (role !== 'admin') return;
    fetchBanks(true).then(setBancos).catch(() => {/* sin la lista, el banco se escribe a mano */});
    recargar();
  }, [role, recargar]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  function cambiar(i: number, cambio: Partial<Fila>) {
    setFilas((actuales) => actuales.map((f, j) => (j === i ? { ...f, ...cambio } : f)));
  }

  const aCargar = filas.filter((f) => !estaVacia(f));
  const incompletas = aCargar.filter((f) => !estaCompleta(f)).length;
  const total = aCargar.reduce((s, f) => s + importeDe(f), 0);
  const totalCargado = cargados.reduce((s, c) => s + c.amount, 0);
  const puedeGuardar = !!fecha && aCargar.length > 0 && incompletas === 0 && !guardando;

  async function guardar() {
    if (!puedeGuardar) return;
    if (
      !window.confirm(
        `Cargar ${aCargar.length} cheque${aCargar.length === 1 ? '' : 's'} por $ ${formatMoney(total)} ` +
          `a la cartera, con fecha ${formatDate(fecha)}?`
      )
    ) return;
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const n = await cargarChequesIniciales(
        fecha,
        aCargar.map((f) => ({
          electronico: f.electronico,
          number: f.number,
          bankName: f.bankName,
          drawer: f.drawer,
          issueDate: f.issueDate,
          dueDate: f.dueDate,
          amount: importeDe(f),
          notes: '',
        }))
      );
      setAviso(`Se cargaron ${n} cheque${n === 1 ? '' : 's'} a la cartera.`);
      setFilas([{ ...FILA_VACIA }]);
      await recargar();
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
    } finally {
      setGuardando(false);
    }
  }

  async function borrar(cheque: ThirdPartyCheck) {
    if (!window.confirm(`¿Borrar el cheque ${cheque.number} del ${cheque.bankName} por $ ${formatMoney(cheque.amount)}?`)) return;
    setBorrando(cheque.id);
    setError(null);
    setAviso(null);
    try {
      await borrarChequeInicial(cheque.id);
      await recargar();
    } catch (err) {
      setError(describeCheckError(getErrorMessage(err)));
    } finally {
      setBorrando(null);
    }
  }

  return (
    <div className="w-full">
      <PageHeader
        title="Carga inicial de cheques"
        subtitle="Los cheques de terceros que había en la cartera al empezar a usar la app."
        actions={
          <>
            <Link to="/cheques">
              <Button variant="ghost" type="button"><X size={16} /> Volver a Cheques</Button>
            </Link>
            <Button onClick={guardar} disabled={!puedeGuardar}>
              <Save size={16} /> {guardando ? 'Cargando…' : 'Cargar a la cartera'}
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
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={cn(inputClass, !fecha && 'field-required')} />
          </label>
          <p className="max-w-xl flex-1 text-xs text-text-soft">
            Es la fecha con la que entran a la cartera: la del día en que se empezó a usar la app. No es un cobro ni
            una venta: en el libro de caja figuran como “Saldo inicial”, sin concepto. Después se depositan, endosan o
            rechazan desde Cheques como cualquier otro.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-text-faint">
                <th className="w-28 pb-1.5 pr-2">Tipo</th>
                <th className="w-32 pb-1.5 pr-2">Número *</th>
                <th className="pb-1.5 pr-2">Banco *</th>
                <th className="pb-1.5 pr-2">Librador</th>
                <th className="w-36 pb-1.5 pr-2">Emisión</th>
                <th className="w-36 pb-1.5 pr-2">Fecha de cobro *</th>
                <th className="w-36 pb-1.5 pr-2 text-right">Importe *</th>
                <th className="w-8 pb-1.5" />
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => {
                const marcar = !estaVacia(f);
                return (
                  <tr key={i} className="align-top">
                    <td className="py-1 pr-2">
                      <select
                        value={f.electronico ? 'E' : 'F'}
                        onChange={(e) => cambiar(i, { electronico: e.target.value === 'E' })}
                        className={celda}
                      >
                        <option value="F">Cheque</option>
                        <option value="E">eCheq</option>
                      </select>
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        value={f.number}
                        onChange={(e) => cambiar(i, { number: e.target.value })}
                        className={cn(celda, 'font-mono', marcar && !f.number.trim() && 'field-required')}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <BankCombobox
                        value={f.bankName}
                        onChange={(name) => cambiar(i, { bankName: name })}
                        banks={bancos}
                        onBankCreated={(bank) => setBancos((actuales) => [...actuales, bank])}
                        className={cn(celda, marcar && !f.bankName.trim() && 'field-required')}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input value={f.drawer} onChange={(e) => cambiar(i, { drawer: e.target.value })} className={celda} />
                    </td>
                    <td className="py-1 pr-2">
                      <input type="date" value={f.issueDate} onChange={(e) => cambiar(i, { issueDate: e.target.value })} className={celda} />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="date"
                        value={f.dueDate}
                        onChange={(e) => cambiar(i, { dueDate: e.target.value })}
                        className={cn(celda, marcar && !f.dueDate && 'field-required')}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={f.amount}
                        onChange={(e) => cambiar(i, { amount: e.target.value })}
                        onKeyDown={(e) => {
                          // Enter en el importe de la última fila agrega otra: se carga de corrido.
                          if (e.key === 'Enter' && i === filas.length - 1) {
                            e.preventDefault();
                            setFilas((actuales) => [...actuales, { ...FILA_VACIA, bankName: f.bankName }]);
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
            <Plus size={14} /> Otro cheque
          </button>
          {incompletas > 0 && (
            <span className="text-xs font-semibold text-danger">
              {incompletas} fila{incompletas === 1 ? '' : 's'} sin completar: número, banco, fecha de cobro e importe.
            </span>
          )}
          <span className="ml-auto text-sm text-text-soft">
            {aCargar.length} cheque{aCargar.length === 1 ? '' : 's'} · Total{' '}
            <strong className="text-text">$ {formatMoney(total)}</strong>
          </span>
        </div>
      </Panel>

      <Panel className="p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold uppercase tracking-wider text-text">Ya cargados como saldo inicial</h3>
          <span className="text-sm text-text-soft">
            {cargados.length} · Total <strong className="text-text">$ {formatMoney(totalCargado)}</strong>
          </span>
        </div>
        {cargados.length === 0 ? (
          <p className="text-sm text-text-soft">Todavía no se cargó ninguno.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] font-bold uppercase tracking-wider text-text-faint">
                  <th className="py-1.5 pr-2">Cheque</th>
                  <th className="py-1.5 pr-2">Banco</th>
                  <th className="py-1.5 pr-2">Librador</th>
                  <th className="py-1.5 pr-2">Cobro</th>
                  <th className="py-1.5 pr-2">Estado</th>
                  <th className="py-1.5 pr-2 text-right">Importe</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {cargados.map((c) => (
                  <tr key={c.id} className="border-b border-line/60">
                    <td className="py-1.5 pr-2 font-mono">{c.electronico ? 'eCheq' : 'Cheque'} {c.number}</td>
                    <td className="py-1.5 pr-2">{c.bankName}</td>
                    <td className="py-1.5 pr-2">{c.drawer ?? '—'}</td>
                    <td className="py-1.5 pr-2">{formatDate(c.dueDate)}</td>
                    <td className="py-1.5 pr-2">
                      <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', CHECK_STATUS_BADGE[c.status])}>
                        {CHECK_STATUS_LABELS[c.status]}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono">$ {formatMoney(c.amount)}</td>
                    <td className="py-1.5 text-right">
                      {c.status === 'EN_CARTERA' && (
                        <button
                          type="button"
                          onClick={() => borrar(c)}
                          disabled={borrando === c.id}
                          title="Borrar: se cargó por error"
                          aria-label="Borrar cheque"
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
