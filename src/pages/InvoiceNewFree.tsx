import React from 'react';
import { Receipt, AlertTriangle, ArrowRight, Truck, CalendarClock } from 'lucide-react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { formatMoney } from '@/src/lib/utils';
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
  describeInvoiceError,
  formatDate,
  INVOICE_TYPE_LABELS,
  invoiceTypeFor,
  issueFreeInvoice,
  PAYMENT_TERMS_DAYS,
  toDateString,
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
  const [isCash, setIsCash] = React.useState(false);
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
  const invoiceType = invoiceTypeFor(settings.taxCondition, customerCondition);
  const totals = computeTotals(items, invoiceType);

  const emptyLines = items.filter((item) => item.description.trim() === '').length;
  const canIssue =
    !!customerId && items.length > 0 && totals.total > 0 && emptyLines === 0 &&
    (!isCash || !!paymentMethodId || !!checkDrafts?.length) && !issuing;

  const issueDate = new Date();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + PAYMENT_TERMS_DAYS);

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
      const issued = await issueFreeInvoice(customer.id, items, notes, emitRemito, remitoId);
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

        <FieldBox label="Condición del cliente">
          {customer?.taxId && <span className="block font-mono text-[13px]">{formatCuit(customer.taxId)}</span>}
          <span className="block text-text-soft">{TAX_CONDITION_LABELS[customerCondition]}</span>
        </FieldBox>

        <FieldBox label="Domicilio">
          <span className="block truncate text-text-soft">
            {customer ? formatAddress(customer) || 'Sin domicilio cargado' : '—'}
          </span>
        </FieldBox>

        <FieldBox label="Emisor">
          <span className="block truncate font-semibold text-text">{settings.legalName}</span>
          {settings.taxId && <span className="block font-mono text-[12px] text-text-soft">{formatCuit(settings.taxId)}</span>}
        </FieldBox>

        <FieldBox label="Punto de venta">
          <span className="font-mono">{String(settings.salesPoint).padStart(4, '0')}</span>
        </FieldBox>

        <FieldBox label="Condición de venta">
          <span className="flex items-center gap-1.5">
            <CalendarClock size={14} className="text-accent-deep" /> Cuenta corriente
          </span>
        </FieldBox>

        <FieldBox label="Emisión / Vencimiento">
          <span className="block">{formatDate(toDateString(issueDate))}</span>
          <span className="block text-text-soft">
            Vence {formatDate(toDateString(dueDate))} ({PAYMENT_TERMS_DAYS} días)
          </span>
        </FieldBox>
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
          <SectionHeader title="Cómo se emite" className="mb-3" />
          {!remito && (
            <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
              <input
                type="checkbox"
                checked={emitRemito}
                onChange={(e) => setEmitRemito(e.target.checked)}
                className="w-4 h-4 accent-accent-deep"
              />
              Emitir remito junto con la factura
            </label>
          )}

          <CashCheckoutFields
            isCash={isCash}
            onIsCashChange={setIsCash}
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
