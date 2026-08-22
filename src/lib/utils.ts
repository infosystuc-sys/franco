import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MONEY_FORMAT = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Importes en formato argentino: 1.234,56 (punto de miles, coma decimal).
 * Vive acá y no en un módulo de facturación o de compras porque un mismo
 * número no puede leerse distinto según la pantalla.
 */
export function formatMoney(value: number): string {
  return MONEY_FORMAT.format(Number.isFinite(value) ? value : 0);
}

/**
 * Una fecha como YYYY-MM-DD según el huso local, no según UTC.
 *
 * Importa más de lo que parece: toISOString() devuelve UTC, y en Argentina
 * (UTC-3) después de las 21:00 daría el día siguiente. Un comprobante
 * figuraría vencido tres horas antes de estarlo.
 */
export function toDateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** La fecha de hoy en el huso del usuario, como YYYY-MM-DD. */
export function todayLocal(): string {
  return toDateString(new Date());
}

/**
 * Fecha para mostrar, en formato argentino. Parte el string en vez de
 * construir un Date: las fechas de la base son dates puros, sin hora, y
 * pasarlas por Date las correría de día según el huso.
 */
export function formatDate(value: string | null): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}
