import React from 'react';
import { Receipt, AlertTriangle, ArrowRight, Truck, CalendarClock } from 'lucide-react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { cn, formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, Panel, SectionHeader } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import {
  fetchCompanySettings,
  formatAddress,
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
import { Blocked, CashCheckoutFields, FieldBox, InvoiceTopBar, InvoiceTotals } from '@/src/pages/InvoiceNew';
import { getErrorMessage, type WorkOrderItemInput } from '@/src/lib/workOrders';
import { fetchRemitoById, type Remito } from '@/src/lib/remitos';
import { fetchBanks, type Bank } from '@/src/lib/banks';
import { CheckDraftModal, type CheckDraft } from '@/src/components/CheckDraftModal';

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
    return <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">Cargando…</div>;
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
        customer.id, items, notes, emitRemito, invoiceType, condicion as CondicionVenta, remitoId
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
    <div className="mx-auto max-w-5xl">
      <InvoiceTopBar
        title="Factura de venta"
        type={invoiceType}
        subtitle={
          remito ? (
            <span className="inline-flex items-center gap-1.5">
              <Truck size={13} className="text-accent-deep" /> Facturando el remito {remito.fullNumber}
            </span>
          ) : (
            'Sin orden de trabajo ni cotización — se carga el cliente y los renglones a mano.'
          )
        }
        numero={proximo}
        total={totals.total}
        cancelHref="/facturas"
        onIssue={handleIssue}
        issuing={issuing}
        canIssue={canIssue}
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <FieldBox label="Cliente" className="col-span-2 sm:col-span-2">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={!!remito}
            className="w-full border border-line bg-panel-alt px-2 py-1 text-xs focus:border-accent-deep focus:outline-none disabled:opacity-60"
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
          {customers.length === 0 && !remito && (
            <span className="mt-1 block text-[11px] normal-case text-state-wait">
              No hay clientes activos. Cargá uno desde la sección Clientes.
            </span>
          )}
        </FieldBox>

        <FieldBox label="Tipo de factura">
          <select
            value={invoiceType}
            onChange={(e) => setInvoiceType(e.target.value as InvoiceType)}
            className="w-full border-0 bg-transparent p-0 text-[13px] font-semibold text-text focus:outline-none"
          >
            {LETRAS_EMISIBLES.map((l) => (
              <option key={l} value={l}>{INVOICE_TYPE_LABELS[l]}</option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] normal-case text-text-soft">
            {invoiceType === 'X' ? 'Sin validez fiscal' : 'Numeración fiscal'}
          </span>
        </FieldBox>

        <FieldBox label="Condición de venta">
          <select
            value={condicion}
            onChange={(e) => setCondicion(e.target.value as CondicionVenta)}
            className={cn(
              'w-full border-0 bg-transparent p-0 text-[13px] font-semibold text-text focus:outline-none',
              condicion === '' && 'text-danger'
            )}
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
                : `Vence a ${PAYMENT_TERMS_DAYS} días`}
          </span>
        </FieldBox>

        <FieldBox label="Emisión / Vencimiento">
          <span className="block">{formatDate(toDateString(issueDate))}</span>
          <span className="block text-text-soft">
            {condicion === ''
              ? 'Según la condición de venta'
              : isCash
                ? 'Contado: vence el mismo día'
                : `Vence ${formatDate(toDateString(dueDate))} (${PAYMENT_TERMS_DAYS} días)`}
          </span>
        </FieldBox>

        {/* Con remito de origen no hay nada que elegir: ya existe y se vincula. */}
        {!remito && (
          <FieldBox label="Remito">
            <label className="flex cursor-pointer items-center gap-2 text-[13px] normal-case text-text">
              <input
                type="checkbox"
                checked={emitRemito}
                onChange={(e) => setEmitRemito(e.target.checked)}
                className="h-4 w-4 accent-accent-deep"
              />
              Emitir junto con la factura
            </label>
          </FieldBox>
        )}
      </div>

      <Panel className="mb-4 p-4">
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

      <div className="mb-10 grid grid-cols-1 gap-2 md:grid-cols-2">
        <Panel className="p-4">
          <SectionHeader title="Cómo se cobra" className="mb-3" />
          <CashCheckoutFields
            isCash={isCash}
            paymentMethods={paymentMethods}
            paymentMethodId={paymentMethodId}
            onPaymentMethodIdChange={setPaymentMethodId}
            checkDrafts={checkDrafts}
            onOpenCheckModal={() => setCheckModalOpen(true)}
            onClearChecks={() => setCheckDrafts(null)}
          />
        </Panel>

        <Panel className="p-4">
          <SectionHeader title="Observaciones" className="mb-3" />
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Texto que sale impreso en el comprobante. Opcional."
            className="w-full resize-y border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
          />
        </Panel>
      </div>

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
