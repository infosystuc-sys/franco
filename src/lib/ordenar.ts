/**
 * Orden de las tablas al hacer click en el título de una columna.
 *
 * Un click ordena de menor a mayor, el segundo de mayor a menor y el tercero
 * vuelve al orden original. Los valores vacíos van siempre al final, sin
 * importar el sentido.
 */

export type SentidoOrden = 'asc' | 'desc';

export interface Orden {
  /** Qué columna: su título o su clave, según la pantalla. */
  columna: string;
  sentido: SentidoOrden;
}

/** El orden que sigue a un click sobre `columna`: asc → desc → ninguno. */
export function siguienteOrden(actual: Orden | null, columna: string): Orden | null {
  if (!actual || actual.columna !== columna) return { columna, sentido: 'asc' };
  if (actual.sentido === 'asc') return { columna, sentido: 'desc' };
  return null;
}

const comparadorDeTexto = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/**
 * Lo que se compara de un valor: un número (importes, cantidades, fechas) o un
 * texto. Entiende lo que muestran las pantallas: "07/10/2026", "$ 1.234,56",
 * "−$ 100,00" y los números sueltos. Null si no hay nada que comparar ("—").
 */
export function valorOrdenable(valor: unknown): number | string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'boolean') return valor ? 1 : 0;

  const texto = String(valor).trim();
  if (texto === '' || texto === '—' || texto === '-') return null;

  const fecha = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (fecha) return Date.UTC(Number(fecha[3]), Number(fecha[2]) - 1, Number(fecha[1]));

  // Fecha ISO (2026-10-07), tal como viene de la base.
  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  // Importes en formato argentino: puntos de miles y coma decimal.
  const limpio = texto.replace(/[$\s]/g, '').replace('−', '-');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(limpio) || /^-?\d+(,\d+)?$/.test(limpio)) {
    const n = Number(limpio.replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(limpio)) return Number(limpio);
  return texto;
}

function comparar(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // Mezcla de números y textos: los números primero.
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return comparadorDeTexto.compare(a, b);
}

/** Las filas en el orden pedido. Sin orden, las mismas, tal como vinieron. */
export function ordenarFilas<T>(
  filas: T[],
  orden: Orden | null,
  valorDe: (fila: T, columna: string) => unknown
): T[] {
  if (!orden) return filas;
  const signo = orden.sentido === 'asc' ? 1 : -1;
  const conValor = filas.map((fila, i) => ({ fila, i, v: valorOrdenable(valorDe(fila, orden.columna)) }));
  conValor.sort((x, y) => {
    if (x.v === null && y.v === null) return x.i - y.i;
    if (x.v === null) return 1;
    if (y.v === null) return -1;
    const c = comparar(x.v, y.v) * signo;
    return c !== 0 ? c : x.i - y.i;
  });
  return conValor.map((x) => x.fila);
}
