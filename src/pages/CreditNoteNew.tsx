import React from 'react';
import { XCircle, FileMinus, AlertTriangle, ArrowRight, Search } from 'lucide-react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, Panel, SectionHeader } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { formatCuit } from '@/src/lib/fiscal';
import {
  computeTotals,
  describeInvoiceError,
  fetchInvoiceById,
  fetchInvoices,
  formatDate,
  INVOICE_TYPE_LABELS,
  type InvoiceDetail,
  type InvoiceListRow,
} from '@/src/lib/invoices';
import { describeCreditNoteError, emitirNotaCredito } from '@/src/lib/creditNotes';
import { pedirCaeAlEmitir } from '@/src/lib/arcaFacturacion';
import { getErrorMessage, type WorkOrderItemInput } from '@/src/lib/workOrders';
import { FieldBox, selectCabecera } from '@/src/pages/InvoiceNew';

/**
 * Emitir una nota de crédito.
 *
 * El circuito arranca al revés que el de facturación: primero el comprobante
 * de referencia, porque de ahí sale todo lo demás —el cliente, la letra, el
 * punto de venta y los renglones—. Una nota de crédito no se inventa: siempre
 * revierte algo.
 *
 * Después la pregunta que parte el camino en dos. Si cancela la factura
 * entera, los renglones son los de la factura y no se tocan: cualquier
 * diferencia dejaría a la factura parcialmente viva, que es justo lo que no se
 * quiso. Si es parcial, los mismos renglones se proponen como punto de partida
 * y se editan —normalmente se borra lo que sí se cobra y queda lo que se
 * devuelve—.
 */
