import { cn } from '@/src/lib/utils';
import React from 'react';
import { XCircle, FileText, AlertTriangle } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { ItemsEditor } from '@/src/components/ItemsEditor';
import { AccionesDeCampo, Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchCustomers, type Customer } from '@/src/lib/customers';
import { crearCotizacion, defaultValidUntil } from '@/src/lib/quotations';
import { getErrorMessage, type WorkOrderItemInput } from '@/src/lib/workOrders';
import { ClienteCombobox } from '@/src/components/ClienteCombobox';
import { CustomerModal } from '@/src/components/CustomerModal';
import { SelectorDeSector, sectorPorDefecto } from '@/src/components/SelectorDeSector';
import { labelClass, inputClass } from '@/src/components/FiscalFields';

/**
 * Cotización sin orden de trabajo: un presupuesto por un trabajo o un
 * repuesto que todavía no entró al taller. El equipo es opcional (el cliente
 * puede no tener nada cargado, o ser una consulta) y más adelante se la puede
 * enganchar a una OT desde la propia cotización.
 */
export function QuotationNew() {
  const { role } = useAuth();
  const navigate = useNavigate();

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [loading, setLoading] = React.useState(true);

  const [customerId, setCustomerId] = React.useState('');
  const [vehicleId, setVehicleId] = React.useState('');
  const [sectorId, setSectorId] = React.useState('');
  const [component, setComponent] = React.useState('');
  const [validUntil, setValidUntil] = React.useState(defaultValidUntil());
  const [items, setItems] = React.useState<WorkOrderItemInput[]>([]);
  const [notes, setNotes] = React.useState('');
  const [fichaCliente, setFichaCliente] = React.useState(false);
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

  const customer = customers.find((c) => c.id === customerId) ?? null;

  // Al cambiar de cliente, el equipo y el sector del anterior dejan de valer.
  React.useEffect(() => {
    setVehicleId('');
    setSectorId(sectorPorDefecto(customer?.sectors));
  }, [customerId]);

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) {
    return <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">Cargando…</div>;
  }

  const equipos = (customer?.vehicles ?? []).filter((v) => v.active);
  const emptyLines = items.filter((item) => item.description.trim() === '').length;
  const canSave = !!customerId && items.length > 0 && emptyLines === 0 && !saving;

  async function handleSave() {
    if (!customer || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const creada = await crearCotizacion({
        customerId: customer.id,
        vehicleId: vehicleId || null,
        sectorId: sectorId || null,
        component,
        notes,
        validUntil,
        items,
      });
      navigate(`/cotizacion/${creada.number}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Nueva cotización"
        subtitle="Sin orden de trabajo: se emite ahora y, si el cliente acepta, se engancha a una OT después."
        actions={
          <>
            <Link to="/cotizaciones">
              <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
            </Link>
            <Button onClick={handleSave} disabled={!canSave}>
              <FileText size={16} /> {saving ? 'Guardando…' : 'Emitir cotización'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="mb-6 p-5">
        <SectionHeader title="Cliente y trabajo" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={cn(labelClass, 'sm:col-span-2')}>
            Cliente *
            <div className="mt-1 flex">
              <ClienteCombobox
                clientes={customers}
                value={customerId}
                onChange={(id) => setCustomerId(id)}
                className={cn('flex-1 rounded-r-none', !customerId && 'field-required')}
              />
              <AccionesDeCampo
                nuevo={{ titulo: 'Dar de alta un cliente nuevo', onClick: () => setFichaCliente(true) }}
              />
            </div>
          </label>

          {customer && customer.sectors.length > 0 && (
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Sector del cliente
              <SelectorDeSector sectores={customer.sectors} value={sectorId} onChange={setSectorId} className="mt-1" />
              <span className="mt-1 block text-[12px] font-normal normal-case text-text-soft">
                El presupuesto se manda al teléfono y mail de este sector.
              </span>
            </label>
          )}

          <label className={labelClass}>
            Equipo (opcional)
            <select
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              disabled={!customer}
              className={cn(inputClass, 'bg-panel')}
            >
              <option value="">Sin equipo</option>
              {equipos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.kind === 'PIEZA' ? 'Pieza: ' : ''}
                  {[v.brand, v.model].filter(Boolean).join(' ')}
                  {v.licensePlate ? ` - ${v.licensePlate}` : v.referenceNumber ? ` - N° ${v.referenceNumber}` : ''}
                </option>
              ))}
            </select>
          </label>

          <label className={labelClass}>
            Válida hasta
            <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className={inputClass} />
          </label>

          <label className={cn(labelClass, 'sm:col-span-2')}>
            Trabajo a realizar
            <input
              value={component}
              onChange={(e) => setComponent(e.target.value)}
              className={inputClass}
              placeholder="Reparación de bomba inyectora, juego de toberas…"
            />
          </label>
        </div>
      </Panel>

      <Panel className="mb-6 p-5">
        <ItemsEditor items={items} onChange={setItems} articles={articles} editable />
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
          className={cn(inputClass, 'resize-y')}
          placeholder="Condiciones, plazos de entrega, lo que el cliente tiene que saber…"
        />
      </Panel>

      {fichaCliente && (
        <CustomerModal
          customer={null}
          onClose={() => setFichaCliente(false)}
          onSaved={(nuevo) => {
            setFichaCliente(false);
            setCustomers((actuales) => [...actuales, nuevo].sort((a, b) => a.name.localeCompare(b.name)));
            setCustomerId(nuevo.id);
          }}
        />
      )}
    </div>
  );
}
