import * as XLSX from 'xlsx';
import { supabase } from '@/src/lib/supabase';
import { ExcelFormatError } from '@/src/lib/excelImport';
import type { TaxCondition } from '@/src/lib/fiscal';
import type { CondicionVenta } from '@/src/lib/invoices';

/**
 * Importación masiva de clientes desde Excel. Ver supabase/importar-clientes.sql:
 * los que ya existen (por CUIT o por nombre exacto) se completan con lo que
 * trae la planilla, sin borrar nada; los que no, se crean.
 */

export interface FilaCliente {
  filaExcel: number;
  nombre: string;
  razonSocial: string;
  cuit: string;
  condicionIva: TaxCondition | null;
  condicionVenta: CondicionVenta | null;
  email: string;
  telefono: string;
  domicilio: string;
  localidad: string;
  provincia: string;
  cp: string;
  notas: string;
  errores: string[];
}

type Dato =
  | 'Nombre' | 'Razón social' | 'CUIT' | 'Condición IVA' | 'Condición de venta' | 'Email'
  | 'Teléfono' | 'Domicilio' | 'Localidad' | 'Provincia' | 'CP' | 'Observaciones';

const COLUMNAS: Dato[] = [
  'Nombre', 'Razón social', 'CUIT', 'Condición IVA', 'Condición de venta', 'Email',
  'Teléfono', 'Domicilio', 'Localidad', 'Provincia', 'CP', 'Observaciones',
];

/** Títulos de columna que se reconocen para cada dato, del más al menos específico. */
const SINONIMOS: Record<Dato, string[]> = {
  Nombre: ['nombre', 'cliente', 'nombre de fantasia', 'fantasia'],
  'Razón social': ['razon social'],
  CUIT: ['cuit', 'cuil', 'dni', 'documento', 'nro doc'],
  'Condición IVA': ['condicion iva', 'condicion frente al iva', 'cond iva', 'iva', 'categoria iva'],
  'Condición de venta': ['condicion de venta', 'condicion venta', 'cond venta', 'forma de pago'],
  Email: ['email', 'e-mail', 'mail', 'correo'],
  'Teléfono': ['telefono', 'celular', 'whatsapp', 'tel'],
  Domicilio: ['domicilio', 'direccion', 'calle'],
  Localidad: ['localidad', 'ciudad'],
  Provincia: ['provincia'],
  CP: ['cp', 'codigo postal', 'cod postal'],
  Observaciones: ['observaciones', 'notas', 'obs'],
};

const sinAcentos = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function columnaDe(encabezado: string[], dato: Dato, tomadas: Set<number>): number {
  for (const s of SINONIMOS[dato]) {
    const i = encabezado.findIndex((h, k) => !tomadas.has(k) && h === s);
    if (i >= 0) return i;
  }
  for (const s of SINONIMOS[dato]) {
    const i = encabezado.findIndex((h, k) => !tomadas.has(k) && h.startsWith(s));
    if (i >= 0) return i;
  }
  return -1;
}

function leerCondicionIva(texto: string): TaxCondition | null | 'INVALIDA' {
  const t = sinAcentos(texto).replace(/\./g, '');
  if (!t) return null;
  if (t === 'ri' || t.includes('inscrip')) return 'RESPONSABLE_INSCRIPTO';
  if (t === 'mt' || t === 'mono' || t.includes('monotrib')) return 'MONOTRIBUTO';
  if (t.includes('exent')) return 'EXENTO';
  if (t === 'cf' || t.includes('consumidor')) return 'CONSUMIDOR_FINAL';
  return 'INVALIDA';
}

function leerCondicionVenta(texto: string): CondicionVenta | null | 'INVALIDA' {
  const t = sinAcentos(texto).replace(/\./g, '');
  if (!t) return null;
  if (t.includes('contado') || t === 'efectivo') return 'CONTADO';
  if (t === 'cc' || t === 'ctacte' || t.includes('cuenta') || t.includes('cta')) return 'CUENTA_CORRIENTE';
  return 'INVALIDA';
}

