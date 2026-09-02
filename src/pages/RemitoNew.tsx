import React from 'react';
import { XCircle, Truck, AlertTriangle } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchCustomers, formatCuit, type Customer } from '@/src/lib/customers';
import { createRemito, describeRemitoError } from '@/src/lib/remitos';
import { getErrorMessage, type WorkOrderItemInput } from '@/src/lib/workOrders';

/**
 * Remito sin factura: registra qué se entrega ahora, para facturar después.
 * Reusa el mismo editor de renglones que las facturas —así el admin no
 * aprende una pantalla nueva— pero el precio que se cargue acá es solo de
 * referencia: create_remito no lo guarda, se valoriza recién al facturar.
 */
export function RemitoNew() {
  const { role } = useAuth();
  const navigate = useNavigate();

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [loading, setLoading] = React.useState(true);

  const [customerId, setCustomerId] = React.useState('');
  const [items, setItems] = React.useState<WorkOrderItemInput[]>([]);
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    let cancelled = false;
    Promise.all([fetchCustomers(true), fetchArticles(false)])
      .then(([customerRows, articleRows]) => {
        if (cancelled) return;
        setCustomers(customerRows);
        setArticles(articleRows);
      })
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [role]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">Cargando…</div>;
  }

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const emptyLines = items.filter((item) => item.description.trim() === '').length;
  const canSave = !!customerId && items.length > 0 && emptyLines === 0 && !saving;

  async function handleSave() {
    if (!customer || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createRemito(customer.id, items, notes);
      navigate('/remitos');
    } catch (err) {
      setError(describeRemitoError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Nuevo remito"
        subtitle="Sin factura todavía — se factura después, desde el listado de remitos."
        actions={
          <>
            <Link to="/remitos">
              <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
            </Link>
            <Button onClick={handleSave} disabled={!canSave}>
              <Truck size={16} /> {saving ? 'Guardando…' : 'Guardar remito'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="mb-6 p-5">
        <SectionHeader title="Cliente" />
        <label className="block text-xs font-bold uppercase tracking-wider text-text-soft sm:max-w-sm">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
          >
            <option value="">Elegí un cliente...</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.taxId ? ` — ${formatCuit(c.taxId)}` : ''}
              </option>
            ))}
          </select>
        </label>
      </Panel>

      <Panel className="mb-6 p-5">
        <ItemsEditor
          items={items}
          onChange={setItems}
          articles={articles}
          editable
          title="Qué se entrega"
          totals={
            <p className="text-xs text-text-soft">
              El precio que se ve acá es solo de referencia — el remito no lo guarda. Se carga en serio recién al facturarlo.
            </p>
          }
        />

        {emptyLines > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-danger">
            <AlertTriangle size={14} />
            {emptyLines === 1 ? 'Hay un renglón sin descripción.' : `Hay ${emptyLines} renglones sin descripción.`}
          </p>
        )}
      </Panel>

      <Panel className="mb-10 p-5">
        <SectionHeader title="Observaciones" />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Texto interno sobre esta entrega. Opcional."
          className="w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent-deep focus:outline-none"
        />
      </Panel>
    </div>
  );
}
