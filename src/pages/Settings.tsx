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
import { fetchYardCells, updateYardCells } from '@/src/lib/yardCapacity';

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

  const [gmailConfigured, setGmailConfigured] = React.useState(false);
  const [gmailPassword, setGmailPassword] = React.useState('');
  const [gmailSaving, setGmailSaving] = React.useState(false);
  const [gmailSaved, setGmailSaved] = React.useState(false);
  const [gmailError, setGmailError] = React.useState<string | null>(null);

  const [celdas, setCeldas] = React.useState(0);
  const [cupoError, setCupoError] = React.useState<string | null>(null);
  const guardadoPendiente = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // El último valor tipeado que todavía no se guardó. No alcanza con el timer:
  // si hay que volcarlo (al desmontar o al perder el foco) hace falta saber
  // CUÁL era el valor pendiente, no solo que había uno.
  const valorPendiente = React.useRef<number | undefined>(undefined);

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
    fetchYardCells()
      .then(setCeldas)
      .catch((err) => setCupoError(`No se pudo leer la cantidad de celdas: ${getErrorMessage(err)}`));
  }, []);

  // El timer vive fuera del render (un ref, no estado) porque no tiene que
  // disparar un re-render propio: solo importa para cancelarlo, al tipear de
  // nuevo o al desmontar la pantalla.
  //
  // Al desmontar, el guardado pendiente se DISPARA en vez de cancelarse: esta
  // pantalla define el número del que depende toda la disponibilidad de la
  // playa, y cancelar en silencio dejaba a la base con el valor viejo aunque el
  // usuario ya hubiera visto el nuevo en el input. No hay estado de error que
  // mostrar en un componente que ya se está yendo, así que este guardado final
  // no pasa por setCupoError: si falla se pierde, pero el caso comun (clic a
  // otro lado antes de los 600ms) ya no falla.
  React.useEffect(() => {
    return () => {
      if (guardadoPendiente.current !== undefined) clearTimeout(guardadoPendiente.current);
      if (valorPendiente.current !== undefined) {
        updateYardCells(valorPendiente.current).catch(() => {});
      }
    };
  }, []);

  async function guardarCeldas(cantidad: number) {
    valorPendiente.current = undefined;
    try {
      await updateYardCells(cantidad);
      setCupoError(null);
    } catch (err) {
      setCupoError(`No se pudo guardar la cantidad de celdas: ${getErrorMessage(err)}`);
    }
  }

  /**
   * El input no se bloquea mientras guarda: deshabilitarlo hacía que se
   * perdiera la segunda tecla de un número de dos cifras, y quedaba "2" cuando
   * el usuario había escrito "25". Se escribe con un respiro después de la
   * última tecla, y un campo vacío no persiste nada — vaciarlo para
   * reescribirlo no tiene por qué dejar la playa en cero.
   */
  function handleCeldasChange(value: string) {
    const cantidad = Math.max(0, Math.trunc(Number(value)) || 0);
    setCeldas(cantidad);

    clearTimeout(guardadoPendiente.current);
    if (value.trim() === '') {
      valorPendiente.current = undefined;
      return;
    }

    valorPendiente.current = cantidad;
    guardadoPendiente.current = setTimeout(() => guardarCeldas(cantidad), 600);
  }

  /**
   * El caso común de "escribo y hago clic en otro lado" antes de que venza el
   * respiro: sin esto, ese clic caía igual de mal que un desmontaje.
   */
  function handleCeldasBlur() {
    if (valorPendiente.current === undefined) return;
    clearTimeout(guardadoPendiente.current);
    guardarCeldas(valorPendiente.current);
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
          Cuántas celdas tiene el taller. En cada celda entra un vehículo grande o
          hasta tres medianos. En cero, la pantalla de disponibilidad avisa que
          todavía no está configurada.
        </p>
        {cupoError && (
          <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{cupoError}</div>
        )}
        <label className={cn(labelClass, 'sm:max-w-xs')}>
          Celdas del taller
          <input
            type="number"
            min={0}
            value={celdas}
            onChange={(e) => handleCeldasChange(e.target.value)}
            onBlur={handleCeldasBlur}
            className={inputClass}
          />
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
