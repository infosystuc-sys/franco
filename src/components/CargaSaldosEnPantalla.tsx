import React from 'react';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { AccionesDeCampo, Button, Panel } from '@/src/components/ui';
import { ClienteCombobox } from '@/src/components/ClienteCombobox';
import { CustomerModal } from '@/src/components/CustomerModal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { formatCuit } from '@/src/lib/fiscal';
import type { Customer } from '@/src/lib/customers';
import {
  cargarSaldosIniciales,
  fetchSaldosInicialesDe,
  TIPO_SALDO_INICIAL_LABELS,
  type RenglonSaldoInicial,
  type SaldoInicialCargado,
  type TipoSaldoInicial,
} from '@/src/lib/saldosIniciales';

const renglonVacio = (): RenglonSaldoInicial => ({
  tipo: 'DEBE',
  comprobante: '',
  fecha: '',
  vencimiento: '',
  importe: 0,
});

const campo =
  'w-full rounded-md border border-line bg-panel px-2 py-1.5 text-sm text-text focus:border-accent-deep focus:outline-none';

/** Qué le falta a un renglón para poder cargarse. */
function problemas(r: RenglonSaldoInicial): string[] {
  const p: string[] = [];
  if (!(r.importe > 0)) p.push('Falta el importe.');
  if (r.fecha && r.vencimiento && r.vencimiento < r.fecha) p.push('Vence antes de la fecha.');
  return p;
}

/**
 * Carga de saldos iniciales a mano, un cliente a la vez: se elige el cliente
 * y se cargan sus comprobantes pendientes del sistema anterior. Usa la misma
 * función que la importación por planilla, así que las dos formas dejan lo
 * mismo cargado.
 */
