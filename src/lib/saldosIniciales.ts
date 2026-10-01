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
  /** Cobros ya aplicados que se descontaron de esta fila, para mostrarlos. */
  aplicado: string[];
  errores: string[];
}

interface Columnas {
  Cliente: number;
  CUIT: number;
  Comprobante: number;
  Fecha: number;
  Vencimiento: number;
  Importe: number;
  Debe: number;
  Haber: number;
  Aplicado: number;
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
 * busca la primera fila que tenga el cliente (o el CUIT) y el importe.
 *
 * Acepta dos formas: una columna "Importe" (positivo debe, negativo a favor),
 * o "Debe" y "Haber" como la composición de saldos que exporta el sistema
 * anterior, con los cobros ya aplicados en filas aparte ("Comprobante
 * aplicado") que se descuentan de la factura de arriba.
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
  let cols: Columnas | null = null;
  for (let i = 0; i < Math.min(matriz.length, 30); i++) {
    const encabezado = matriz[i].map((c) => sinAcentos(String(c ?? '')));
    const exacta = (...nombres: string[]) => encabezado.findIndex((h) => nombres.includes(h));
    const debe = exacta('debe');
    const haber = exacta('haber');
    const c: Columnas = {
      Cliente: columnaDe(encabezado, 'Cliente'),
      CUIT: columnaDe(encabezado, 'CUIT'),
      Comprobante: columnaDe(encabezado, 'Comprobante'),
      Fecha: columnaDe(encabezado, 'Fecha'),
      Vencimiento: columnaDe(encabezado, 'Vencimiento'),
      // Con Debe y Haber, la columna "Total" (o "Saldo") es el acumulado por
      // cliente, no el importe de la fila: no se lee.
      Importe: debe >= 0 || haber >= 0 ? -1 : columnaDe(encabezado, 'Importe'),
      Debe: debe,
      Haber: haber,
      Aplicado: exacta('comprobante aplicado', 'aplicado a', 'aplicado'),
    };
    if ((c.Cliente >= 0 || c.CUIT >= 0) && (c.Importe >= 0 || c.Debe >= 0 || c.Haber >= 0)) {
      filaEncabezado = i;
      cols = c;
      break;
    }
  }

  if (!cols) {
    throw new ExcelFormatError(
      'No encontré el encabezado. La planilla tiene que tener la columna "Cliente" y, o "Importe", o ' +
        '"Debe" y "Haber". Bajá la planilla modelo para ver el formato.'
    );
  }
  const col = cols;
  const celda = (fila: unknown[], i: number) => (i >= 0 ? fila[i] : '');
  const texto = (fila: unknown[], i: number) => String(celda(fila, i) ?? '').trim();

  /** El importe de la fila: Debe suma, Haber resta (venga con signo o sin él). */
  function importeDe(fila: unknown[]): number | null {
    if (col.Importe >= 0) return parsePrice(celda(fila, col.Importe));
    const debe = parsePrice(celda(fila, col.Debe));
    const haber = parsePrice(celda(fila, col.Haber));
    if (debe === null && haber === null) return null;
    return Math.round(((debe ?? 0) - Math.abs(haber ?? 0)) * 100) / 100;
  }

  const filas: FilaSaldoInicial[] = [];

  matriz.slice(filaEncabezado + 1).forEach((fila, k) => {
    const filaExcel = filaEncabezado + 2 + k;
    const cliente = texto(fila, col.Cliente);
    const cuit = texto(fila, col.CUIT);
    const comprobante = texto(fila, col.Comprobante);
    const aplicado = texto(fila, col.Aplicado);
    const importe = importeDe(fila);

    // Fila vacía, o la suma al pie ("Total"): no es un saldo.
    if (!cliente && !cuit && importe === null) return;
    if (/^total/i.test(cliente) && !cuit) return;

    // Un cobro ya aplicado viene en su propia fila, sin comprobante y con el
    // comprobante aplicado, debajo de la factura que descuenta: se le resta
    // a esa factura, que queda con lo que de verdad se debe.
    const anterior = filas[filas.length - 1];
    const mismoCliente =
      !!anterior &&
      (cuit
        ? anterior.cuit.replace(/\D/g, '') === cuit.replace(/\D/g, '')
        : anterior.cliente.toLowerCase() === cliente.toLowerCase());
    if (!comprobante && aplicado && mismoCliente && importe !== null && anterior.importe !== null) {
      anterior.importe = Math.round((anterior.importe + importe) * 100) / 100;
      const monto = Math.abs(importe).toLocaleString('es-AR', { minimumFractionDigits: 2 });
      anterior.aplicado.push(`${aplicado} ($ ${monto})`);
      anterior.errores = validar(anterior);
      return;
    }

    const f: FilaSaldoInicial = {
      filaExcel,
      cliente,
      cuit,
      comprobante: comprobante || aplicado,
      fecha: leerFecha(celda(fila, col.Fecha)) ?? 'INVALIDA',
      vencimiento: leerFecha(celda(fila, col.Vencimiento)) ?? 'INVALIDA',
      importe,
      aplicado: [],
      errores: [],
    };
    f.errores = validar(f);
    filas.push(f);
  });

  // Una factura que quedó en cero con lo aplicado ya está cobrada: no es saldo.
  return filas.filter((f) => !(f.aplicado.length > 0 && f.importe !== null && Math.abs(f.importe) < 0.005));
}

function validar(f: FilaSaldoInicial): string[] {
  const errores: string[] = [];
  if (!f.cliente && !f.cuit) errores.push('Falta el cliente.');
  const digitos = f.cuit.replace(/\D/g, '').length;
  if (f.cuit && digitos !== 11 && (digitos < 7 || digitos > 8)) {
    errores.push('El CUIT no tiene 11 dígitos (ni es un DNI de 7 u 8).');
  }
  if (f.importe === null) errores.push('Falta el importe o no es un número.');
  else if (Math.abs(f.importe) < 0.005) errores.push('El importe es cero.');
  if (f.fecha === 'INVALIDA') errores.push('La fecha no se entiende.');
  if (f.vencimiento === 'INVALIDA') errores.push('El vencimiento no se entiende.');
  if (f.fecha && f.vencimiento && f.fecha !== 'INVALIDA' && f.vencimiento !== 'INVALIDA' && f.vencimiento < f.fecha) {
    errores.push('Vence antes de la fecha.');
  }
  return errores;
}

/**
 * La condición de IVA que se desprende de los comprobantes: a quien se le
 * hizo una factura A es Responsable Inscripto. Se usa solo al crear el
 * cliente; sin factura A queda Consumidor Final y se corrige en la ficha.
 */
export function condicionIvaSugerida(filas: FilaSaldoInicial[], f: FilaSaldoInicial): 'RESPONSABLE_INSCRIPTO' | null {
  const clave = (x: FilaSaldoInicial) => x.cuit.replace(/\D/g, '') || x.cliente.toLowerCase();
  const esFacturaA = (c: string) => /factura.*\bA\b\s*\d/i.test(c);
  return filas.some((o) => clave(o) === clave(f) && esFacturaA(o.comprobante)) ? 'RESPONSABLE_INSCRIPTO' : null;
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
      condicion_iva: condicionIvaSugerida(filas, f),
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

// ---------------------------------------------------------------------------
// Carga en pantalla: un cliente a la vez
// ---------------------------------------------------------------------------

export type TipoSaldoInicial = 'DEBE' | 'A_FAVOR';

export const TIPO_SALDO_INICIAL_LABELS: Record<TipoSaldoInicial, string> = {
  DEBE: 'Debe (factura o nota de débito)',
  A_FAVOR: 'A favor (recibo o nota de crédito a cuenta)',
};

export interface RenglonSaldoInicial {
  tipo: TipoSaldoInicial;
  /** "A 0001-00001234": letra, punto de venta y número, como las facturas de la app. */
  comprobante: string;
  fecha: string;
  vencimiento: string;
  /** Siempre positivo: el signo lo da el tipo. */
  importe: number;
}

/**
 * Carga los renglones de un cliente ya elegido. Usa la misma función que la
 * importación por planilla (mismas reglas: deuda como factura de saldo
 * inicial, saldo a favor como recibo a cuenta, sin contar como venta), pero
 * con el cliente por su id: no hay que buscarlo por nombre.
 */
export async function cargarSaldosIniciales(
  customerId: string,
  renglones: RenglonSaldoInicial[]
): Promise<ResultadoImportacion> {
  const { data, error } = await supabase.rpc('importar_saldos_iniciales_clientes', {
    p_filas: renglones.map((r) => ({
      customer_id: customerId,
      comprobante: r.comprobante,
      fecha: r.fecha || null,
      vencimiento: r.vencimiento || null,
      importe: r.tipo === 'A_FAVOR' ? -Math.abs(r.importe) : Math.abs(r.importe),
    })),
  });
  if (error) throw error;
  const d = (data ?? {}) as any;
  return {
    clientesCreados: Number(d.clientes_creados ?? 0),
    deudas: Number(d.deudas ?? 0),
    totalDeuda: Number(d.total_deuda ?? 0),
    aFavor: Number(d.a_favor ?? 0),
    totalAFavor: Number(d.total_a_favor ?? 0),
  };
}

export interface SaldoInicialCargado {
  id: string;
  tipo: 'DEUDA' | 'A_FAVOR';
  comprobante: string;
  fecha: string;
  importe: number;
}

/** Lo que ese cliente ya tiene cargado como saldo inicial, para no cargarlo dos veces. */
export async function fetchSaldosInicialesDe(customerId: string): Promise<SaldoInicialCargado[]> {
  const [facturas, recibos] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, full_number, referencia_anterior, issue_date, total_amount')
      .eq('customer_id', customerId)
      .eq('saldo_inicial', true)
      .neq('status', 'ANULADA')
      .order('issue_date'),
    supabase
      .from('receipts')
      .select('id, full_number, receipt_date, total_amount')
      .eq('customer_id', customerId)
      .eq('saldo_inicial', true)
      .eq('status', 'REGISTRADO')
      .order('receipt_date'),
  ]);
  if (facturas.error) throw facturas.error;
  if (recibos.error) throw recibos.error;
  return [
    ...((facturas.data ?? []) as any[]).map((f) => ({
      id: f.id,
      tipo: 'DEUDA' as const,
      comprobante: f.referencia_anterior ?? f.full_number,
      fecha: f.issue_date,
      importe: Number(f.total_amount),
    })),
    ...((recibos.data ?? []) as any[]).map((r) => ({
      id: r.id,
      tipo: 'A_FAVOR' as const,
      comprobante: r.full_number,
      fecha: r.receipt_date,
      importe: -Number(r.total_amount),
    })),
  ];
}
