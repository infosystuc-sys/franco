import * as XLSX from 'xlsx';
import type { ImportRow } from '@/src/lib/priceLists';

/**
 * Formato fijo esperado en el Excel de la lista de precios del proveedor:
 * la primera fila son encabezados y deben existir las columnas código,
 * descripción y precio. Se aceptan variantes de nombre y acentos.
 */
const COLUMN_ALIASES = {
  code: ['codigo', 'código', 'cod', 'code', 'articulo', 'artículo', 'sku'],
  description: ['descripcion', 'descripción', 'detalle', 'description', 'denominacion', 'denominación'],
  price: ['precio', 'price', 'importe', 'valor', 'preciounitario', 'precio unitario', 'precio_unitario'],
};

export interface ParsedSheet {
  rows: ImportRow[];
  /** Filas descartadas con el motivo, para mostrárselas al usuario. */
  skipped: { row: number; reason: string }[];
  sheetName: string;
}

export class ExcelFormatError extends Error {}

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/\s+/g, '');
}

function findColumn(headers: string[], aliases: string[]): number {
  const normalizedAliases = aliases.map(normalizeHeader);
  return headers.findIndex((header) => normalizedAliases.includes(header));
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

export async function parsePriceListFile(file: File): Promise<ParsedSheet> {
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

  if (matrix.length < 2) {
    throw new ExcelFormatError('El archivo está vacío o solo tiene los encabezados.');
  }

  const headers = (matrix[0] ?? []).map(normalizeHeader);
  const codeIdx = findColumn(headers, COLUMN_ALIASES.code);
  const descIdx = findColumn(headers, COLUMN_ALIASES.description);
  const priceIdx = findColumn(headers, COLUMN_ALIASES.price);

  const missing: string[] = [];
  if (codeIdx === -1) missing.push('código');
  if (priceIdx === -1) missing.push('precio');
  if (missing.length > 0) {
    throw new ExcelFormatError(
      `Faltan las columnas: ${missing.join(', ')}. ` +
      'La primera fila debe tener los encabezados "codigo", "descripcion" y "precio".'
    );
  }

  const rows: ImportRow[] = [];
  const skipped: ParsedSheet['skipped'] = [];
  const seen = new Set<string>();

  matrix.slice(1).forEach((raw, i) => {
    const rowNumber = i + 2; // +1 por encabezado, +1 porque Excel empieza en 1
    const code = String(raw[codeIdx] ?? '').trim();
    const description = descIdx === -1 ? '' : String(raw[descIdx] ?? '').trim();
    const price = parsePrice(raw[priceIdx]);

    if (code === '') {
      skipped.push({ row: rowNumber, reason: 'sin código' });
      return;
    }
    if (price === null) {
      skipped.push({ row: rowNumber, reason: `precio ilegible ("${raw[priceIdx]}")` });
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

    rows.push({ code, description, price });
  });

  if (rows.length === 0) {
    throw new ExcelFormatError('No se encontró ninguna fila válida para importar.');
  }

  return { rows, skipped, sheetName };
}

/** Genera y descarga una plantilla vacía con el formato esperado. */
export function downloadTemplate(): void {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['codigo', 'descripcion', 'precio'],
    ['BOS-093', 'Tobera Inyector Common Rail', 125.5],
    ['BOS-201', 'Kit Reparación Bomba VP44', 310],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Lista de precios');
  XLSX.writeFile(workbook, 'plantilla-lista-precios.xlsx');
}
