import React from 'react';
import { XCircle, Receipt, AlertTriangle, ArrowRight } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { formatMoney } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import {
  fetchCompanySettings,
  isReadyToInvoice,
  type CompanySettings,
} from '@/src/lib/companySettings';
import {
  computeTotals,
  describeInvoiceError,
  INVOICE_TYPE_LABELS,
  invoiceTypeFor,
  issueFreeInvoice,
} from '@/src/lib/invoices';
import { Blocked, InvoiceTotals, InvoiceTypeBadge } from '@/src/pages/InvoiceNew';
import { getErrorMessage, type WorkOrderItemInput } from '@/src/lib/workOrders';

/**
 * Facturar sin OT ni cotización: para lo que no sale de una reparación
 * (venta de un repuesto suelto, un servicio puntual). Mismo comprobante,
 * misma cuenta corriente a 7 días — solo cambia de dónde sale el cliente
 * y los renglones: acá se cargan a mano en vez de heredarlos de una orden.
 */
export function InvoiceNewFree() {
  const { role } = useAuth();
  const navigate = useNavigate();

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [company, setCompany] = React.useState<CompanySettings | null>(null);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [loading, setLoading] = React.useState(true);

  const [customerId, setCustomerId] = React.useState('');
  const [items, setItems] = React.useState<WorkOrderItemInput[]>([]);
  const [notes, setNotes] = React.useState('');
  const [emitRemito, setEmitRemito] = React.useState(false);
  const [issuing, setIssuing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;
    Promise.all([fetchCustomers(true), fetchCompanySettings()])
      .then(([customerRows, settings]) => {
        if (cancelled) return;
        setCustomers(customerRows);
        setCompany(settings);
      })
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    fetchArticles(false)
      .then((data) => !cancelled && setArticles(data))
      .catch(() => {/* el catálogo es opcional: se puede seguir cargando líneas manuales */});
    return () => { cancelled = true; };
  }, [role]);

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
  const canIssue = !!customerId && items.length > 0 && totals.total > 0 && emptyLines === 0 && !issuing;

  async function handleIssue() {
    if (!customer || !canIssue) return;
    const confirmed = window.confirm(
      `Emitir ${INVOICE_TYPE_LABELS[invoiceType]} por $ ${formatMoney(totals.total)} a ${customer.name}?\n\n` +
        `Una vez emitida no se puede editar: solo anular.`
    );
    if (!confirmed) return;

    setIssuing(true);
    setError(null);
    try {
      const issued = await issueFreeInvoice(customer.id, items, notes, emitRemito);
      navigate(`/factura/${issued.id}`);
    } catch (err) {
      setError(describeInvoiceError(getErrorMessage(err)));
      setIssuing(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Facturar"
        meta={<InvoiceTypeBadge type={invoiceType} />}
        subtitle="Sin orden de trabajo ni cotización — se carga el cliente y los renglones a mano."
        actions={
          <>
            <Link to="/facturas">
              <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
            </Link>
            <Button onClick={handleIssue} disabled={!canIssue}>
              <Receipt size={16} /> {issuing ? 'Emitiendo…' : 'Emitir factura'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-6 border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="mb-6 p-5">
        <SectionHeader title="Cliente" />
        <label className="block text-xs font-bold uppercase tracking-wider text-text-soft sm:max-w-sm">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="mt-1 w-full border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
          >
            <option value="">Elegí un cliente...</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.taxId ? ` — ${formatCuit(c.taxId)}` : ''}
              </option>
            ))}
          </select>
          {customers.length === 0 && (
            <span className="mt-1 block text-[10px] font-normal normal-case text-state-wait">
              No hay clientes activos. Cargá uno desde la sección Clientes.
            </span>
          )}
        </label>
      </Panel>

      <Panel className="mb-6 p-5">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable
          title="Renglones a facturar"
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

      <Panel className="mb-10 p-5">
        <SectionHeader title="Observaciones" />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Texto que sale impreso en el comprobante. Opcional."
          className="w-full resize-y border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
        />
        <label className="mt-3 flex items-center gap-2 text-sm text-text cursor-pointer">
          <input
            type="checkbox"
            checked={emitRemito}
            onChange={(e) => setEmitRemito(e.target.checked)}
            className="w-4 h-4 accent-accent-deep"
          />
          Emitir remito junto con la factura
        </label>
      </Panel>
    </div>
  );
}