export function CargaSaldosEnPantalla({
  clientes,
  onClienteNuevo,
  onCargado,
}: {
  clientes: Customer[];
  onClienteNuevo: (c: Customer) => void;
  onCargado: () => void;
}) {
  const [clienteId, setClienteId] = React.useState('');
  const [renglones, setRenglones] = React.useState<RenglonSaldoInicial[]>([renglonVacio()]);
  const [cargados, setCargados] = React.useState<SaldoInicialCargado[]>([]);
  const [guardando, setGuardando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [listo, setListo] = React.useState<string | null>(null);
  const [fichaNueva, setFichaNueva] = React.useState(false);

  const cliente = clientes.find((c) => c.id === clienteId) ?? null;

  const leerCargados = React.useCallback(async (id: string) => {
    if (!id) {
      setCargados([]);
      return;
    }
    try {
      setCargados(await fetchSaldosInicialesDe(id));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  React.useEffect(() => { leerCargados(clienteId); }, [clienteId, leerCargados]);

  function patch(i: number, cambios: Partial<RenglonSaldoInicial>) {
    setRenglones((rs) => rs.map((r, k) => (k === i ? { ...r, ...cambios } : r)));
  }

  const usados = renglones.filter((r) => r.importe > 0 || r.comprobante.trim() !== '');
  const conProblemas = usados.filter((r) => problemas(r).length > 0).length;
  const deuda = usados.filter((r) => r.tipo === 'DEBE').reduce((s, r) => s + (r.importe || 0), 0);
  const aFavor = usados.filter((r) => r.tipo === 'A_FAVOR').reduce((s, r) => s + (r.importe || 0), 0);
  const yaCargado = cargados.reduce((s, c) => s + c.importe, 0);

  async function guardar() {
    if (!cliente || usados.length === 0 || conProblemas > 0) return;
    const aviso =
      cargados.length > 0
        ? `\n\nOjo: ${cliente.name} ya tiene ${cargados.length} saldos iniciales cargados. Si alguno se repite, va a quedar dos veces.`
        : '';
    if (
      !window.confirm(
        `Cargar a ${cliente.name} ${usados.length} saldos iniciales: $ ${formatMoney(deuda)} que debe` +
          `${aFavor > 0 ? ` y $ ${formatMoney(aFavor)} a favor` : ''}.${aviso}`
      )
    ) {
      return;
    }
    setGuardando(true);
    setError(null);
    setListo(null);
    try {
      await cargarSaldosIniciales(cliente.id, usados);
      setListo(`Cargado: ${usados.length} saldos iniciales de ${cliente.name}.`);
      setRenglones([renglonVacio()]);
      await leerCargados(cliente.id);
      onCargado();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-4">
      <Panel className="space-y-4 p-5">
        <label className="block max-w-2xl text-xs font-bold uppercase tracking-wider text-text-soft">
          Cliente
          <div className="mt-1 flex">
            <ClienteCombobox
              clientes={clientes}
              value={clienteId}
              onChange={(id) => { setClienteId(id); setListo(null); setError(null); }}
              className={cn('flex-1 rounded-r-none', !clienteId && 'field-required')}
            />
            <AccionesDeCampo nuevo={{ titulo: 'Dar de alta un cliente nuevo', onClick: () => setFichaNueva(true) }} />
          </div>
        </label>

        {cliente && cargados.length > 0 && (
          <div className="rounded-md border border-line bg-panel-alt px-4 py-3 text-sm">
            <p className="font-semibold text-text">
              Ya tiene {cargados.length} saldos iniciales cargados: $ {formatMoney(yaCargado)}.
            </p>
            <ul className="mt-1 space-y-0.5 text-[13px] text-text-soft">
              {cargados.map((c) => (
                <li key={c.id}>
                  {c.tipo === 'DEUDA' ? c.comprobante : `${c.comprobante} (a favor)`} · {formatDate(c.fecha)} · ${' '}
                  {formatMoney(c.importe)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {cliente && (
          <p className="text-[13px] text-text-soft">
            {cliente.legalName ?? cliente.name}
            {cliente.taxId && ` · CUIT ${formatCuit(cliente.taxId)}`}
          </p>
        )}
      </Panel>

      {cliente && (
        <Panel className="overflow-x-auto p-5">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="w-64 pb-2 pr-2">Tipo</th>
                <th className="pb-2 pr-2">Comprobante</th>
                <th className="w-40 pb-2 pr-2">Fecha</th>
                <th className="w-40 pb-2 pr-2">Vencimiento</th>
                <th className="w-40 pb-2 pr-2 text-right">Importe</th>
                <th className="w-10 pb-2" />
              </tr>
            </thead>
            <tbody>
              {renglones.map((r, i) => {
                const p = (r.importe > 0 || r.comprobante.trim() !== '') ? problemas(r) : [];
                return (
                  <tr key={i} className="align-top">
                    <td className="py-1 pr-2">
                      <select
                        value={r.tipo}
                        onChange={(e) => patch(i, { tipo: e.target.value as TipoSaldoInicial })}
                        className={campo}
                      >
                        {(Object.keys(TIPO_SALDO_INICIAL_LABELS) as TipoSaldoInicial[]).map((t) => (
                          <option key={t} value={t}>{TIPO_SALDO_INICIAL_LABELS[t]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        value={r.comprobante}
                        onChange={(e) => patch(i, { comprobante: e.target.value })}
                        placeholder={r.tipo === 'DEBE' ? 'A 0001-00001234' : 'Recibo X 0001-00000701'}
                        className={campo}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input type="date" value={r.fecha} max={todayLocal()} onChange={(e) => patch(i, { fecha: e.target.value })} className={campo} />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="date"
                        value={r.vencimiento}
                        disabled={r.tipo === 'A_FAVOR'}
                        onChange={(e) => patch(i, { vencimiento: e.target.value })}
                        className={cn(campo, 'disabled:opacity-40')}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={r.importe || ''}
                        onChange={(e) => patch(i, { importe: Number(e.target.value) })}
                        onKeyDown={(e) => {
                          // Enter en el último importe agrega otro renglón: cargar
                          // veinte comprobantes no tiene que obligar a usar el mouse.
                          if (e.key === 'Enter' && i === renglones.length - 1) {
                            e.preventDefault();
                            setRenglones((rs) => [...rs, { ...renglonVacio(), tipo: r.tipo }]);
                          }
                        }}
                        className={cn(campo, 'text-right', r.tipo === 'A_FAVOR' && 'text-state-done')}
                      />
                      {p.length > 0 && <span className="mt-0.5 block text-[12px] text-danger">{p.join(' ')}</span>}
                    </td>
                    <td className="py-1">
                      <button
                        type="button"
                        onClick={() => setRenglones((rs) => (rs.length === 1 ? [renglonVacio()] : rs.filter((_, k) => k !== i)))}
                        aria-label="Quitar el renglón"
                        className="rounded p-1.5 text-text-soft hover:bg-panel-alt hover:text-danger"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost" type="button" onClick={() => setRenglones((rs) => [...rs, renglonVacio()])}>
              <Plus size={16} /> Agregar comprobante
            </Button>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="text-text-soft">
                Debe <strong className="text-text">$ {formatMoney(deuda)}</strong>
              </span>
              <span className="text-text-soft">
                A favor <strong className="text-state-done">$ {formatMoney(aFavor)}</strong>
              </span>
              <span className="text-text-soft">
                Saldo <strong className="text-text">$ {formatMoney(deuda - aFavor)}</strong>
              </span>
              <Button type="button" onClick={guardar} disabled={guardando || usados.length === 0 || conProblemas > 0}>
                {guardando ? 'Guardando…' : 'Guardar saldos'}
              </Button>
            </div>
          </div>
          <p className="mt-3 text-[12px] text-text-soft">
            El comprobante se escribe como en las facturas de la app: letra, punto de venta y número
            ("A 0001-00001234"); se completa con ceros solo. Sin fecha, se toma la de hoy; sin vencimiento,
            vence el mismo día. Enter en el último importe agrega otro renglón.
          </p>
        </Panel>
      )}

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}
      {listo && (
        <div className="flex items-start gap-2 rounded-md border border-state-done/40 bg-panel px-4 py-3 text-sm text-text">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-state-done" />
          <span>
            {listo}{' '}
            <Link to="/cuenta-corriente-clientes" className="font-semibold text-accent-deep hover:underline">
              Ver la cuenta corriente
            </Link>
          </span>
        </div>
      )}

      {fichaNueva && (
        <CustomerModal
          customer={null}
          onClose={() => setFichaNueva(false)}
          onSaved={(c) => {
            setFichaNueva(false);
            onClienteNuevo(c);
            setClienteId(c.id);
          }}
        />
      )}
    </div>
  );
}
