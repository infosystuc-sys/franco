import React from 'react';
import { Save, Receipt, Building2, Check, AlertTriangle, Mail, Warehouse, Sparkles, Trash2, Landmark, Upload, Activity } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { labelClass, inputClass, sectionTitleClass } from '@/src/components/FiscalFields';
import { isValidCuit, TAX_CONDITION_LABELS, TAX_CONDITIONS, type TaxCondition } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  describeInvoiceError,
  fetchNumeracion,
  fijarProximoNumero,
  invoiceTypeFor,
  INVOICE_TYPE_LABELS,
  type SerieNumeracion,
} from '@/src/lib/invoices';
import { hasGmailCredential, setGmailCredential } from '@/src/lib/invoiceSending';
import {
  companySettingsToForm,
  fetchCompanySettings,
  updateCompanySettings,
  type CompanySettingsInput,
} from '@/src/lib/companySettings';
import { fetchYardCells, updateYardCells } from '@/src/lib/yardCapacity';
import { diagnosticoFacturacion, type DiagnosticoArca } from '@/src/lib/arcaFacturacion';
import {
  borrarCertificado,
  cuitDelCertificado,
  fetchEstadoCertificados,
  guardarCertificado,
  PROPOSITO_AYUDA,
  PROPOSITO_LABELS,
  type EstadoCertificado,
  type PropositoArca,
} from '@/src/lib/arcaPadron';
import {
  AI_PROVIDER_CONSOLES,
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  deleteAiKey,
  fetchAiKeyStatus,
  fetchAiProvider,
  saveAiKey,
  saveAiProvider,
  type AiKeyStatus,
  type AiProvider,
} from '@/src/lib/aiCredentials';