export function CreditNoteNew() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const facturaDeLaUrl = searchParams.get('factura');

  const [candidatas, setCandidatas] = React.useState<InvoiceListRow[]>([]);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [factura, setFactura] = React.useState<InvoiceDetail | null>(null);
  const [buscando, setBuscando] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  /** null = todavía no contestó. Es la pregunta que decide el resto. */
  const [cancelaTotal, setCancelaTotal] = React.useState<boolean | null>(null);
  const [items, setItems] = React.useState<WorkOrderItemInput[]>([]);
  const [motivo, setMotivo] = React.useState('');
  const [emitiendo, setEmitiendo] = React.useState(false);

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;
    Promise.all([fetchInvoices(), fetchArticles(false)])
      .then(([invoices, articleRows]) => {
        if (cancelled) return;
        // Solo las que ARCA conoce: una nota de crédito revierte un
        // comprobante fiscal, y la X no lo es.
        setCandidatas(
          invoices.filter((i) => i.status === 'EMITIDA' && i.invoiceType !== 'X')
        );
        setArticles(articleRows);
      })
      .catch((err) => !cancelled && setError(describeInvoiceError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [role]);

  // Cuando se entra desde una factura, viene elegida por la URL.
  React.useEffect(() => {
    if (!facturaDeLaUrl) return;
    fetchInvoiceById(facturaDeLaUrl)
      .then((f) => f && elegirFactura(f))
      .catch((err) => setError(describeInvoiceError(getErrorMessage(err))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facturaDeLaUrl]);

  function elegirFactura(f: InvoiceDetail) {
    setFactura(f);
    setCancelaTotal(null);
    setItems([]);
  }

  /** Los renglones de la factura, tal cual, como punto de partida. */
  function renglonesDeLaFactura(f: InvoiceDetail): WorkOrderItemInput[] {
    return f.items.map((i) => ({
      articleId: null,
      code: i.code ?? '',
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    }));
  }

  function responder(total: boolean) {
    if (!factura) return;
    setCancelaTotal(total);
    setItems(renglonesDeLaFactura(factura));
  }

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) return <div className="w-full p-8 text-center text-text-soft">Cargando…</div>;

  const totals = factura
    ? computeTotals(items, factura.invoiceType)
    : { net: 0, vat: 0, total: 0 };

  const disponible = factura
    ? Math.round((factura.totalAmount - factura.creditedAmount) * 100) / 100
    : 0;

  const renglonesVacios = items.filter((i) => i.description.trim() === '').length;
  const puedeEmitir =
    !!factura && cancelaTotal !== null && items.length > 0 &&
    totals.total > 0 && renglonesVacios === 0 && !emitiendo;

  async function handleEmitir() {
    if (!factura || cancelaTotal === null || !puedeEmitir) return;

    const confirmado = window.confirm(
      `Emitir una nota de crédito ${factura.invoiceType} por $ ${formatMoney(totals.total)} ` +
        `que revierte la ${factura.fullNumber} de ${factura.customerName}.\n\n` +
        (cancelaTotal
          ? 'Cancela la factura entera: el cliente deja de deber ese comprobante.\n\n'
          : 'Es una nota de crédito parcial: baja el saldo de la factura en ese importe.\n\n') +
        'Se le va a pedir el CAE a ARCA en este mismo paso. Una vez autorizada, la ' +
        'nota de crédito es un comprobante fiscal y no se puede deshacer.'
    );
    if (!confirmado) return;

    setEmitiendo(true);
    setError(null);
    try {
      const nc = await emitirNotaCredito(
        factura.id,
        items.map((i) => ({
          articleId: i.articleId ?? null,
          code: i.code,
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
        cancelaTotal,
        motivo
      );

      await pedirCaeAlEmitir(nc.id, nc.fullNumber, 'nota de crédito');
      navigate(`/nota-credito/${nc.id}`);
    } catch (err) {
      setError(describeCreditNoteError(getErrorMessage(err)));
      setEmitiendo(false);
    }
  }

  const filtradas = candidatas.filter((c) => {
    const term = buscando.trim().toLowerCase();
    if (!term) return true;
    return [c.fullNumber, c.customerName].some((v) => String(v).toLowerCase().includes(term));
  });

  return (
    <div className="w-full">
      <div
        className="sticky z-20 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b-[3px] border-accent bg-panel px-4 py-3 sm:px-5"
        style={{ top: 'calc(3.5rem + var(--safe-top))' }}
      >
        <h1 className="font-display text-xl uppercase tracking-[0.04em] leading-none text-text">
          Nota de crédito
        </h1>
        <div className="flex items-center gap-2">
          <Link to="/notas-credito">
            <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
          </Link>
          <Button onClick={handleEmitir} disabled={!puedeEmitir}>
            <FileMinus size={16} /> {emitiendo ? 'Emitiendo…' : 'Emitir nota de crédito'}
          </Button>
        </div>
      </div>

      <div className="space-y-6 p-4 sm:p-5">
        {error && (
          <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {/* Paso 1: el comprobante de referencia */}
        <Panel className="p-5">
          <SectionHeader title="Comprobante de referencia" />
          {factura ? (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-4">
              <FieldBox label="Factura">
                <span className="font-mono font-semibold">{factura.fullNumber}</span>
                <span className="ml-2 text-[12px] uppercase tracking-[0.06em] text-text-faint">
                  {INVOICE_TYPE_LABELS[factura.invoiceType]}
                </span>
              </FieldBox>
              <FieldBox label="Cliente">
                {factura.customerLegalName || factura.customerName}
                {factura.customerTaxId && (
                  <span className="ml-2 font-mono text-text-soft">
                    {formatCuit(factura.customerTaxId)}
                  </span>
                )}
              </FieldBox>
              <FieldBox label="Emisión">{formatDate(factura.issueDate)}</FieldBox>
              <FieldBox label="Total de la factura">
                $ {formatMoney(factura.totalAmount)}
              </FieldBox>
              <div className="sm:col-span-4">
                <Button variant="ghost" type="button" onClick={() => { setFactura(null); setCancelaTotal(null); setItems([]); }}>
                  Elegir otra
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="mt-1 text-xs text-text-soft">
                La nota de crédito revierte una factura concreta. De ella salen el
                cliente, la letra y el punto de venta.
              </p>
              <label className="mt-3 flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2">
                <Search size={16} className="text-text-faint" />
                <input
                  value={buscando}
                  onChange={(e) => setBuscando(e.target.value)}
                  placeholder="Buscar por número o cliente…"
                  className="w-full bg-transparent text-sm text-text outline-none"
                />
              </label>
              <div className="mt-3 max-h-80 overflow-y-auto border border-line">
                {filtradas.length === 0 && (
                  <p className="px-3 py-4 text-center text-sm text-text-soft">
                    No hay facturas fiscales emitidas para referenciar.
                  </p>
                )}
                {filtradas.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() =>
                      fetchInvoiceById(c.id)
                        .then((f) => f && elegirFactura(f))
                        .catch((err) => setError(getErrorMessage(err)))
                    }
                    className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2 text-left text-sm hover:bg-panel-alt"
                  >
                    <span className="font-mono font-semibold">{c.fullNumber}</span>
                    <span className="flex-1 truncate text-text-soft">{c.customerName}</span>
                    <span className="text-text-soft">{formatDate(c.issueDate)}</span>
                    <span className="font-semibold">$ {formatMoney(c.totalAmount)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </Panel>

        {/* Paso 2: la pregunta que parte el camino */}
        {factura && (
          <Panel className="p-5">
            <SectionHeader title="¿Cancela la factura entera?" />
            <p className="mt-1 text-xs text-text-soft">
              Si la cancela, la nota de crédito se arma con todos los datos de la
              factura y no se editan. Si no, esos mismos datos se proponen como
              punto de partida y se pueden modificar.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Button
                type="button"
                variant={cancelaTotal === true ? undefined : 'ghost'}
                onClick={() => responder(true)}
              >
                Sí, cancela la {factura.fullNumber} completa
              </Button>
              <Button
                type="button"
                variant={cancelaTotal === false ? undefined : 'ghost'}
                onClick={() => responder(false)}
              >
                No, es parcial
              </Button>
            </div>

            {cancelaTotal === false && disponible > 0 && (
              <p className="mt-3 flex items-start gap-2 text-xs text-text-soft">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                Esta factura admite hasta $ {formatMoney(disponible)} de nota de
                crédito. Por encima de eso el cliente quedaría con saldo a favor
                salido de la nada, y la base lo rechaza.
              </p>
            )}
          </Panel>
        )}

        {/* Paso 3: los renglones */}
        {factura && cancelaTotal !== null && (
          <>
            <ItemsEditor
              items={items}
              onChange={setItems}
              articles={articles}
              editable={!cancelaTotal}
              title={cancelaTotal ? 'Renglones (los de la factura, sin cambios)' : 'Renglones a acreditar'}
              totals={
                <div className="flex flex-col items-end gap-1 text-sm">
                  <span className="text-text-soft">Neto $ {formatMoney(totals.net)}</span>
                  <span className="text-text-soft">IVA $ {formatMoney(totals.vat)}</span>
                  <span className="text-lg font-semibold text-text">
                    Total $ {formatMoney(totals.total)}
                  </span>
                </div>
              }
            />

            <Panel className="p-5">
              <SectionHeader title="Motivo" />
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Devolución de repuesto, error en el importe…"
                className={cn(selectCabecera, 'mt-3 w-full')}
              />
              <p className="mt-2 text-xs text-text-soft">
                Queda impreso en el comprobante. No es obligatorio para ARCA, pero es
                lo único que explica, meses después, por qué existió esta nota.
              </p>
            </Panel>
          </>
        )}

        {!factura && (
          <p className="flex items-center gap-2 text-sm text-text-soft">
            <ArrowRight size={16} /> Elegí la factura que querés revertir para seguir.
          </p>
        )}
      </div>
    </div>
  );
}
