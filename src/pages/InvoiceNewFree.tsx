import React from 'react';
import { Receipt, AlertTriangle, ArrowRight } from 'lucide-react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, Panel, SectionHeader } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import {
  fetchCompanySettings,
  isReadyToInvoice,
  type CompanySettings,
} from '@/src/lib/companySettings';
import {
  computeTotals,
  CONDICION_VENTA_LABELS,
  describeInvoiceError,
  formatDate,
  INVOICE_TYPE_LABELS,
  invoiceTypeFor,
  issueFreeInvoice,
  fetchProximoNumero,
  LETRAS_EMISIBLES,
  PAYMENT_TERMS_DAYS,
  toDateString,
  type CondicionVenta,
  type InvoiceType,
} from '@/src/lib/invoices';
import { fetchPaymentMethods, type PaymentMethod } from '@/src/lib/paymentMethods';
import { describeReceiptError, saveReceipt } from '@/src/lib/receipts';
import {
  Blocked,
  CashCheckoutFields,
  FieldBox,
  InvoiceTopBar,
  InvoiceTotals,
  selectCabecera,
  SiNo,
} from '@/src/pages/InvoiceNew';
import { getErrorMessage, type WorkOrderItemInput } from '@/src/lib/workOrders';
import { fetchRemitoById, type Remito } from '@/src/lib/remitos';
import { fetchBanks, type Bank } from '@/src/lib/banks';
import { CheckDraftModal, type CheckDraft } from '@/src/components/CheckDraftModal';
import { CustomerModal } from '@/src/components/CustomerModal';

/**
 * Facturar sin OT ni cotización: para lo que no sale de una reparación
 * (venta de un repuesto suelto, un servicio puntual). Mismo comprobante,
 * misma cuenta corriente a 7 días — solo cambia de dónde sale el cliente
 * y los renglones: acá se cargan a mano en vez de heredarlos de una orden.
 */