const EMPTY_FORM: CompanySettingsInput = {
  legalName: '',
  tradeName: '',
  taxId: '',
  taxCondition: 'RESPONSABLE_INSCRIPTO',
  salesPoint: '1',
  salesPointInternal: '90000',
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

  // Lectura de comprobantes con IA. La clave no se puede traer: solo se sabe
  // si está cargada y sus últimos cuatro caracteres.
  const [aiProvider, setAiProvider] = React.useState<AiProvider>('GEMINI');
  const [aiKeys, setAiKeys] = React.useState<AiKeyStatus[]>([]);
  const [aiNuevaClave, setAiNuevaClave] = React.useState<Record<string, string>>({});
  const [aiGuardando, setAiGuardando] = React.useState<string | null>(null);
  const [aiError, setAiError] = React.useState<string | null>(null);
  const [aiAviso, setAiAviso] = React.useState<string | null>(null);

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

  const cargarEstadoIA = React.useCallback(async () => {
    const [proveedor, claves] = await Promise.all([fetchAiProvider(), fetchAiKeyStatus()]);
    setAiProvider(proveedor);
    setAiKeys(claves);
  }, []);

  React.useEffect(() => {
    cargarEstadoIA().catch((err) =>
      setAiError(`No se pudo leer la configuración de lectura: ${getErrorMessage(err)}`)
    );
  }, [cargarEstadoIA]);

  async function handleAiProvider(proveedor: AiProvider) {
    setAiError(null);
    setAiAviso(null);
    const anterior = aiProvider;
    setAiProvider(proveedor); // optimista: el selector no debe quedar trabado
    try {
      await saveAiProvider(proveedor);
      setAiAviso(`Los comprobantes se van a leer con ${AI_PROVIDER_LABELS[proveedor]}.`);
    } catch (err) {
      setAiProvider(anterior);
      setAiError(getErrorMessage(err));
    }
  }

  async function handleGuardarClaveIA(proveedor: AiProvider) {
    const clave = (aiNuevaClave[proveedor] ?? '').trim();
    if (!clave) return;
    setAiGuardando(proveedor);
    setAiError(null);
    setAiAviso(null);
    try {
      await saveAiKey(proveedor, clave);
      setAiNuevaClave((actuales) => ({ ...actuales, [proveedor]: '' }));
      await cargarEstadoIA();
      setAiAviso(`Clave de ${AI_PROVIDER_LABELS[proveedor]} guardada.`);
    } catch (err) {
      setAiError(getErrorMessage(err));
    } finally {
      setAiGuardando(null);
    }
  }

  async function handleBorrarClaveIA(proveedor: AiProvider) {
    if (!window.confirm(`¿Sacar la clave de ${AI_PROVIDER_LABELS[proveedor]}? Los comprobantes dejan de poder leerse con ese proveedor.`)) {
      return;
    }
    setAiGuardando(proveedor);
    setAiError(null);
    setAiAviso(null);
    try {
      await deleteAiKey(proveedor);
      await cargarEstadoIA();
      setAiAviso(`Clave de ${AI_PROVIDER_LABELS[proveedor]} eliminada.`);
    } catch (err) {
      setAiError(getErrorMessage(err));
    } finally {
      setAiGuardando(null);
    }
  }

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
  const internalPointNumber = Number(form.salesPointInternal);
  const internalPointInvalid =
    !Number.isInteger(internalPointNumber) || internalPointNumber < 1 || internalPointNumber > 99999;
  // Compartir punto de venta haría convivir dos comprobantes distintos con el
  // mismo número, que es lo que después nadie puede desenredar.
  const pointsCollide = !salesPointInvalid && !internalPointInvalid && salesPointNumber === internalPointNumber;
  const canSave =
    form.legalName.trim() !== '' && !cuitInvalid && !salesPointInvalid &&
    !internalPointInvalid && !pointsCollide;

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
                <span className="mt-1 block text-[12px] font-normal normal-case text-danger">
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
              Punto de venta — electrónica
              <input
                type="number"
                min="1"
                max="99999"
                value={form.salesPoint}
                onChange={(e) => patch({ salesPoint: e.target.value })}
                className={cn(inputClass, 'font-mono', salesPointInvalid && 'border-danger bg-danger-soft')}
                placeholder="1"
              />
              <span className="mt-1 block text-[12px] font-normal normal-case text-text-soft">
                {salesPointInvalid
                  ? 'Tiene que ser un número entre 1 y 99999.'
                  : `El habilitado en ARCA. Numera ${String(salesPointNumber).padStart(4, '0')}-00000001.`}
              </span>
            </label>

            <label className={labelClass}>
              Punto de venta — interna (X)
              <input
                type="number"
                min="1"
                max="99999"
                value={form.salesPointInternal}
                onChange={(e) => patch({ salesPointInternal: e.target.value })}
                className={cn(
                  inputClass,
                  'font-mono',
                  (internalPointInvalid || pointsCollide) && 'border-danger bg-danger-soft'
                )}
                placeholder="90000"
              />
              <span className="mt-1 block text-[12px] font-normal normal-case text-text-soft">
                {internalPointInvalid
                  ? 'Tiene que ser un número entre 1 y 99999.'
                  : pointsCollide
                    ? 'Tiene que ser distinto del de la electrónica: si no, dos comprobantes llevarían el mismo número.'
                    : `Sin validez fiscal. Numera ${String(internalPointNumber).padStart(4, '0')}-00000001.`}
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

      <NumeracionFacturas />

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
        <h3 className={sectionTitleClass}><Sparkles size={14} /> Lectura de comprobantes con IA</h3>
        <p className="text-xs text-text-soft">
          Con qué servicio se leen las facturas de compra que se suben en Compras con IA.
          Si el elegido está saturado y el otro tiene clave cargada, la lectura se
          resuelve con ese y el comprobante queda marcado con cuál se leyó.
        </p>
        <p className="text-xs text-text-soft">
          {/* Sin esta aclaración, ver "sin clave" en Gemini hace pensar que la
              lectura está rota, cuando en realidad sigue andando con el
              secreto que ya estaba puesto en el servidor. */}
          Sin clave cargada acá, se usa la que esté configurada en el servidor. Cargar
          una en esta pantalla la reemplaza.
        </p>

        {aiError && (
          <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{aiError}</div>
        )}
        {aiAviso && !aiError && (
          <div className="border border-line-strong bg-panel-alt px-3 py-2 text-xs text-text">{aiAviso}</div>
        )}

        <label className={cn(labelClass, 'block sm:max-w-sm')}>
          Servicio a usar
          <select
            value={aiProvider}
            onChange={(e) => handleAiProvider(e.target.value as AiProvider)}
            className={cn(inputClass, 'bg-panel')}
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p} value={p}>{AI_PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {AI_PROVIDERS.map((proveedor) => {
            const estado = aiKeys.find((k) => k.provider === proveedor);
            const cargada = estado?.configurada ?? false;
            return (
              <div key={proveedor} className="border border-line bg-panel-alt p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-[0.06em] text-text">
                    {AI_PROVIDER_LABELS[proveedor]}
                  </span>
                  {cargada ? (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-state-ok">
                      <Check size={13} /> Cargada ····{estado?.ultimos4}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                      <AlertTriangle size={13} /> Sin clave
                    </span>
                  )}
                </div>

                <label className={cn(labelClass, 'mt-3 block')}>
                  {cargada ? 'Reemplazar clave' : 'Clave de API'}
                  <input
                    type="password"
                    value={aiNuevaClave[proveedor] ?? ''}
                    onChange={(e) =>
                      setAiNuevaClave((actuales) => ({ ...actuales, [proveedor]: e.target.value }))
                    }
                    className={cn(inputClass, 'font-mono')}
                    placeholder={proveedor === 'ANTHROPIC' ? 'sk-ant-…' : 'AIza…'}
                    autoComplete="off"
                  />
                  <span className="mt-1 block text-[12px] font-normal normal-case text-text-soft">
                    Se saca de {AI_PROVIDER_CONSOLES[proveedor]}. Una vez guardada no se
                    puede volver a ver, solo reemplazar.
                  </span>
                </label>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={aiGuardando === proveedor || !(aiNuevaClave[proveedor] ?? '').trim()}
                    onClick={() => handleGuardarClaveIA(proveedor)}
                  >
                    <Save size={16} /> {aiGuardando === proveedor ? 'Guardando…' : 'Guardar clave'}
                  </Button>
                  {cargada && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={aiGuardando === proveedor}
                      onClick={() => handleBorrarClaveIA(proveedor)}
                    >
                      <Trash2 size={16} /> Sacar
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <CertificadosArca />

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
      <span className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">
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

/**
 * Los certificados de ARCA.
 *
 * Se cargan los archivos tal cual se bajaron: el .crt y el .key. Van derecho a
 * una tabla que solo el servidor lee —ni siquiera un admin puede recuperarlos
 * desde acá— y de ahí los toma la función que consulta el padrón.
 *
 * Son dos y hacen cosas distintas: uno consulta datos de terceros y puede ser
 * de cualquier CUIT, el otro factura y tiene que ser del CUIT que emite.
 */
/**
 * Desde qué número sigue cada serie.
 *
 * Hace falta al migrar desde otro sistema, o cuando ARCA ya tiene consumidos
 * números que acá no están. Solo aparecen las series que ya emitieron algo: la
 * primera factura de una serie nueva arranca en 1 sola, sin configurar nada.
 */
function NumeracionFacturas() {
  const [series, setSeries] = React.useState<SerieNumeracion[]>([]);
  const [cargando, setCargando] = React.useState(true);
  const [editando, setEditando] = React.useState<string | null>(null);
  const [valor, setValor] = React.useState('');
  const [guardando, setGuardando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    setCargando(true);
    try {
      setSeries(await fetchNumeracion());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCargando(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  const claveDe = (s: SerieNumeracion) => `${s.invoiceType}-${s.salesPoint}`;

  async function guardar(s: SerieNumeracion) {
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < 1) {
      setError('El próximo número tiene que ser un entero de 1 o más.');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      await fijarProximoNumero(s.invoiceType, s.salesPoint, numero);
      setEditando(null);
      await cargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Panel className="space-y-4 p-5">
      <h3 className={sectionTitleClass}><Receipt size={14} /> Numeración de facturas</h3>
      <p className="text-xs text-text-soft">
        El número que va a salir en la próxima factura de cada serie. Se toca
        para retomar una numeración existente; no se puede volver atrás por
        debajo de lo ya emitido.
      </p>

      {error && (
        <p className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>
      )}

      {cargando ? (
        <p className="text-xs text-text-soft">Leyendo…</p>
      ) : series.length === 0 ? (
        <p className="text-xs text-text-soft">
          Todavía no se emitió ninguna factura: cada serie va a arrancar en 00000001.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="py-1.5">Comprobante</th>
              <th className="py-1.5">Pto. vta.</th>
              <th className="py-1.5 text-right">Emitidas</th>
              <th className="py-1.5 text-right">Próximo número</th>
              <th className="w-24 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => {
              const clave = claveDe(s);
              const enEdicion = editando === clave;
              return (
                <tr key={clave} className="border-b border-line">
                  <td className="py-1.5">{INVOICE_TYPE_LABELS[s.invoiceType]}</td>
                  <td className="py-1.5 font-mono">
                    {String(s.salesPoint).padStart(4, '0')}
                  </td>
                  <td className="py-1.5 text-right">{s.emitidas}</td>
                  <td className="py-1.5 text-right font-mono">
                    {enEdicion ? (
                      <input
                        type="number"
                        min="1"
                        autoFocus
                        value={valor}
                        onChange={(e) => setValor(e.target.value)}
                        className="w-32 border border-line bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none"
                      />
                    ) : (
                      String(s.nextNumber).padStart(8, '0')
                    )}
                  </td>
                  <td className="py-1.5 text-right">
                    {enEdicion ? (
                      <span className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={guardando}
                          onClick={() => guardar(s)}
                          className="text-[12px] font-semibold uppercase tracking-wider text-accent-deep hover:underline disabled:opacity-60"
                        >
                          {guardando ? '…' : 'Guardar'}
                        </button>
                        <button
                          type="button"
                          disabled={guardando}
                          onClick={() => { setEditando(null); setError(null); }}
                          className="text-[12px] font-semibold uppercase tracking-wider text-text-soft hover:underline"
                        >
                          Cancelar
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditando(clave);
                          setValor(String(s.nextNumber));
                          setError(null);
                        }}
                        className="text-[12px] font-semibold uppercase tracking-wider text-text-soft hover:text-accent-deep"
                      >
                        Cambiar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function CertificadosArca() {
  const [estados, setEstados] = React.useState<EstadoCertificado[]>([]);
  const [cargando, setCargando] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);
  const [guardando, setGuardando] = React.useState<PropositoArca | null>(null);
  // Lo que se leyó de los archivos elegidos, por propósito. Vive en memoria y
  // se descarta al guardar: no hay razón para tener una clave privada dando
  // vueltas en la pantalla más tiempo del que dura el clic.
  const [pendientes, setPendientes] = React.useState<
    Partial<Record<PropositoArca, { cert?: string; key?: string; cuit?: string | null }>>
  >({});

  const cargar = React.useCallback(async () => {
    setCargando(true);
    try {
      setEstados(await fetchEstadoCertificados());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCargando(false);
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  async function handleArchivo(proposito: PropositoArca, tipo: 'cert' | 'key', file: File | null) {
    if (!file) return;
    setError(null);
    setAviso(null);
    const texto = await file.text();
    setPendientes((actuales) => ({
      ...actuales,
      [proposito]: {
        ...actuales[proposito],
        [tipo]: texto,
        // El CUIT sale del propio certificado: escribirlo a mano es una
        // oportunidad más de equivocarse, y uno que no coincide hace que ARCA
        // rechace todas las consultas sin explicar por qué.
        ...(tipo === 'cert' ? { cuit: cuitDelCertificado(texto) } : {}),
      },
    }));
  }

  async function handleGuardar(proposito: PropositoArca) {
    const pendiente = pendientes[proposito];
    if (!pendiente?.cert || !pendiente?.key) return;
    if (!pendiente.cuit) {
      setError('No se pudo leer el CUIT del certificado. ¿Es el .crt que bajaste de ARCA?');
      return;
    }
    setGuardando(proposito);
    setError(null);
    setAviso(null);
    try {
      await guardarCertificado(proposito, pendiente.cuit, pendiente.cert, pendiente.key);
      setPendientes((actuales) => ({ ...actuales, [proposito]: undefined }));
      setAviso(`Certificado de ${PROPOSITO_LABELS[proposito].toLowerCase()} guardado.`);
      await cargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGuardando(null);
    }
  }

  async function handleBorrar(proposito: PropositoArca) {
    if (!window.confirm(`¿Sacar el certificado de ${PROPOSITO_LABELS[proposito].toLowerCase()}?`)) return;
    setGuardando(proposito);
    try {
      await borrarCertificado(proposito);
      setAviso('Certificado sacado.');
      await cargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGuardando(null);
    }
  }

  return (
    <Panel className="space-y-4 p-5">
      <h3 className={sectionTitleClass}><Landmark size={14} /> Certificados de ARCA</h3>
      <p className="text-xs text-text-soft">
        Los archivos que ARCA entrega al generar un certificado digital: el .crt y la
        clave .key. Quedan guardados de manera que solo el servidor puede leerlos; ni
        esta pantalla ni nadie con sesión los recupera después.
      </p>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
      )}
      {aviso && !error && (
        <div className="rounded-md border border-line-strong bg-panel-alt px-3 py-2 text-xs text-text">{aviso}</div>
      )}

      {cargando ? (
        <p className="text-xs text-text-soft">Cargando…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(['PADRON', 'FACTURACION'] as PropositoArca[]).map((proposito) => {
            const estado = estados.find((e) => e.proposito === proposito);
            const pendiente = pendientes[proposito];
            const listo = Boolean(pendiente?.cert && pendiente?.key);
            return (
              <div key={proposito} className="border border-line bg-panel-alt p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-[0.06em] text-text">
                    {PROPOSITO_LABELS[proposito]}
                  </span>
                  {estado?.cargado ? (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-state-done">
                      <Check size={13} /> CUIT {estado.cuit}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                      <AlertTriangle size={13} /> Sin certificado
                    </span>
                  )}
                </div>

                <p className="mt-2 text-[13px] text-text-soft">{PROPOSITO_AYUDA[proposito]}</p>

                <div className="mt-3 grid grid-cols-1 gap-2">
                  <label className={cn(labelClass, 'block')}>
                    Certificado (.crt)
                    <input
                      type="file"
                      accept=".crt,.pem,.cer"
                      onChange={(e) => handleArchivo(proposito, 'cert', e.target.files?.[0] ?? null)}
                      className="mt-1 w-full text-[13px] font-normal normal-case text-text-soft file:mr-2 file:border file:border-line file:bg-panel file:px-2 file:py-1 file:text-[13px] file:font-bold file:uppercase file:tracking-wider"
                    />
                    {pendiente?.cert && (
                      <span className="mt-1 block text-[12px] font-normal normal-case text-text-soft">
                        {pendiente.cuit
                          ? `Leído. Es del CUIT ${pendiente.cuit}.`
                          : 'Leído, pero no se encontró el CUIT adentro.'}
                      </span>
                    )}
                  </label>
                  <label className={cn(labelClass, 'block')}>
                    Clave privada (.key)
                    <input
                      type="file"
                      accept=".key,.pem"
                      onChange={(e) => handleArchivo(proposito, 'key', e.target.files?.[0] ?? null)}
                      className="mt-1 w-full text-[13px] font-normal normal-case text-text-soft file:mr-2 file:border file:border-line file:bg-panel file:px-2 file:py-1 file:text-[13px] file:font-bold file:uppercase file:tracking-wider"
                    />
                    {pendiente?.key && (
                      <span className="mt-1 block text-[12px] font-normal normal-case text-text-soft">Leída.</span>
                    )}
                  </label>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!listo || guardando === proposito}
                    onClick={() => handleGuardar(proposito)}
                  >
                    <Upload size={16} /> {guardando === proposito ? 'Guardando…' : 'Guardar certificado'}
                  </Button>
                  {estado?.cargado && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={guardando === proposito}
                      onClick={() => handleBorrar(proposito)}
                    >
                      <Trash2 size={16} /> Sacar
                    </Button>
                  )}
                </div>

                {proposito === 'FACTURACION' && estado?.cargado && <DiagnosticoFacturacion />}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/**
 * Prueba la conexión de facturación contra ARCA sin emitir nada.
 *
 * Se va directo a producción, sin homologación de por medio, así que esto es la
 * única forma de saber antes de facturar que el certificado sirve, que el
 * servicio está delegado y que el punto de venta está habilitado. Si algo del
 * portal quedó mal, aparece acá y no con un cliente enfrente.
 */
function DiagnosticoFacturacion() {
  const [probando, setProbando] = React.useState(false);
  const [resultado, setResultado] = React.useState<DiagnosticoArca | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function probar() {
    setProbando(true);
    setError(null);
    setResultado(null);
    try {
      setResultado(await diagnosticoFacturacion());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setProbando(false);
    }
  }

  const serversOk = resultado ? Object.values(resultado.servidores).every((v) => v === 'OK') : false;

  return (
    <div className="mt-4 border-t border-line pt-3">
      <Button type="button" variant="ghost" disabled={probando} onClick={probar}>
        <Activity size={16} /> {probando ? 'Consultando a ARCA…' : 'Probar conexión con ARCA'}
      </Button>
      <p className="mt-1 text-[12px] text-text-soft">Solo consulta. No emite ningún comprobante.</p>

      {error && (
        <div className="mt-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
      )}

      {resultado && (
        <div className="mt-3 space-y-3 text-[13px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-text-soft">Servidores de ARCA</dt>
            <dd className={serversOk ? 'font-semibold text-state-done' : 'font-semibold text-danger'}>
              {serversOk
                ? 'Funcionando'
                : `App ${resultado.servidores.aplicacion} · Base ${resultado.servidores.baseDeDatos} · Auth ${resultado.servidores.autenticacion}`}
            </dd>
            {resultado.certificado && (
              <>
                <dt className="text-text-soft">Certificado</dt>
                <dd className={resultado.certificado.coincideConTaller ? 'text-text' : 'font-semibold text-danger'}>
                  CUIT {resultado.certificado.cuit} · vence {resultado.certificado.vence}
                  {' '}({resultado.certificado.diasParaVencer} días)
                </dd>
              </>
            )}
          </dl>

          {resultado.puntosDeVenta.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="text-[11px] font-bold uppercase tracking-wider text-text-soft">
                  <tr className="border-b border-line">
                    <th className="py-1 pr-2">Punto de venta</th>
                    <th className="py-1 pr-2">Tipo</th>
                    <th className="py-1 pr-2 text-right">Última A</th>
                    <th className="py-1 pr-2 text-right">Última B</th>
                    <th className="py-1">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {resultado.puntosDeVenta.map((p) => {
                    const esElNuestro = p.numero === resultado.puntoDeVentaConfigurado;
                    const baja = p.bloqueado || p.fechaBaja;
                    return (
                      <tr key={p.numero} className={cn('border-b border-line', esElNuestro && 'bg-accent/10')}>
                        <td className="py-1 pr-2 font-mono font-semibold">
                          {String(p.numero).padStart(4, '0')}
                          {esElNuestro && (
                            <span className="ml-1.5 text-[11px] font-bold uppercase tracking-wider text-accent-deep">el de la app</span>
                          )}
                        </td>
                        <td className="py-1 pr-2">{p.tipoEmision}</td>
                        <td className="py-1 pr-2 text-right font-mono tabular-nums">{p.ultimos.A}</td>
                        <td className="py-1 pr-2 text-right font-mono tabular-nums">{p.ultimos.B}</td>
                        <td className={cn('py-1', baja ? 'text-danger' : 'text-state-done')}>
                          {p.bloqueado ? 'Bloqueado' : p.fechaBaja ? `Baja ${p.fechaBaja}` : 'Habilitado'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {resultado.avisos.length > 0 ? (
            <ul className="space-y-1">
              {resultado.avisos.map((aviso) => (
                <li key={aviso} className="flex gap-1.5 text-[13px] text-state-wait">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {aviso}
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-1.5 font-semibold text-state-done">
              <Check size={14} /> Todo en orden para facturar.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
