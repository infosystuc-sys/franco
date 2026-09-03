import React from 'react';
import { Save, Receipt, Building2, Check, AlertTriangle, Mail, Warehouse } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass, sectionTitleClass } from '@/src/components/FiscalFields';
import { isValidCuit, TAX_CONDITION_LABELS, TAX_CONDITIONS, type TaxCondition } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { describeInvoiceError, invoiceTypeFor, INVOICE_TYPE_LABELS } from '@/src/lib/invoices';
import { hasGmailCredential, setGmailCredential } from '@/src/lib/invoiceSending';
import {
  companySettingsToForm,
  fetchCompanySettings,
  updateCompanySettings,
  type CompanySettingsInput,
} from '@/src/lib/companySettings';
import { fetchYardCapacities, updateYardCapacity, type YardCapacityRow } from '@/src/lib/yardCapacity';
import { SIZE_CLASS_LABELS } from '@/src/lib/vehicles';

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
  yardPickupGraceDays: '2',
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

  const [gmailConfigured, setGmailConfigured] = React.useState(false);
  const [gmailPassword, setGmailPassword] = React.useState('');
  const [gmailSaving, setGmailSaving] = React.useState(false);
  const [gmailSaved, setGmailSaved] = React.useState(false);
  const [gmailError, setGmailError] = React.useState<string | null>(null);

  const [cupos, setCupos] = React.useState<YardCapacityRow[]>([]);
  const [cupoError, setCupoError] = React.useState<string | null>(null);
  const guardadoPendiente = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  React.useEffect(() => {
    let cancelled = false;
    fetchCompanySettings()
      .then((settings) => {
        if (cancelled) return;
        if (settings) setForm(companySettingsToForm(settings));
      })
      .catch((err) => !cancelled && setError(describeInvoiceError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));
    hasGmailCredential()
      .then((value) => !cancelled && setGmailConfigured(value))
      .catch(() => {/* si falla la lectura del estado, se sigue viendo como "sin configurar" */});
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    fetchYardCapacities()
      .then(setCupos)
      .catch((err) => setCupoError(`No se pudo leer el cupo de la playa: ${getErrorMessage(err)}`));
  }, []);

  // Los timers de guardado quedan referenciados fuera del render (un ref, no
  // estado) porque no tienen que disparar un re-render propio: solo importan
  // cuando se cancelan, al tipear de nuevo o al desmontar la pantalla.
  React.useEffect(() => {
    const timers = guardadoPendiente.current;
    return () => { for (const t of Object.values(timers)) clearTimeout(t); };
  }, []);

  /**
   * El input no se bloquea mientras guarda: deshabilitarlo hacía que se
   * perdiera la segunda tecla de un número de dos cifras, y el cupo quedaba
   * en "2" cuando el usuario había escrito "25". Se escribe con un respiro
   * después de la última tecla, y un campo vacío no persiste nada — vaciarlo
   * para reescribirlo no tiene por qué dejar el cupo en cero.
   */
  function handleCupoChange(sizeClass: YardCapacityRow['sizeClass'], value: string) {
    const capacity = Math.max(0, Math.trunc(Number(value)) || 0);
    setCupos((previos) => previos.map((c) => (c.sizeClass === sizeClass ? { ...c, capacity } : c)));

    clearTimeout(guardadoPendiente.current[sizeClass]);
    if (value.trim() === '') return;

    guardadoPendiente.current[sizeClass] = setTimeout(async () => {
      try {
        await updateYardCapacity(sizeClass, capacity);
        setCupoError(null);
      } catch (err) {
        setCupoError(`No se pudo guardar el cupo de ${SIZE_CLASS_LABELS[sizeClass].toLowerCase()}: ${getErrorMessage(err)}`);
      }
    }, 600);
  }

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

  async function handleSaveGmail() {
    if (!gmailPassword.trim()) return;
    setGmailSaving(true);
    setGmailError(null);
    try {
      await setGmailCredential(gmailPassword.trim());
      setGmailPassword('');
      setGmailConfigured(true);
      setGmailSaved(true);
    } catch (err) {
      setGmailError(getErrorMessage(err));
    } finally {
      setGmailSaving(false);
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
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {form.legalName.trim() === '' && (
        <div className="flex items-start gap-2 rounded-md border border-accent bg-accent/10 px-4 py-3 text-sm text-text">
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

      <Panel className="space-y-4 p-5">
        <h3 className={sectionTitleClass}><Mail size={14} /> Envío de facturas por mail</h3>
        <p className="text-xs text-text-soft">
          Para mandar facturas por mail hace falta una contraseña de aplicación de la
          cuenta de Gmail de arriba ({form.email || 'sin mail cargado'}). Se guarda cifrada:
          una vez cargada no se puede volver a ver, solo reemplazar.
        </p>

        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.06em]">
          {gmailConfigured ? (
            <span className="inline-flex items-center gap-1.5 text-state-ok"><Check size={14} /> Credencial cargada</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-text-soft"><AlertTriangle size={14} /> Sin configurar</span>
          )}
        </div>

        {gmailError && (
          <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{gmailError}</div>
        )}

        <div className="flex flex-col gap-2 sm:max-w-sm">
          <label className={labelClass}>
            {gmailConfigured ? 'Reemplazar contraseña de aplicación' : 'Contraseña de aplicación'}
            <input
              type="password"
              value={gmailPassword}
              onChange={(e) => {
                setGmailPassword(e.target.value);
                setGmailSaved(false);
              }}
              className={inputClass}
              placeholder="xxxx xxxx xxxx xxxx"
              autoComplete="off"
            />
          </label>
          <Button
            type="button"
            variant="secondary"
            onClick={handleSaveGmail}
            disabled={gmailSaving || !gmailPassword.trim()}
          >
            {gmailSaved && !gmailSaving ? <Check size={16} /> : <Save size={16} />}
            {gmailSaving ? 'Guardando…' : gmailSaved ? 'Guardada' : 'Guardar credencial'}
          </Button>
        </div>
      </Panel>

      <Panel className="space-y-4 p-5">
        <h3 className={sectionTitleClass}><Warehouse size={14} /> Capacidad de la playa</h3>
        <p className="text-xs text-text-soft">
          Cuántos vehículos de cada tamaño entran en la playa. En cero, la pantalla de
          disponibilidad avisa que el cupo todavía no está configurado.
        </p>
        {cupoError && (
          <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{cupoError}</div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {cupos.map((cupo) => (
            <label key={cupo.sizeClass} className={labelClass}>
              {SIZE_CLASS_LABELS[cupo.sizeClass]}
              <input
                type="number"
                min={0}
                value={cupo.capacity}
                onChange={(e) => handleCupoChange(cupo.sizeClass, e.target.value)}
                className={inputClass}
              />
            </label>
          ))}
        </div>
        <label className={labelClass}>
          Días de margen para el retiro
          <input
            type="number"
            min={0}
            value={form.yardPickupGraceDays}
            onChange={(e) => patch({ yardPickupGraceDays: e.target.value })}
            className={inputClass}
          />
          <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
            Cuántos días después de la fecha estimada de finalización se asume que el
            cliente pasa a buscar el vehículo. Se usa solo para proyectar.
          </span>
        </label>
      </Panel>
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
