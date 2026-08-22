import React from 'react';
import { Save, Receipt, Building2, Check, AlertTriangle } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass, sectionTitleClass } from '@/src/components/FiscalFields';
import { isValidCuit, TAX_CONDITION_LABELS, TAX_CONDITIONS, type TaxCondition } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { describeInvoiceError, invoiceTypeFor, INVOICE_TYPE_LABELS } from '@/src/lib/invoices';
import {
  companySettingsToForm,
  fetchCompanySettings,
  updateCompanySettings,
  type CompanySettingsInput,
} from '@/src/lib/companySettings';

const EMPTY_FORM: CompanySettingsInput = {
  legalName: '',
  tradeName: '',
  taxId: '',
  taxCondition: 'RESPONSABLE_INSCRIPTO',
  salesPoint: '1',
  grossIncome: '',
  activityStartDate: '',
  addressStreet: '',
  addressCity: '',
  addressState: '',
  addressZip: '',
  phone: '',
  email: '',
};

/**
 * Datos fiscales del taller. Son los que encabezan cada factura y los que
 * definen la letra del comprobante, así que esta pantalla es requisito para
 * poder facturar.
 */
export function Settings() {
  const { role } = useAuth();
  const [form, setForm] = React.useState<CompanySettingsInput>(EMPTY_FORM);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchCompanySettings()
      .then((settings) => {
        if (cancelled) return;
        if (settings) setForm(companySettingsToForm(settings));
      })
      .catch((err) => !cancelled && setError(describeInvoiceError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (role !== 'admin') return <Navigate to="/" replace />;

  function patch(changes: Partial<CompanySettingsInput>) {
    setForm((current) => ({ ...current, ...changes }));
    setSaved(false);
  }

  const cuitInvalid = form.taxId.trim() !== '' && !isValidCuit(form.taxId);
  const salesPointNumber = Number(form.salesPoint);
  const salesPointInvalid =
    !Number.isInteger(salesPointNumber) || salesPointNumber < 1 || salesPointNumber > 99999;
  const canSave = form.legalName.trim() !== '' && !cuitInvalid && !salesPointInvalid;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCompanySettings(form);
      setForm(companySettingsToForm(updated));
      setSaved(true);
    } catch (err) {
      setError(describeInvoiceError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">Cargando configuración…</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Configuración"
        subtitle="Los datos fiscales del taller. Encabezan cada factura y definen la letra del comprobante."
        actions={
          <Button onClick={handleSave} disabled={saving || !canSave}>
            {saved && !saving ? <Check size={16} /> : <Save size={16} />}
            {saving ? 'Guardando…' : saved ? 'Guardado' : 'Guardar'}
          </Button>
        }
      />

      {error && (
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {form.legalName.trim() === '' && (
        <div className="flex items-start gap-2 border border-accent bg-accent/10 px-4 py-3 text-sm text-text">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent-deep" />
          <span>
            Todavía no cargaste la razón social. Sin ella no se puede emitir ninguna factura.
          </span>
        </div>
      )}

      <Panel className="space-y-4 p-5">
        <h3 className={sectionTitleClass}><Building2 size={14} /> Identificación</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={cn(labelClass, 'sm:col-span-2')}>
            Razón social *
            <input
              value={form.legalName}
              onChange={(e) => patch({ legalName: e.target.value })}
              className={cn(inputClass, form.legalName.trim() === '' && 'field-required')}
              placeholder="Ludiesel S.R.L."
            />
          </label>
          <label className={cn(labelClass, 'sm:col-span-2')}>
            Nombre de fantasía
            <input
              value={form.tradeName}
              onChange={(e) => patch({ tradeName: e.target.value })}
              className={inputClass}
              placeholder="Ludiesel — Inyección Diesel"
            />
          </label>
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <h3 className={sectionTitleClass}><Receipt size={14} /> Datos fiscales</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              CUIT
              <input
                value={form.taxId}
                onChange={(e) => patch({ taxId: e.target.value })}
                className={cn(inputClass, 'font-mono', cuitInvalid && 'border-danger bg-danger-soft')}
                placeholder="30-71044366-8"
              />
              {cuitInvalid && (
                <span className="mt-1 block text-[10px] font-normal normal-case text-danger">
                  CUIT inválido (dígito verificador incorrecto).
                </span>
              )}
            </label>

            <label className={labelClass}>
              Condición frente al IVA
              <select
                value={form.taxCondition}
                onChange={(e) => patch({ taxCondition: e.target.value as TaxCondition })}
                className={cn(inputClass, 'bg-panel')}
              >
                {TAX_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>{TAX_CONDITION_LABELS[condition]}</option>
                ))}
              </select>
            </label>

            <label className={labelClass}>
              Punto de venta
              <input
                type="number"
                min="1"
                max="99999"
                value={form.salesPoint}
                onChange={(e) => patch({ salesPoint: e.target.value })}
                className={cn(inputClass, 'font-mono', salesPointInvalid && 'border-danger bg-danger-soft')}
                placeholder="1"
              />
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                {salesPointInvalid
                  ? 'Tiene que ser un número entre 1 y 99999.'
                  : `Las facturas se numeran ${String(salesPointNumber).padStart(4, '0')}-00000001.`}
              </span>
            </label>

            <label className={labelClass}>
              Ingresos Brutos
              <input
                value={form.grossIncome}
                onChange={(e) => patch({ grossIncome: e.target.value })}
                className={inputClass}
                placeholder="901-123456-7"
              />
            </label>

            <label className={labelClass}>
              Inicio de actividades
              <input
                type="date"
                value={form.activityStartDate}
                onChange={(e) => patch({ activityStartDate: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>

          <ComprobanteMatrix issuerCondition={form.taxCondition} />
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <h3 className={sectionTitleClass}>Domicilio comercial</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
            <label className={cn(labelClass, 'sm:col-span-4')}>
              Calle y número
              <input
                value={form.addressStreet}
                onChange={(e) => patch({ addressStreet: e.target.value })}
                className={inputClass}
                placeholder="Av. Siempreviva 742"
              />
            </label>
            <label className={cn(labelClass, 'sm:col-span-2')}>
              Código postal
              <input
                value={form.addressZip}
                onChange={(e) => patch({ addressZip: e.target.value })}
                className={inputClass}
                placeholder="B1636"
              />
            </label>
            <label className={cn(labelClass, 'sm:col-span-3')}>
              Localidad
              <input
                value={form.addressCity}
                onChange={(e) => patch({ addressCity: e.target.value })}
                className={inputClass}
                placeholder="Olivos"
              />
            </label>
            <label className={cn(labelClass, 'sm:col-span-3')}>
              Provincia
              <input
                value={form.addressState}
                onChange={(e) => patch({ addressState: e.target.value })}
                className={inputClass}
                placeholder="Buenos Aires"
              />
            </label>
          </div>
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <h3 className={sectionTitleClass}>Contacto</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Email
              <input
                type="email"
                value={form.email}
                onChange={(e) => patch({ email: e.target.value })}
                className={inputClass}
                placeholder="administracion@ludiesel.com"
              />
            </label>
            <label className={labelClass}>
              Teléfono
              <input
                value={form.phone}
                onChange={(e) => patch({ phone: e.target.value })}
                className={inputClass}
                placeholder="+54 9 11 5555-0001"
              />
            </label>
          </div>
        </div>
      </Panel>

      <p className="text-xs text-text-soft">
        Estos datos se copian dentro de cada factura al emitirla. Cambiarlos acá
        no altera los comprobantes ya emitidos.
      </p>
    </div>
  );
}

/**
 * Qué comprobante le va a salir a cada tipo de cliente con la condición
 * elegida. Cambiar la condición del taller cambia toda la facturación futura,
 * así que conviene verlo antes de guardar y no en la primera factura.
 */
function ComprobanteMatrix({ issuerCondition }: { issuerCondition: TaxCondition }) {
  return (
    <div className="border border-line bg-panel-alt p-3">
      <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
        Con esta condición, a cada cliente le sale
      </span>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {TAX_CONDITIONS.map((customerCondition) => {
          const type = invoiceTypeFor(issuerCondition, customerCondition);
          return (
            <li key={customerCondition} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-text-soft">{TAX_CONDITION_LABELS[customerCondition]}</span>
              <span className="font-semibold text-text">{INVOICE_TYPE_LABELS[type]}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
