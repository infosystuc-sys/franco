import * as XLSX from 'xlsx';
import { supabase } from '@/src/lib/supabase';
import { ExcelFormatError, parsePrice } from '@/src/lib/excelImport';

/**
 * Importación de la composición inicial de saldos de clientes: lo que cada
 * cliente debía (o tenía a favor) en el sistema anterior el día que se
 * empezó a usar la app. Ver supabase/saldos-iniciales-clientes.sql.
 */

export interface FilaSaldoInicial {
  /** Número de fila en la planilla, para señalar errores donde se ven. */
  filaExcel: number;
  cliente: string;
  cuit: string;
  comprobante: string;
  /** yyyy-mm-dd, o vacío. */
  fecha: string;
  vencimiento: string;
  /** Positivo, debe; negativo, tiene a favor. */
  importe: number | null;
  errores: string[];
}

export interface ResultadoImportacion {
  clientesCreados: number;
  deudas: number;
  totalDeuda: number;
  aFavor: number;
  totalAFavor: number;
}

const COLUMNAS = ['Cliente', 'CUIT', 'Comprobante', 'Fecha', 'Vencimiento', 'Importe'] as const;

/** La planilla modelo, con dos filas de ejemplo: una deuda y un saldo a favor. */
export function descargarPlanillaModelo(): void {
  const hoja = XLSX.utils.aoa_to_sheet([
    [...COLUMNAS],
    ['Transportes El Ejemplo SRL', '30-71234567-8', 'FC A 0001-00001234', '15/08/2026', '15/09/2026', 150000],
    ['Juan Pérez', '', 'Anticipo', '01/09/2026', '', -20000],
  ]);
  hoja['!cols'] = [{ wch: 32 }, { wch: 16 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, 'Saldos iniciales');
  XLSX.writeFile(libro, 'saldos-iniciales-clientes.xlsx');
}

const sinAcentos = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Qué títulos de columna se reconocen para cada dato. */
const SINONIMOS: Record<(typeof COLUMNAS)[number], string[]> = {
  Cliente: ['cliente', 'razon social', 'nombre'],
  CUIT: ['cuit', 'cuil', 'dni', 'documento', 'nro doc'],
  Comprobante: ['comprobante', 'referencia', 'numero', 'nro', 'factura'],
  Fecha: ['fecha', 'emision'],
  Vencimiento: ['vencimiento', 'vence', 'vto'],
  Importe: ['importe', 'saldo', 'monto', 'deuda', 'total'],
};

function columnaDe(encabezado: string[], dato: (typeof COLUMNAS)[number]): number {
  // Primero la coincidencia exacta, después la que empieza con el sinónimo:
  // "Fecha vto" no tiene que tomarse como la fecha de emisión.
  for (const s of SINONIMOS[dato]) {
    const i = encabezado.findIndex((h) => h === s);
    if (i >= 0) return i;
  }
  for (const s of SINONIMOS[dato]) {
    const i = encabezado.findIndex((h) => h.startsWith(s));
    if (i >= 0) return i;
  }
  return -1;
}

/** Acepta una fecha de Excel, dd/mm/aaaa, d-m-aa o aaaa-mm-dd. Vacío si no hay nada. */
function leerFecha(valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === '') return '';
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    return `${valor.getFullYear()}-${String(valor.getMonth() + 1).padStart(2, '0')}-${String(valor.getDate()).padStart(2, '0')}`;
  }
  if (typeof valor === 'number') {
    const d = XLSX.SSF.parse_date_code(valor);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const texto = String(valor).trim();
  let m = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = texto.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const anio = m[3].length === 2 ? `20${m[3]}` : m[3];
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Lee la primera hoja. El encabezado no tiene por qué estar en la fila 1: se
 * busca la primera fila que tenga "cliente" (o CUIT) y "importe" (o saldo).
 */
export async function leerPlanillaDeSaldos(file: File): Promise<FilaSaldoInicial[]> {
  // Sin cellDates: las fechas llegan como número de serie de Excel y se
  // convierten con parse_date_code, que no depende del huso horario. Con
  // objetos Date, una fecha podía correrse al día anterior.
  const libro = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const nombreHoja = libro.SheetNames[0];
  if (!nombreHoja) throw new ExcelFormatError('El archivo no tiene ninguna hoja.');
  const matriz = XLSX.utils.sheet_to_json<unknown[]>(libro.Sheets[nombreHoja], {
    header: 1,
    blankrows: false,
    defval: '',
    raw: true,
  }) as unknown[][];

  let filaEncabezado = -1;
  let cols: Record<(typeof COLUMNAS)[number], number> | null = null;
  for (let i = 0; i < Math.min(matriz.length, 30); i++) {
    const encabezado = matriz[i].map((c) => sinAcentos(String(c ?? '')));
    const c = {
      Cliente: columnaDe(encabezado, 'Cliente'),
      CUIT: columnaDe(encabezado, 'CUIT'),
      Comprobante: columnaDe(encabezado, 'Comprobante'),
      Fecha: columnaDe(encabezado, 'Fecha'),
      Vencimiento: columnaDe(encabezado, 'Vencimiento'),
      Importe: columnaDe(encabezado, 'Importe'),
    };
    if ((c.Cliente >= 0 || c.CUIT >= 0) && c.Importe >= 0) {
      filaEncabezado = i;
      cols = c;
      break;
    }
  }

  if (!cols) {
    throw new ExcelFormatError(
      'No encontré el encabezado. La planilla tiene que tener al menos las columnas "Cliente" e "Importe". ' +
        'Bajá la planilla modelo para ver el formato.'
    );
  }

  const celda = (fila: unknown[], i: number) => (i >= 0 ? fila[i] : '');

  return matriz
    .slice(filaEncabezado + 1)
    .map((fila, k) => {
      const errores: string[] = [];
      const cliente = String(celda(fila, cols!.Cliente) ?? '').trim();
      const cuit = String(celda(fila, cols!.CUIT) ?? '').trim();
      const importe = parsePrice(celda(fila, cols!.Importe));
      const fecha = leerFecha(celda(fila, cols!.Fecha));
      const vencimiento = leerFecha(celda(fila, cols!.Vencimiento));

      if (!cliente && !cuit) errores.push('Falta el cliente.');
      const digitos = cuit.replace(/\D/g, '').length;
      if (cuit && digitos !== 11 && (digitos < 7 || digitos > 8)) {
        errores.push('El CUIT no tiene 11 dígitos (ni es un DNI de 7 u 8).');
      }
      if (importe === null) errores.push('Falta el importe o no es un número.');
      else if (Math.abs(importe) < 0.005) errores.push('El importe es cero.');
      if (fecha === null) errores.push('La fecha no se entiende.');
      if (vencimiento === null) errores.push('El vencimiento no se entiende.');
      if (fecha && vencimiento && vencimiento < fecha) errores.push('Vence antes de la fecha.');

      return {
        filaExcel: filaEncabezado + 2 + k,
        cliente,
        cuit,
        comprobante: String(celda(fila, cols!.Comprobante) ?? '').trim(),
        fecha: fecha ?? '',
        vencimiento: vencimiento ?? '',
        importe,
        errores,
      };
    })
    // Una fila sin cliente, sin CUIT y sin importe es una fila vacía, y una
    // que dice "Total" es la suma al pie: ninguna es un saldo, se ignoran.
    .filter((f) => (f.cliente || f.cuit || f.importe !== null) && !(/^total/i.test(f.cliente) && !f.cuit));
}

export async function importarSaldosIniciales(filas: FilaSaldoInicial[]): Promise<ResultadoImportacion> {
  const { data, error } = await supabase.rpc('importar_saldos_iniciales_clientes', {
    p_filas: filas.map((f) => ({
      cliente: f.cliente,
      cuit: f.cuit,
      comprobante: f.comprobante,
      fecha: f.fecha || null,
      vencimiento: f.vencimiento || null,
      importe: f.importe,
    })),
  });
  if (error) throw error;
  const r = (data ?? {}) as any;
  return {
    clientesCreados: Number(r.clientes_creados ?? 0),
    deudas: Number(r.deudas ?? 0),
    totalDeuda: Number(r.total_deuda ?? 0),
    aFavor: Number(r.a_favor ?? 0),
    totalAFavor: Number(r.total_a_favor ?? 0),
  };
}

/** Cuántos saldos iniciales hay cargados, para avisar antes de importar dos veces. */
export async function contarSaldosInicialesCargados(): Promise<number> {
  const [facturas, recibos] = await Promise.all([
    supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('saldo_inicial', true).neq('status', 'ANULADA'),
    supabase.from('receipts').select('id', { count: 'exact', head: true }).eq('saldo_inicial', true).eq('status', 'REGISTRADO'),
  ]);
  if (facturas.error) throw facturas.error;
  if (recibos.error) throw recibos.error;
  return (facturas.count ?? 0) + (recibos.count ?? 0);
}
