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

/** Minúsculas, sin acentos ni puntos: para comparar lo que se busca con lo que hay. */
export function normalizarBusqueda(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,]/g, '')
    .trim();
}

/**
 * La regla de búsqueda de toda la app (la misma del buscador de clientes):
 * cada palabra buscada tiene que estar en alguno de los campos, en cualquier
 * orden y sin importar acentos ni mayúsculas, y una palabra de números se
 * busca también sin guiones ni espacios (un CUIT, un teléfono, una patente).
 */
export function coincideBusqueda(consulta: string, campos: unknown[]): boolean {
  const palabras = normalizarBusqueda(consulta).split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return true;
  const textos = campos.filter((c) => c !== null && c !== undefined && c !== '').map((c) => String(c));
  const texto = normalizarBusqueda(textos.join(' '));
  const compacto = texto.replace(/[\s-]/g, '');
  return palabras.every((p) => texto.includes(p) || compacto.includes(p.replace(/-/g, '')));
}
