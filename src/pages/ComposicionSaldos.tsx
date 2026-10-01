import React from 'react';
import * as XLSX from 'xlsx';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { cn, formatDate, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { SendDocumentModal } from '@/src/components/SendDocumentModal';
import {
  armarComposicion,
  fetchMails,
  fetchMovimientos,
  filasParaExportar,
  type Bloque,
  type Lado,
  type Movimiento,
} from '@/src/lib/composicionSaldos';

const botonBase =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-[3px] px-4 text-[15px] text-white ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const botonGris = 'bg-[#b3b3b3] hover:bg-[#9e9e9e]';
const botonAmarillo = 'bg-accent hover:bg-accent-hover';

const TEXTOS: Record<Lado, { titulo: string; parte: string; partes: string; accion: string; ruta: (id: string) => string }> = {
  clientes: {
    titulo: 'Composición de saldos de clientes',
    parte: 'Cliente',
    partes: 'clientes',
    accion: 'Cobrar',
    ruta: (id) => `/cobranzas/nueva?cliente=${id}`,
  },
  proveedores: {
    titulo: 'Composición de saldos de proveedores',
    parte: 'Proveedor',
    partes: 'proveedores',
    accion: 'Pagar',
    ruta: (id) => `/pagos/nueva?proveedor=${id}`,
  },
};

/**
 * La cuenta corriente con la forma de la composición de saldos de Tango: un
 * bloque por cliente o proveedor, con el saldo anterior y el total arriba, y
 * cada comprobante con lo aplicado debajo. Los filtros van arriba.
 */
export function ComposicionSaldos({ lado }: { lado: Lado }) {
  const { role } = useAuth();
  const navigate = useNavigate();
  const t = TEXTOS[lado];

  const [hasta, setHasta] = React.useState(todayLocal());
  const [desde, setDesde] = React.useState('');
  const [parte, setParte] = React.useState('');
  const [modo, setModo] = React.useState<'pendientes' | 'todos'>('pendientes');

  const [movimientos, setMovimientos] = React.useState<Movimiento[]>([]);
  const [mails, setMails] = React.useState<Map<string, string>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);
  const [enviando, setEnviando] = React.useState(false);
  const [descargando, setDescargando] = React.useState(false);
  const documentRef = React.useRef<HTMLDivElement>(null);

  // "Hasta" cambia lo que trae la base (las aplicaciones posteriores no
  // cuentan); el resto de los filtros se aplica sobre lo ya traído.
  React.useEffect(() => {
    if (!hasta) return;
    let vigente = true;
    setLoading(true);
    setError(null);
    fetchMovimientos(lado, hasta)
      .then((m) => vigente && setMovimientos(m))
      .catch((err) => vigente && setError(getErrorMessage(err)))
      .finally(() => vigente && setLoading(false));
    return () => { vigente = false; };
  }, [lado, hasta]);

  React.useEffect(() => {
    fetchMails(lado).then(setMails).catch(() => {/* sin mails, el envío pide la dirección a mano */});
  }, [lado]);

  const bloques = React.useMemo(
    () => armarComposicion(lado, movimientos, { desde, parte, modo }),
    [lado, movimientos, desde, parte, modo]
  );
  const total = bloques.reduce((s, b) => s + b.totalSaldo, 0);
  const nombres = React.useMemo(
    () => [...new Set(movimientos.map((m) => m.nombre))].sort((a, b) => a.localeCompare(b)),
    [movimientos]
  );

  if (role !== 'admin') return <Navigate to="/" replace />;

  const periodo = `${desde ? `del ${formatDate(desde)} ` : ''}al ${formatDate(hasta)}`;

  async function copiar() {
    const texto = filasParaExportar(bloques, desde)
      .map((f) => f.map((c) => (c === null || c === undefined ? '' : typeof c === 'number' ? c.toFixed(2).replace('.', ',') : c)).join('\t'))
      .join('\n');
    try {
      await navigator.clipboard.writeText(texto);
      setAviso('Copiado al portapapeles: se puede pegar en Excel.');
    } catch {
      setError('El navegador no dejó copiar al portapapeles.');
    }
  }

  function excel() {
    const hoja = XLSX.utils.aoa_to_sheet([[t.titulo], [periodo], [], ...filasParaExportar(bloques, desde)]);
    hoja['!cols'] = [36, 12, 12, 34, 14, 16, 16, 16].map((wch) => ({ wch }));
    for (const ref of Object.keys(hoja)) {
      const celda = hoja[ref];
      if (ref.startsWith('!') || celda.t !== 'n') continue;
      celda.z = '#,##0.00';
    }
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Composición');
    XLSX.writeFile(libro, `composicion-saldos-${lado}-${hasta}.xlsx`);
  }

  async function pdf() {
    if (!documentRef.current) return;
    setDescargando(true);
    try {
      const { downloadElementAsPdf } = await import('@/src/lib/pdf');
      await downloadElementAsPdf(documentRef.current, `composicion-saldos-${lado}-${hasta}.pdf`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDescargando(false);
    }
  }

  const unaSolaParte = bloques.length === 1 ? bloques[0] : null;

  return (
    <div className="w-full">
      <div className="no-print">
        {/* ── Encabezado y botonera, como en Tango ───────────────────── */}
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b-2 border-accent pb-3">
          <h1 className="text-[22px] font-light uppercase tracking-wide text-text-faint">{t.titulo}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => navigate(-1)} className={cn(botonBase, botonAmarillo)}>
              Volver
            </button>
            <button type="button" onClick={copiar} disabled={bloques.length === 0} className={cn(botonBase, botonGris)}>
              Copiar al portapapeles
            </button>
            <button type="button" onClick={excel} disabled={bloques.length === 0} className={cn(botonBase, botonGris)}>
              Ms Excel
            </button>
            <button type="button" onClick={pdf} disabled={bloques.length === 0 || descargando} className={cn(botonBase, botonGris)}>
              {descargando ? 'Armando PDF…' : 'PDF'}
            </button>
            <button type="button" onClick={() => window.print()} disabled={bloques.length === 0} className={cn(botonBase, botonGris)}>
              Imprimir
            </button>
            <button
              type="button"
              onClick={() => setEnviando(true)}
              disabled={bloques.length === 0}
              title={unaSolaParte ? undefined : `Conviene filtrar un ${t.parte.toLowerCase()} antes de mandarla.`}
              className={cn(botonBase, botonGris)}
            >
              Enviar por correo electrónico
            </button>
          </div>
        </div>

        {/* ── Filtros ─────────────────────────────────────────────────── */}
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-line bg-panel px-4 py-3 text-sm">
          <label className="flex flex-col gap-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            Desde
            <input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="h-9 rounded-md border border-line bg-panel px-2 text-sm font-normal normal-case text-text focus:border-accent-deep focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            Hasta
            <input
              type="date"
              value={hasta}
              onChange={(e) => e.target.value && setHasta(e.target.value)}
              className="h-9 rounded-md border border-line bg-panel px-2 text-sm font-normal normal-case text-text focus:border-accent-deep focus:outline-none"
            />
          </label>
          <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            {t.parte}
            <input
              value={parte}
              onChange={(e) => setParte(e.target.value)}
              list={`lista-${lado}`}
              placeholder={`Todos los ${t.partes} — nombre o CUIT`}
              className="h-9 rounded-md border border-line bg-panel px-2 text-sm font-normal normal-case text-text focus:border-accent-deep focus:outline-none"
            />
            <datalist id={`lista-${lado}`}>
              {nombres.map((n) => <option key={n} value={n} />)}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            Comprobantes
            <select
              value={modo}
              onChange={(e) => setModo(e.target.value as 'pendientes' | 'todos')}
              className="h-9 rounded-md border border-line bg-panel px-2 text-sm font-normal normal-case text-text focus:border-accent-deep focus:outline-none"
            >
              <option value="pendientes">Solo pendientes</option>
              <option value="todos">Todos, incluidos los cancelados</option>
            </select>
          </label>
          {(desde || parte || modo !== 'pendientes' || hasta !== todayLocal()) && (
            <button
              type="button"
              onClick={() => { setDesde(''); setHasta(todayLocal()); setParte(''); setModo('pendientes'); }}
              className="h-9 text-[13px] font-semibold text-accent-deep hover:underline"
            >
              Limpiar filtros
            </button>
          )}
          <span className="ml-auto self-center text-right text-text-soft">
            {bloques.length} {bloques.length === 1 ? t.parte.toLowerCase() : t.partes} · Saldo{' '}
            <strong className="text-text">$ {formatMoney(total)}</strong>
          </span>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
        )}
        {aviso && (
          <div className="mb-4 rounded-md border border-line-strong bg-panel-alt px-4 py-3 text-sm text-text" onClick={() => setAviso(null)}>
            {aviso}
          </div>
        )}
      </div>

      {loading ? (
        <p className="py-10 text-center text-text-soft">Cargando…</p>
      ) : bloques.length === 0 ? (
        <p className="py-10 text-center text-text-soft">
          {movimientos.length === 0 ? `Ningún ${t.parte.toLowerCase()} tiene movimientos.` : 'Nada coincide con los filtros.'}
        </p>
      ) : (
        <div ref={documentRef} className="print-document bg-panel">
          {/* Solo en el papel y en el PDF: en pantalla ya está la botonera. */}
          <div className="hidden border-b-2 border-accent pb-2 print:block">
            <p className="text-[18px] uppercase text-text-soft">{t.titulo}</p>
            <p className="text-[13px] text-text-soft">{periodo}</p>
          </div>
          {bloques.map((b) => (
            <BloqueDeSaldo key={b.parteId} bloque={b} desde={desde} lado={lado} />
          ))}
        </div>
      )}

      {enviando && (
        <SendDocumentModal
          channel="email"
          defaultDestino={unaSolaParte ? mails.get(unaSolaParte.parteId) ?? null : null}
          fileName={`composicion-saldos-${unaSolaParte ? unaSolaParte.nombre.replace(/[^\w]+/g, '-').toLowerCase() : lado}.pdf`}
          documentRef={documentRef}
          subject={unaSolaParte ? `Composición de saldo — ${unaSolaParte.nombre}` : t.titulo}
          text={
            unaSolaParte
              ? `Adjuntamos la composición de su saldo ${periodo}: $ ${formatMoney(unaSolaParte.totalSaldo)}.`
              : `Adjuntamos la composición de saldos ${periodo}.`
          }
          onClose={() => setEnviando(false)}
        />
      )}
    </div>
  );
}

