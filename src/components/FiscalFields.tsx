import React from 'react';
import { Receipt, Download, Loader2 } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { consultarPadron, volcarEnFicha } from '@/src/lib/arcaPadron';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  isValidCuit,
  TAX_CONDITION_LABELS,
  TAX_CONDITIONS,
  type FiscalEntityInput,
  type TaxCondition,
} from '@/src/lib/fiscal';

export const labelClass = 'text-xs font-bold uppercase tracking-wider text-text-soft';
export const inputClass =
  'mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case ' +
  'focus:border-accent-deep focus:outline-none';
export const sectionTitleClass = 'text-[13px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5';

/**
 * Bloques de identificación, datos fiscales, domicilio y contacto.
 * Los comparten el ABM de clientes y el de proveedores.
 */
export function FiscalFields({
  form,
  patch,
  nameLabel,
  namePlaceholder,
  legalNamePlaceholder,
  activeLabel,
}: {
  form: FiscalEntityInput;
  patch: (changes: Partial<FiscalEntityInput>) => void;
  nameLabel: string;
  namePlaceholder: string;
  legalNamePlaceholder: string;
  activeLabel: string;
}) {
  const cuitInvalid = form.taxId.trim() !== '' && !isValidCuit(form.taxId);

  const [buscando, setBuscando] = React.useState(false);
  const [avisoPadron, setAvisoPadron] = React.useState<string | null>(null);
  const [errorPadron, setErrorPadron] = React.useState<string | null>(null);

  /**
   * Trae la ficha de ARCA con lo que esté escrito en el campo de CUIT. Acepta
   * también un DNI: la función del servidor resuelve a qué CUIT corresponde.
   */
  async function handleTraerDeArca() {
    const documento = form.taxId.replace(/\D/g, '');
    setErrorPadron(null);
    setAvisoPadron(null);
    setBuscando(true);
    try {
      const { datos, aviso } = await consultarPadron(documento);
      patch(volcarEnFicha(form, datos));
      const partes: string[] = [];
      if (aviso) partes.push(aviso);
      // Una clave inactiva se avisa pero no frena: el taller igual necesita
      // cargar al cliente, y la letra del comprobante la decide quien factura.
      if (datos.estadoClave && datos.estadoClave.toUpperCase() !== 'ACTIVO') {
        partes.push(`ARCA marca esta clave como ${datos.estadoClave.toLowerCase()}.`);
      }
      if (datos.categoriaMonotributo) {
        partes.push(`Monotributo categoría ${datos.categoriaMonotributo}.`);
      }
      setAvisoPadron(partes.length ? partes.join(' ') : 'Datos traídos de ARCA.');
    } catch (err) {
      setErrorPadron(getErrorMessage(err));
    } finally {
      setBuscando(false);
    }
  }

  // Once dígitos es un CUIT; siete u ocho, un DNI. Cualquier otra cosa todavía
  // se está escribiendo, y consultarla sería un viaje a ARCA para nada.
  const digitos = form.taxId.replace(/\D/g, '').length;
  const sePuedeBuscar = digitos === 11 || digitos === 7 || digitos === 8;

  return (
    <>
      {/* Identificación */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={cn(labelClass, 'col-span-2')}>
          {nameLabel} *
          <input value={form.name} onChange={(e) => patch({ name: e.target.value })} className={inputClass} placeholder={namePlaceholder} />
        </label>
        <label className={cn(labelClass, 'col-span-2')}>
          Razón social
          <input value={form.legalName} onChange={(e) => patch({ legalName: e.target.value })} className={inputClass} placeholder={legalNamePlaceholder} />
        </label>
      </div>

      {/* Datos fiscales */}
      <div className="border-t border-line pt-4 space-y-3">
        <h3 className={sectionTitleClass}><Receipt size={14} /> Datos fiscales</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            CUIT / CUIL
            <div className="flex gap-2">
              <input
                value={form.taxId}
                onChange={(e) => patch({ taxId: e.target.value })}
                className={cn(inputClass, 'font-mono', cuitInvalid && 'border-danger bg-danger-soft')}
                placeholder="30-71044366-8"
              />
              {/* Traer de ARCA en vez de copiar de una constancia en PDF. Va
                  pegado al CUIT porque es el único dato que necesita: el resto
                  de la ficha lo completa él. */}
              <button
                type="button"
                onClick={handleTraerDeArca}
                disabled={buscando || !sePuedeBuscar}
                title={
                  sePuedeBuscar
                    ? 'Traer razón social, condición de IVA y domicilio desde ARCA'
                    : 'Escribí un CUIT de 11 dígitos o un DNI'
                }
                className="mt-1 flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel-alt px-3 text-[13px] font-bold uppercase tracking-wider text-text-soft transition-colors hover:bg-accent hover:text-accent-ink disabled:opacity-40 disabled:hover:bg-panel-alt disabled:hover:text-text-soft"
              >
                {buscando ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {buscando ? 'Buscando…' : 'ARCA'}
              </button>
            </div>
            {cuitInvalid && (
              <span className="block mt-1 text-[12px] font-normal normal-case text-danger">
                CUIT/CUIL inválido (dígito verificador incorrecto).
              </span>
            )}
            {errorPadron && (
              <span className="block mt-1 text-[12px] font-normal normal-case text-danger">{errorPadron}</span>
            )}
            {avisoPadron && !errorPadron && (
              <span className="block mt-1 text-[12px] font-normal normal-case text-text-soft">{avisoPadron}</span>
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
        </div>
      </div>

      {/* Domicilio */}
      <div className="border-t border-line pt-4 space-y-3">
        <h3 className={sectionTitleClass}>Domicilio fiscal</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
          <label className={cn(labelClass, 'col-span-4')}>
            Calle y número
            <input value={form.addressStreet} onChange={(e) => patch({ addressStreet: e.target.value })} className={inputClass} placeholder="Av. Siempreviva 742" />
          </label>
          <label className={cn(labelClass, 'col-span-2')}>
            Código postal
            <input value={form.addressZip} onChange={(e) => patch({ addressZip: e.target.value })} className={inputClass} placeholder="B1636" />
          </label>
          <label className={cn(labelClass, 'col-span-3')}>
            Localidad
            <input value={form.addressCity} onChange={(e) => patch({ addressCity: e.target.value })} className={inputClass} placeholder="Olivos" />
          </label>
          <label className={cn(labelClass, 'col-span-3')}>
            Provincia
            <input value={form.addressState} onChange={(e) => patch({ addressState: e.target.value })} className={inputClass} placeholder="Buenos Aires" />
          </label>
        </div>
      </div>

      {/* Contacto */}
      <div className="border-t border-line pt-4 space-y-3">
        <h3 className={sectionTitleClass}>Contacto</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            Email
            <input type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} className={inputClass} placeholder="contacto@empresa.com" />
          </label>
          <label className={labelClass}>
            Teléfono
            <input value={form.phone} onChange={(e) => patch({ phone: e.target.value })} className={inputClass} placeholder="+54 9 11 5555-0001" />
          </label>
          <label className={cn(labelClass, 'col-span-2')}>
            Observaciones
            <textarea value={form.notes} onChange={(e) => patch({ notes: e.target.value })} rows={2} className={cn(inputClass, 'resize-y')} placeholder="Notas internas..." />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
          <input type="checkbox" checked={form.active} onChange={(e) => patch({ active: e.target.checked })} className="w-4 h-4 accent-accent-deep" />
          {activeLabel}
        </label>
      </div>
    </>
  );
}
