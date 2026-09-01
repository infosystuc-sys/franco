import React from 'react';
import { Plus, X, Pencil, Trash2, Percent, Info } from 'lucide-react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  createTaxRate,
  deleteTaxRate,
  describeTaxRateError,
  EMPTY_TAX_RATE_FORM,
  fetchTaxRates,
  TAX_BASE_LABELS,
  TAX_KIND_HELP,
  TAX_KIND_LABELS,
  TAX_KINDS,
  taxRateToForm,
  updateTaxRate,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENTS,
  type TaxBase,
  type TaxKind,
  type TaxRate,
  type TaxRateInput,
  type VatTreatment,
} from '@/src/lib/taxRates';

/**
 * Padrón de alícuotas. Se agrupa por tipo y no en una sola tabla plana
 * porque cada tipo actúa en un lugar distinto del comprobante: el IVA por
 * renglón, las percepciones al pie, y las retenciones recién al pagar.
 * Mezclarlos sin separar invita a cargar una retención creyendo que va a
 * sumar en la factura.
 */
export function TaxRates() {
  const { role } = useAuth();
  const [searchParams] = useSearchParams();
  // Se llega filtrado desde Tesorería → Medios de pago (las retenciones no
  // son un medio de pago, pero es donde el taller las va a buscar primero).
  const kindFilter = searchParams.get('kind');
  const visibleKinds = kindFilter && TAX_KINDS.includes(kindFilter as TaxKind)
    ? [kindFilter as TaxKind]
    : TAX_KINDS;
  const [rates, setRates] = React.useState<TaxRate[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<TaxRate | null>(null);
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRates(await fetchTaxRates());
    } catch (err) {
      setError(describeTaxRateError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  async function handleDelete(rate: TaxRate) {
    if (!window.confirm(`¿Eliminar la alícuota "${rate.name}"?`)) return;
    setError(null);
    try {
      await deleteTaxRate(rate.id);
      load();
    } catch (err) {
      setError(describeTaxRateError(getErrorMessage(err)));
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={kindFilter ? TAX_KIND_LABELS[visibleKinds[0]] : 'Alícuotas'}
        subtitle={
          kindFilter
            ? TAX_KIND_HELP[visibleKinds[0]]
            : 'IVA, percepciones e impuestos que llegan en las facturas de compra.'
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Nueva alícuota
          </Button>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {loading && <p className="text-center text-text-soft">Cargando alícuotas…</p>}

      {!loading &&
        visibleKinds.map((kind) => {
          const ofKind = rates.filter((rate) => rate.kind === kind);
          return (
            <section key={kind}>
              <SectionHeader title={TAX_KIND_LABELS[kind]} />

              <p className="mb-3 flex items-start gap-1.5 text-xs text-text-soft">
                <Info size={13} className="mt-0.5 shrink-0 text-accent-deep" />
                {TAX_KIND_HELP[kind]}
              </p>

              <Panel className="overflow-x-auto overflow-y-hidden">
                <table className="table-stack w-full text-left text-[13px]">
                  <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                    <tr>
                      <th className="px-4 py-1">Nombre</th>
                      <th className="px-3 py-1 w-24 text-right">Alícuota</th>
                      <th className="px-3 py-1 w-32">
                        {kind === 'IVA' ? 'Tratamiento' : 'Se aplica sobre'}
                      </th>
                      <th className="px-3 py-1 w-40">Jurisdicción</th>
                      <th className="px-3 py-1 w-24"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ofKind.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-text-soft">
                          {kind === 'PERCEPCION'
                            ? 'Todavía no cargaste percepciones. Dependen de la provincia y del padrón de cada proveedor, así que no vienen precargadas: copialas de una factura que ya hayas recibido.'
                            : `No hay alícuotas de tipo ${TAX_KIND_LABELS[kind].toLowerCase()}.`}
                        </td>
                      </tr>
                    )}

                    {ofKind.map((rate) => (
                      <tr
                        key={rate.id}
                        className={cn(
                          'h-10 border-b border-line transition-colors last:border-b-0 hover:bg-panel-alt',
                          !rate.active && 'text-text-faint'
                        )}
                      >
                        <td data-primary className="px-4 py-1 font-semibold">
                          {rate.name}
                          {!rate.active && (
                            <span className="ml-2 bg-panel-head rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                              Inactiva
                            </span>
                          )}
                        </td>
                        <td data-label="Alícuota" className="px-3 py-1 text-right font-mono">
                          {rate.rate.toLocaleString('es-AR', { maximumFractionDigits: 3 })} %
                        </td>
                        <td data-label={kind === 'IVA' ? 'Tratamiento' : 'Base'} className="px-3 py-1 text-text-soft">
                          {rate.kind === 'IVA'
                            ? VAT_TREATMENT_LABELS[rate.vatTreatment ?? 'GRAVADO']
                            : TAX_BASE_LABELS[rate.base]}
                        </td>
                        <td data-label="Jurisdicción" className="px-3 py-1 text-text-soft">
                          {rate.jurisdiction ?? '—'}
                        </td>
                        <td className="px-3 py-1 text-right">
                          <button
                            onClick={() => setEditing(rate)}
                            aria-label={`Editar ${rate.name}`}
                            className="p-1 text-text-soft transition-colors hover:text-accent-deep"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(rate)}
                            aria-label={`Eliminar ${rate.name}`}
                            className="ml-1 p-1 text-text-soft transition-colors hover:text-danger"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            </section>
          );
        })}

      {(creating || editing) && (
        <TaxRateModal
          rate={editing}
          defaultKind={kindFilter && TAX_KINDS.includes(kindFilter as TaxKind) ? (kindFilter as TaxKind) : undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function TaxRateModal({
  rate,
  defaultKind,
  onClose,
  onSaved,
}: {
  rate: TaxRate | null;
  defaultKind?: TaxKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<TaxRateInput>(
    rate ? taxRateToForm(rate) : { ...EMPTY_TAX_RATE_FORM, kind: defaultKind ?? EMPTY_TAX_RATE_FORM.kind }
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<TaxRateInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  const isVat = form.kind === 'IVA';
  const rateNumber = Number(form.rate);
  const rateInvalid = form.rate.trim() === '' || !Number.isFinite(rateNumber) || rateNumber < 0 || rateNumber > 100;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre es obligatorio.');
      return;
    }
    if (rateInvalid) {
      setError('La alícuota tiene que ser un número entre 0 y 100.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (rate) await updateTaxRate(rate.id, form);
      else await createTaxRate(form);
      onSaved();
    } catch (err) {
      setError(describeTaxRateError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-bold text-text">
            {rate ? 'Editar alícuota' : 'Nueva alícuota'}
          </h2>
          <button onClick={onClose} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto p-5">
          {error && (
            <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
          )}

          <label className={labelClass}>
            Tipo
            <select
              value={form.kind}
              onChange={(e) => patch({ kind: e.target.value as TaxKind })}
              className={cn(inputClass, 'bg-panel')}
            >
              {TAX_KINDS.map((kind) => (
                <option key={kind} value={kind}>{TAX_KIND_LABELS[kind]}</option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
              {TAX_KIND_HELP[form.kind]}
            </span>
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Nombre *
              <input
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                className={cn(inputClass, form.name.trim() === '' && 'field-required')}
                placeholder={isVat ? 'IVA 21%' : 'Percepción IIBB Tucumán'}
              />
            </label>

            <label className={labelClass}>
              Alícuota %
              <div className="relative">
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  max="100"
                  value={form.rate}
                  onChange={(e) => patch({ rate: e.target.value })}
                  className={cn(inputClass, 'pr-7 font-mono', rateInvalid && 'border-danger bg-danger-soft')}
                  placeholder="2.5"
                />
                <Percent size={13} className="absolute right-2 top-1/2 mt-0.5 -translate-y-1/2 text-text-faint" />
              </div>
            </label>
          </div>

          {isVat ? (
            <label className={labelClass}>
              Tratamiento
              <select
                value={form.vatTreatment}
                onChange={(e) => patch({ vatTreatment: e.target.value as VatTreatment })}
                className={cn(inputClass, 'bg-panel')}
              >
                {VAT_TREATMENTS.map((treatment) => (
                  <option key={treatment} value={treatment}>{VAT_TREATMENT_LABELS[treatment]}</option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Exento y no gravado dan el mismo IVA cero, pero van a renglones
                distintos del pie de la factura.
              </span>
            </label>
          ) : (
            <label className={labelClass}>
              Se aplica sobre
              <select
                value={form.base}
                onChange={(e) => patch({ base: e.target.value as TaxBase })}
                className={cn(inputClass, 'bg-panel')}
              >
                <option value="NETO">{TAX_BASE_LABELS.NETO}</option>
                <option value="TOTAL">{TAX_BASE_LABELS.TOTAL}</option>
              </select>
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                Hay percepciones que se calculan sobre el neto y otras sobre el
                total con IVA. Mirá una factura del proveedor para saber cuál es.
              </span>
            </label>
          )}

          <label className={labelClass}>
            Jurisdicción
            <input
              value={form.jurisdiction}
              onChange={(e) => patch({ jurisdiction: e.target.value })}
              className={inputClass}
              placeholder="Tucumán"
            />
            <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
              Para las de Ingresos Brutos, que son provinciales. Opcional.
            </span>
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => patch({ active: e.target.checked })}
              className="h-4 w-4 accent-accent-deep"
            />
            Activa (se ofrece al cargar comprobantes)
          </label>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