export function InvoiceNewFree() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const remitoId = searchParams.get('remito');

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [company, setCompany] = React.useState<CompanySettings | null>(null);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [remito, setRemito] = React.useState<Remito | null>(null);

  const [customerId, setCustomerId] = React.useState('');
  const [items, setItems] = React.useState<WorkOrderItemInput[]>([]);
  const [notes, setNotes] = React.useState('');
  const [emitRemito, setEmitRemito] = React.useState(false);
  const [paymentMethods, setPaymentMethods] = React.useState<PaymentMethod[]>([]);
  const [invoiceType, setInvoiceType] = React.useState<InvoiceType>('X');
  // Sin valor inicial: elegirla es parte de emitir, y un default se confirma
  // sin mirarlo. La base también la exige.
  const [condicion, setCondicion] = React.useState<CondicionVenta | ''>('');
  const [proximo, setProximo] = React.useState<string | null>(null);
  // La ficha del cliente abierta en el modal: null = cerrado, { customer: null }
  // = alta, { customer } = modificación del que ya está elegido.
  const [fichaCliente, setFichaCliente] = React.useState<{ customer: Customer | null } | null>(null);
  const [vencimiento, setVencimiento] = React.useState('');
  const [paymentMethodId, setPaymentMethodId] = React.useState('');
  const [banks, setBanks] = React.useState<Bank[]>([]);
  const [checkDrafts, setCheckDrafts] = React.useState<CheckDraft[] | null>(null);
  const [checkModalOpen, setCheckModalOpen] = React.useState(false);
  const [issuing, setIssuing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;
    Promise.all([fetchCustomers(true), fetchCompanySettings(), fetchArticles(false)])
      .then(([customerRows, settings, articleRows]) => {
        if (cancelled) return;
        setCustomers(customerRows);
        setCompany(settings);
        setArticles(articleRows);
        if (!remitoId) return;
        return fetchRemitoById(remitoId).then((r) => {
          if (cancelled || !r) return;
          setRemito(r);
          setCustomerId(r.customerId);
          setItems(
            r.items.map((item) => ({
              articleId: item.articleId,
              code: item.code ?? '',
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.articleId ? articleRows.find((a) => a.id === item.articleId)?.unitPrice ?? 0 : 0,
            }))
          );
        });
      })
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    fetchPaymentMethods(true)
      .then((data) => !cancelled && setPaymentMethods(data))
      .catch(() => {/* si falla, el check de contado queda sin opciones y no se puede tildar */});
    fetchBanks(true)
      .then((data) => !cancelled && setBanks(data))
      .catch(() => {/* si falla, el combobox de banco del cheque arranca vacío pero se puede cargar uno nuevo igual */});
    return () => { cancelled = true; };
  }, [role, remitoId]);

  // Cada letra tiene su numeración: se vuelve a pedir al cambiarla.
  React.useEffect(() => {
    let cancelado = false;
    fetchProximoNumero(invoiceType)
      .then((p) => !cancelado && setProximo(p?.fullNumber ?? null))
      .catch(() => !cancelado && setProximo(null));
    return () => { cancelado = true; };
  }, [invoiceType]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="w-full p-8 text-center text-text-soft">Cargando…</div>;
  }

  if (!isReadyToInvoice(company)) {
    return (
      <Blocked title="Faltan los datos fiscales del taller.">
        <p className="mb-4 text-sm text-text-soft">
          La razón social, el CUIT y el punto de venta encabezan cada factura y
          definen la letra del comprobante. Sin ellos no se puede emitir.
        </p>
        <Link to="/configuracion">
          <Button>
            Cargar datos fiscales <ArrowRight size={16} />
          </Button>
        </Link>
      </Blocked>
    );
  }

  const settings = company!;
  const customer = customers.find((c) => c.id === customerId) ?? null;
  const customerCondition = customer?.taxCondition ?? 'CONSUMIDOR_FINAL';
  // La letra la elige quien emite; para el IVA manda la que le correspondería
  // al cliente, también en la X, para que el total dé lo mismo.
  const letraFiscal = invoiceTypeFor(settings.taxCondition, customerCondition);
  const totals = computeTotals(items, invoiceType === 'X' ? letraFiscal : invoiceType);

  const isCash = condicion === 'CONTADO';

  const emptyLines = items.filter((item) => item.description.trim() === '').length;
  const canIssue =
    !!customerId && items.length > 0 && totals.total > 0 && emptyLines === 0 &&
    condicion !== '' &&
    (!isCash || !!paymentMethodId || !!checkDrafts?.length) && !issuing;

  const issueDate = new Date();
  const dueDate = new Date();
  if (!isCash) dueDate.setDate(dueDate.getDate() + PAYMENT_TERMS_DAYS);

  async function handleIssue() {
    if (!customer || !canIssue) return;
    const confirmed = window.confirm(
      `Emitir ${INVOICE_TYPE_LABELS[invoiceType]} por $ ${formatMoney(totals.total)} a ${customer.name}` +
        `${isCash ? ' y cobrarla de contado' : ''}?\n\n` +
        `Una vez emitida no se puede editar: solo anular.`
    );
    if (!confirmed) return;

    setIssuing(true);
    setError(null);
    try {
      const issued = await issueFreeInvoice(
        customer.id, items, notes, emitRemito, invoiceType, condicion as CondicionVenta,
        isCash ? null : (vencimiento || null), remitoId
      );
      if (isCash) {
        try {
          const values = checkDrafts?.length
            ? checkDrafts.map((c) => ({
                kind: 'CHEQUE' as const,
                amount: c.amount,
                checkNumber: c.checkNumber,
                checkBank: c.checkBank,
                checkDueDate: c.checkDueDate,
              }))
            : [{ kind: 'MEDIO_PAGO' as const, amount: totals.total, paymentMethodId }];
          await saveReceipt(
            { customerId: customer.id, receiptDate: toDateString(new Date()), notes: 'Factura de contado' },
            [{ invoiceId: issued.id, amount: totals.total }],
            values
          );
        } catch (receiptErr) {
          window.alert(
            `La factura ${issued.fullNumber} se emitió, pero el cobro automático falló: ` +
              `${describeReceiptError(getErrorMessage(receiptErr))}\n\nRegistrá el cobro a mano desde Cobranzas.`
          );
        }
      }
      navigate('/facturas');
    } catch (err) {
      setError(describeInvoiceError(getErrorMessage(err)));
      setIssuing(false);
    }
  }

  return (
    <div className="w-full">
      <InvoiceTopBar
        title="Factura de venta"
        cancelHref="/facturas"
        onIssue={handleIssue}
        issuing={issuing}
        canIssue={canIssue}
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Dos filas de cuatro —el cliente ocupa dos lugares—, con Cobrado con
          debajo de la condición de venta que lo hace aparecer. */}
      <div className="mb-6 grid grid-cols-2 gap-x-6 gap-y-4 border-b-2 border-accent px-4 py-4 sm:grid-cols-4 sm:px-5">
        <FieldBox label="Cliente" className="col-span-2">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={!!remito}
            className={cn(selectCabecera, 'w-full disabled:opacity-60')}
          >
            <option value="">Elegí un cliente...</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.taxId ? ` — ${formatCuit(c.taxId)}` : ''}
              </option>
            ))}
          </select>
          {remito && (
            <span className="mt-1 block text-[11px] normal-case text-text-soft">
              Es el cliente del remito {remito.fullNumber} — no se puede cambiar acá.
            </span>
          )}
          {/* El alta y la modificación se hacen acá mismo: facturar no puede
              obligar a salir a Clientes, arreglar la ficha y volver a empezar.
              Modificar se permite aun con remito —cambia la ficha, no a quién
              se le factura—; dar de alta otro, no. */}
          <div className="mt-1 flex items-center gap-3">
            {customer && (
              <button
                type="button"
                onClick={() => setFichaCliente({ customer })}
                className="text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
              >
                Modificar cliente
              </button>
            )}
            {!remito && (
              <button
                type="button"
                onClick={() => setFichaCliente({ customer: null })}
                className="text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline"
              >
                + Nuevo cliente
              </button>
            )}
          </div>
        </FieldBox>

        <FieldBox label="Tipo de factura">
          {/* La letra y el número, uno al lado del otro y del mismo tamaño:
              juntos son la identidad del comprobante. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <select
              value={invoiceType}
              onChange={(e) => setInvoiceType(e.target.value as InvoiceType)}
              className={cn(selectCabecera, 'w-auto shrink-0')}
            >
              {LETRAS_EMISIBLES.map((l) => (
                <option key={l} value={l}>{INVOICE_TYPE_LABELS[l]}</option>
              ))}
            </select>
            <span className="whitespace-nowrap font-mono text-sm normal-case text-text">
              {proximo ?? (invoiceType === 'X' ? 'Sin validez fiscal' : 'Numeración fiscal')}
            </span>
          </div>
        </FieldBox>

        <FieldBox label="Condición de venta">
          <select
            value={condicion}
            onChange={(e) => setCondicion(e.target.value as CondicionVenta)}
            className={cn(selectCabecera, 'w-full', condicion === '' && 'border-danger text-danger')}
          >
            <option value="">Elegí una…</option>
            <option value="CUENTA_CORRIENTE">{CONDICION_VENTA_LABELS.CUENTA_CORRIENTE}</option>
            <option value="CONTADO">{CONDICION_VENTA_LABELS.CONTADO}</option>
          </select>
          <span className="mt-1 block text-[11px] normal-case text-text-soft">
            {condicion === ''
              ? 'Obligatoria para emitir'
              : isCash
                ? 'Se cobra al emitir'
                : 'Queda impaga: se cobra desde Cobranzas'}
          </span>
        </FieldBox>

        <FieldBox label="Emisión">
          <span className="block">{formatDate(toDateString(issueDate))}</span>
          <span className="block text-[11px] normal-case text-text-soft">Hoy</span>
        </FieldBox>

        <FieldBox label="Vencimiento">
          {condicion === 'CUENTA_CORRIENTE' ? (
            <>
              <input
                type="date"
                value={vencimiento || toDateString(dueDate)}
                min={toDateString(issueDate)}
                onChange={(e) => setVencimiento(e.target.value)}
                className="w-full border-0 bg-transparent p-0 font-mono text-[13px] font-semibold text-text focus:outline-none"
              />
              <span className="mt-1 block text-[11px] normal-case text-text-soft">
                Se puede corregir después desde la factura.
              </span>
            </>
          ) : (
            <>
              <span className="block">
                {condicion === '' ? '—' : formatDate(toDateString(issueDate))}
              </span>
              <span className="mt-1 block text-[11px] normal-case text-text-soft">
                {condicion === '' ? 'Según la condición de venta' : 'Contado: vence el mismo día'}
              </span>
            </>
          )}
        </FieldBox>

        {/* Con remito de origen no hay nada que elegir: ya existe y se vincula. */}
        {!remito && (
          <FieldBox label="Remito">
            <SiNo value={emitRemito} onChange={setEmitRemito} />
            <span className="mt-1 block text-[11px] normal-case text-text-soft">
              Emitir junto con la factura
            </span>
          </FieldBox>
        )}

        {isCash && (
          <FieldBox label="Cobrado con">
            <CashCheckoutFields
              paymentMethods={paymentMethods}
              paymentMethodId={paymentMethodId}
              onPaymentMethodIdChange={setPaymentMethodId}
              checkDrafts={checkDrafts}
              onOpenCheckModal={() => setCheckModalOpen(true)}
              onClearChecks={() => setCheckDrafts(null)}
            />
          </FieldBox>
        )}
      </div>

      <Panel className="mb-4 rounded-lg p-4">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable
          totals={<InvoiceTotals type={invoiceType} totals={totals} />}
        />

        {emptyLines > 0 && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-danger">
            <AlertTriangle size={14} />
            {emptyLines === 1
              ? 'Hay un renglón sin descripción.'
              : `Hay ${emptyLines} renglones sin descripción.`}
          </p>
        )}
      </Panel>

      {/* Con qué se cobra subió al encabezado, así que abajo queda solo lo
          único que no es una decisión: el texto que sale impreso. */}
      <Panel className="mb-10 rounded-lg p-4">
        <SectionHeader title="Observaciones" className="mb-3" />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Texto que sale impreso en el comprobante. Opcional."
          className="w-full resize-y border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
        />
      </Panel>

      {fichaCliente && (
        <CustomerModal
          customer={fichaCliente.customer}
          onClose={() => setFichaCliente(null)}
          onSaved={(guardado) => {
            const eraAlta = fichaCliente.customer === null;
            setFichaCliente(null);
            setCustomers((actuales) =>
              (eraAlta
                ? [...actuales, guardado]
                : actuales.map((c) => (c.id === guardado.id ? guardado : c))
              ).sort((a, b) => a.name.localeCompare(b.name))
            );
            // Queda elegido: es para eso que se lo dio de alta desde acá.
            if (eraAlta) setCustomerId(guardado.id);
          }}
        />
      )}

      {checkModalOpen && (
        <CheckDraftModal
          remainingBase={totals.total}
          banks={banks}
          onBankCreated={(bank) => setBanks((current) => [...current, bank])}
          onConfirm={(checks) => {
            setCheckDrafts(checks);
            setCheckModalOpen(false);
          }}
          onClose={() => setCheckModalOpen(false)}
        />
      )}
    </div>
  );
}