/** La planilla modelo, con dos clientes de ejemplo. */
export function descargarPlanillaModeloClientes(): void {
  const hoja = XLSX.utils.aoa_to_sheet([
    [...COLUMNAS],
    ['Transportes El Ejemplo', 'Transportes El Ejemplo SRL', '30-71234567-8', 'Responsable Inscripto',
      'Cuenta corriente', 'administracion@ejemplo.com', '381 5123456', 'Av. Siempre Viva 123',
      'San Miguel de Tucumán', 'Tucumán', '4000', ''],
    ['Juan Pérez', '', '20-12345678-9', 'Consumidor Final', 'Contado', '', '381 4987654', '', '', '', '', 'Cliente de mostrador'],
  ]);
  hoja['!cols'] = [28, 30, 16, 22, 18, 28, 16, 28, 22, 14, 8, 24].map((wch) => ({ wch }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, 'Clientes');
  XLSX.writeFile(libro, 'clientes.xlsx');
}

/**
 * Lee la primera hoja. El encabezado se busca en las primeras filas: la
 * primera que tenga algo parecido a "nombre" (o "razón social").
 */
export async function leerPlanillaDeClientes(file: File): Promise<FilaCliente[]> {
  const libro = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const nombreHoja = libro.SheetNames[0];
  if (!nombreHoja) throw new ExcelFormatError('El archivo no tiene ninguna hoja.');
  const matriz = XLSX.utils.sheet_to_json<unknown[]>(libro.Sheets[nombreHoja], {
    header: 1,
    blankrows: false,
    defval: '',
    raw: false,
  }) as unknown[][];

  let filaEncabezado = -1;
  let cols: Record<Dato, number> | null = null;
  for (let i = 0; i < Math.min(matriz.length, 30); i++) {
    const encabezado = matriz[i].map((c) => sinAcentos(String(c ?? '')));
    // Razón social antes que nombre: "razon social" no tiene que quedar como
    // el nombre por empezar distinto, pero "nombre" sí podría comerse otra.
    const tomadas = new Set<number>();
    const c = {} as Record<Dato, number>;
    for (const dato of ['Razón social', ...COLUMNAS.filter((d) => d !== 'Razón social')] as Dato[]) {
      c[dato] = columnaDe(encabezado, dato, tomadas);
      if (c[dato] >= 0) tomadas.add(c[dato]);
    }
    if (c.Nombre >= 0 || c['Razón social'] >= 0) {
      filaEncabezado = i;
      cols = c;
      break;
    }
  }

  if (!cols) {
    throw new ExcelFormatError(
      'No encontré el encabezado. La planilla tiene que tener al menos la columna "Nombre" (o "Razón social"). ' +
        'Bajá la planilla modelo para ver el formato.'
    );
  }

  const texto = (fila: unknown[], dato: Dato) => {
    const i = cols![dato];
    return i >= 0 ? String(fila[i] ?? '').trim() : '';
  };

  const cuitsVistos = new Map<string, number>();

  return matriz
    .slice(filaEncabezado + 1)
    .map((fila, k) => {
      const filaExcel = filaEncabezado + 2 + k;
      const errores: string[] = [];
      const razonSocial = texto(fila, 'Razón social');
      const nombre = texto(fila, 'Nombre') || razonSocial;
      const cuit = texto(fila, 'CUIT');
      const iva = leerCondicionIva(texto(fila, 'Condición IVA'));
      const venta = leerCondicionVenta(texto(fila, 'Condición de venta'));

      if (!nombre) errores.push('Falta el nombre.');
      const digitos = cuit.replace(/\D/g, '');
      if (cuit && digitos.length !== 11 && (digitos.length < 7 || digitos.length > 8)) {
        errores.push('El CUIT no tiene 11 dígitos (ni es un DNI de 7 u 8).');
      }
      if (digitos) {
        const anterior = cuitsVistos.get(digitos);
        if (anterior) errores.push(`El CUIT está repetido en la fila ${anterior}.`);
        else cuitsVistos.set(digitos, filaExcel);
      }
      if (iva === 'INVALIDA') {
        errores.push('Condición de IVA desconocida: Responsable Inscripto, Monotributo, Exento o Consumidor Final.');
      }
      if (venta === 'INVALIDA') errores.push('Condición de venta desconocida: Contado o Cuenta corriente.');

      return {
        filaExcel,
        nombre,
        razonSocial,
        cuit,
        condicionIva: iva === 'INVALIDA' ? null : iva,
        condicionVenta: venta === 'INVALIDA' ? null : venta,
        email: texto(fila, 'Email'),
        telefono: texto(fila, 'Teléfono'),
        domicilio: texto(fila, 'Domicilio'),
        localidad: texto(fila, 'Localidad'),
        provincia: texto(fila, 'Provincia'),
        cp: texto(fila, 'CP'),
        notas: texto(fila, 'Observaciones'),
        errores,
      };
    })
    // Una fila sin nombre, sin razón social y sin CUIT es una fila vacía.
    .filter((f) => f.nombre || f.cuit);
}

export async function importarClientes(filas: FilaCliente[]): Promise<{ creados: number; actualizados: number }> {
  const { data, error } = await supabase.rpc('importar_clientes', {
    p_filas: filas.map((f) => ({
      nombre: f.nombre,
      razon_social: f.razonSocial,
      cuit: f.cuit,
      condicion_iva: f.condicionIva,
      condicion_venta: f.condicionVenta,
      email: f.email,
      telefono: f.telefono,
      domicilio: f.domicilio,
      localidad: f.localidad,
      provincia: f.provincia,
      cp: f.cp,
      notas: f.notas,
    })),
  });
  if (error) throw error;
  const r = (data ?? {}) as any;
  return { creados: Number(r.creados ?? 0), actualizados: Number(r.actualizados ?? 0) };
}
