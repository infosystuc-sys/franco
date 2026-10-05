import React from 'react';
import { cn } from '@/src/lib/utils';
import type { CustomerSector } from '@/src/lib/customers';

/**
 * A qué sector del cliente va un comprobante (OT, cotización, factura). Solo
 * aparece si el cliente tiene sectores cargados. El sector elegido es el
 * contacto al que salen el mail, el WhatsApp y los avisos; "General" usa el
 * teléfono y mail de la ficha del cliente.
 */
export function SelectorDeSector({
  sectores,
  value,
  onChange,
  disabled,
  className,
}: {
  sectores: CustomerSector[];
  /** Id del sector, o '' para el contacto general. */
  value: string;
  onChange: (sectorId: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (sectores.length === 0) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label="Sector del cliente"
      className={cn(
        'h-10 w-full rounded-[3px] border border-line bg-panel px-3 text-[15px] text-text focus:border-accent focus:outline-none',
        className
      )}
    >
      <option value="">General del cliente</option>
      {sectores.map((s) => (
        <option key={s.id} value={s.id}>
          {[s.name, s.responsable, s.phone, s.email].filter(Boolean).join(' · ')}
        </option>
      ))}
    </select>
  );
}

/** Con un único sector, no hay nada que elegir: se asigna ese. */
export function sectorPorDefecto(sectores: CustomerSector[] | undefined): string {
  return sectores && sectores.length === 1 ? sectores[0].id : '';
}