function BloqueDeSaldo({ bloque, desde: d, lado: l }: { bloque: Bloque; desde: string; lado: Lado }) {
  const t = TEXTOS[l];
  return (
    <section className="mb-6 border-t-2 border-[#2b6cb0] pt-2">
      <div className="flex flex-wrap items-start justify-between gap-2 px-1">
        <div>
          <h2 className="text-[16px] font-bold uppercase text-[#d9480f]">{bloque.nombre}</h2>
          <p className="mt-2 text-[14px] text-text-soft">
            {bloque.cuit && <>CUIT {bloque.cuit} · </>}Moneda: Pesos (PES - PESOS)
            <Link to={t.ruta(bloque.parteId)} className="no-print ml-3 text-[13px] font-semibold text-accent-deep hover:underline">
              {TEXTOS[l].accion}
            </Link>
          </p>
        </div>
        <div className="text-right text-[14px] text-text-soft">
          {d && <p>Saldo anterior a {formatDate(d)} $ {formatMoney(bloque.saldoAnterior)}</p>}
          <p className="font-semibold text-text">Total saldo $ {formatMoney(bloque.totalSaldo)}</p>
        </div>
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-[14px]">
          <thead className="bg-[#666] text-white">
            <tr>
              <th className="px-2 py-2 font-semibold">Comprobante</th>
              <th className="px-2 py-2 font-semibold">Fecha</th>
              <th className="px-2 py-2 font-semibold">Vencimiento</th>
              <th className="px-2 py-2 font-semibold">Comprobante aplicado</th>
              <th className="px-2 py-2 font-semibold">Fecha aplicación</th>
              <th className="px-2 py-2 text-right font-semibold">Debe</th>
              <th className="px-2 py-2 text-right font-semibold">Haber</th>
              <th className="px-2 py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {bloque.renglones.map((r, i) => (
              <tr key={i} className={r.esAplicacion ? 'bg-panel' : 'bg-[#ececec]'}>
                <td className="px-2 py-1.5">
                  {r.ruta ? (
                    <Link to={r.ruta} className="text-[#2b6cb0] hover:underline">{r.comprobante}</Link>
                  ) : (
                    r.comprobante
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">{r.fecha ? formatDate(r.fecha) : ''}</td>
                <td className="whitespace-nowrap px-2 py-1.5">{r.vencimiento ? formatDate(r.vencimiento) : ''}</td>
                <td className="px-2 py-1.5 text-[#2b6cb0]">{r.aplicado}</td>
                <td className="whitespace-nowrap px-2 py-1.5">{r.fechaAplicacion ? formatDate(r.fechaAplicacion) : ''}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">{r.debe !== null ? `$ ${formatMoney(r.debe)}` : ''}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">{r.haber !== null ? `$ ${formatMoney(r.haber)}` : ''}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">{r.total !== null ? `$ ${formatMoney(r.total)}` : ''}</td>
              </tr>
            ))}
            {bloque.renglones.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-3 text-center text-text-soft">
                  Sin comprobantes en el período: el saldo es el anterior.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
