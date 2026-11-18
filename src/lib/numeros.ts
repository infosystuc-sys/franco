/**
 * Leer un número tal como lo escribe la gente acá: con coma decimal, con
 * punto decimal (el del teclado numérico) o con puntos de miles.
 *
 *   "1.234,56" → 1234.56     "1234,56" → 1234.56     "1234.56" → 1234.56
 *   "40.000"   → 40000       "1.234.567" → 1234567   ""  → null
 *
 * Un solo punto seguido de exactamente tres cifras se toma como de miles
 * ("40.000"); con una o dos cifras, como decimal ("12.5", "12.50"). Con
 * `puntoDeMiles: false` un punto solo es siempre decimal: es lo que hace
 * falta en un campo donde se tipea con el teclado numérico ("1.500" = 1,5).
 */
export function leerNumero(texto: string, { puntoDeMiles = true }: { puntoDeMiles?: boolean } = {}): number | null {
  const t = texto.trim().replace(/\s/g, '').replace(/\$/g, '');
  if (!t || t === '-' || t === ',' || t === '.') return null;
  let normal = t;
  const comas = (t.match(/,/g) ?? []).length;
  const puntos = (t.match(/\./g) ?? []).length;
  if (comas > 0 && puntos > 0) {
    normal = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (comas === 1) {
    normal = t.replace(',', '.');
  } else if (comas > 1) {
    normal = t.replace(/,/g, '');
  } else if (puntos > 1 || (puntoDeMiles && /^-?\d{1,3}\.\d{3}$/.test(t))) {
    normal = t.replace(/\./g, '');
  }
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

/** Cómo se muestra un número para editarlo: sin miles, con coma decimal. */
export function numeroParaEditar(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return String(Math.round(n * 10000) / 10000).replace('.', ',');
}
