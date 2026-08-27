import * as XLSX from 'xlsx';
import type { ColumnMapping, ImportRow } from '@/src/lib/priceLists';

export interface ParsedSheet {
  rows: ImportRow[];
  /** Filas descartadas con el motivo, para mostrárselas al usuario. */
  skipped: { row: number; reason: string }[];
  sheetName: string;
}

/** Primeras filas del archivo, como texto, para elegir a mano qué columna es cada dato. */
export interface RawGrid {
  sheetName: string;
  rows: string[][];
  columnCount: number;
}

export class ExcelFormatError extends Error {}

/** 0 -> "A", 1 -> "B" ... 25 -> "Z", 26 -> "AA". Para rotular columnas en la grilla cruda. */
export function columnLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Convierte un valor de celda a número. Tolera formato argentino
 * ("1.234,56"), símbolo de moneda y espacios.
 */
export function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let text = String(value).trim().replace(/\s/g, '').replace(/[$â‚¬]/g, '').replace(/ARS/gi, '');
  if (text === '') return null;

  const hasComma = text.includes(',');
  const hasDot = text.includes('.');

  if (hasComma && hasDot) {
    // El último separador es el decimal: "1.234,56" o "1,234.56"
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (hasComma) {
    // Sola coma: decimal en formato argentino ("1234,56")
    text = text.replace(',', '.');
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readMatrix(file: File): Promise<{ sheetName: string; matrix: unknown[][] }> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new ExcelFormatError('El archivo no tiene ninguna hoja.');
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    defval: '',
  });

  if (matrix.length === 0) {
    throw new ExcelFormatError('El archivo está vacío.');
  }

  return { sheetName, matrix: matrix as unknown[][] };
}

/**
 * No asume encabezado en la fila 1: cada proveedor lo pone en una fila
 * distinta, o no lo pone. Devuelve las primeras filas tal cual están para
 * que el admin elija a mano qué columna es cada dato.
 */
export async function previewSheet(file: File, maxRows = 15): Promise<RawGrid> {
  const { sheetName, matrix } = await readMatrix(file);
  const columnCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const rows = matrix.slice(0, maxRows).map((row) =>
    Array.from({ length: columnCount }, (_, i) => String(row[i] ?? '').trim())
  );
  return { sheetName, rows, columnCount };
}

/**
 * Aplica el mapeo de columnas (guardado o recién definido) a todo el
 * archivo. Una fila de título o separadora no tiene a la vez código y
 * precio numérico válido en las columnas mapeadas, así que queda
 * descartada sola, sin necesidad de saber en qué fila empiezan los datos.
 */
export async function parseWithMapping(file: File, mapping: ColumnMapping): Promise<ParsedSheet> {
  const { sheetName, matrix } = await readMatrix(file);

  const rows: ImportRow[] = [];
  const skipped: ParsedSheet['skipped'] = [];
  const seen = new Set<string>();

  matrix.forEach((raw, i) => {
    const rowNumber = i + 1;
    const code = String(raw[mapping.codeColumn] ?? '').trim();
    const description = mapping.descriptionColumn === null
      ? ''
      : String(raw[mapping.descriptionColumn] ?? '').trim();
    const brand = mapping.brandColumn === null
      ? null
      : (String(raw[mapping.brandColumn] ?? '').trim() || null);
    const price = parsePrice(raw[mapping.priceColumn]);

    if (code === '') {
      skipped.push({ row: rowNumber, reason: 'sin código' });
      return;
    }
    if (price === null) {
      skipped.push({ row: rowNumber, reason: `precio ilegible ("${raw[mapping.priceColumn]}")` });
      return;
    }
    if (price < 0) {
      skipped.push({ row: rowNumber, reason: 'precio negativo' });
      return;
    }

    const key = code.toUpperCase();
    if (seen.has(key)) {
      skipped.push({ row: rowNumber, reason: `código repetido (${code})` });
      return;
    }
    seen.add(key);

    rows.push({ code, description, brand, price });
  });

  if (rows.length === 0) {
    throw new ExcelFormatError(
      'Ninguna fila tiene a la vez código y precio válidos con este mapeo. Revisá las columnas elegidas.'
    );
  }

  return { rows, skipped, sheetName };
}
