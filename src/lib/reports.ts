import * as XLSX from 'xlsx';
import { supabase } from '@/src/lib/supabase';
import { formatDate, formatMoney, todayLocal } from '@/src/lib/utils';

/**
 * Catálogo de informes.
 *
 * Cada informe es una DEFINICIÓN, no una pantalla: una sola ruta las renderiza
 * a todas. Agregar un informe nuevo es agregar una definición.
 *
 * Las columnas declaran su formato una sola vez, y de ahí salen tres cosas a
 * la vez: la alineación en pantalla, el formato numérico del Excel y si la
 * columna entra en la fila de totales. Mantener ese criterio en dos lugares
 * es la forma más segura de que se despeguen.
 */

export type ColumnFormat = 'text' | 'date' | 'number' | 'money' | 'integer';

export interface ReportColumn {
  key: string;
  label: string;
  format?: ColumnFormat;
  /** Si suma en la fila de totales. Solo tiene sentido en números. */
  total?: boolean;
  /** Ancho en caracteres para el Excel. */
  width?: number;
}

export type ReportArea = 'COMERCIAL' | 'CUENTAS_CORRIENTES' | 'IMPOSITIVO' | 'STOCK_TESORERIA' | 'OPERACIONES';

export const AREA_LABELS: Record<ReportArea, string> = {
  COMERCIAL: 'Comerciales',
  CUENTAS_CORRIENTES: 'Cuentas corrientes',
  IMPOSITIVO: 'Impositivos',
  STOCK_TESORERIA: 'Stock y tesorería',
  OPERACIONES: 'Operaciones de taller',
};

export const AREAS = Object.keys(AREA_LABELS) as ReportArea[];

export interface ReportParams {
  from: string;
  to: string;
}

export interface ReportDefinition {
  id: string;
  area: ReportArea;
  name: string;
  description: string;
  /** Si el informe se acota por período. Los de saldos son a hoy. */
  usesPeriod: boolean;
  columns: ReportColumn[];
  run: (params: ReportParams) => Promise<Record<string, unknown>[]>;
}

// ===========================================================================
// Acceso a las funciones de la base
// ===========================================================================

async function callReport(
  fn: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

const periodArgs = (p: ReportParams) => ({ p_from: p.from, p_to: p.to });

// ===========================================================================
// El catálogo
// ===========================================================================

export const REPORTS: ReportDefinition[] = [
  {
    id: 'ventas-periodo',
    area: 'COMERCIAL',
    name: 'Ventas por período',
    description: 'Todas las facturas emitidas en el período, comprobante por comprobante.',
    usesPeriod: true,
    columns: [
      { key: 'issue_date', label: 'Fecha', format: 'date', width: 12 },
      { key: 'comprobante', label: 'Comprobante', width: 22 },
      { key: 'customer_name', label: 'Cliente', width: 30 },
      { key: 'customer_tax_id', label: 'CUIT', width: 14 },
      { key: 'net_amount', label: 'Neto', format: 'money', total: true, width: 14 },
      { key: 'vat_amount', label: 'IVA', format: 'money', total: true, width: 14 },
      { key: 'total_amount', label: 'Total', format: 'money', total: true, width: 14 },
      { key: 'paid_amount', label: 'Cobrado', format: 'money', total: true, width: 14 },
      { key: 'balance', label: 'Saldo', format: 'money', total: true, width: 14 },
    ],
    run: (p) => callReport('report_sales_by_period', periodArgs(p)),
  },
  {
    id: 'ranking-clientes',
    area: 'COMERCIAL',
    name: 'Ranking de clientes',
    description: 'Cuánto facturó cada cliente en el período, de mayor a menor.',
    usesPeriod: true,
    columns: [
      { key: 'customer_name', label: 'Cliente', width: 34 },
      { key: 'customer_tax_id', label: 'CUIT', width: 14 },
      { key: 'comprobantes', label: 'Comprob.', format: 'integer', total: true, width: 10 },
      { key: 'net_amount', label: 'Neto', format: 'money', total: true, width: 16 },
      { key: 'total_amount', label: 'Total', format: 'money', total: true, width: 16 },
      { key: 'balance', label: 'Saldo impago', format: 'money', total: true, width: 16 },
    ],
    run: (p) => callReport('report_customer_ranking', periodArgs(p)),
  },
  {
    id: 'articulos-vendidos',
    area: 'COMERCIAL',
    name: 'Artículos y servicios más vendidos',
    description:
      'Sale de los renglones facturados, no de las órdenes: lo que importa es lo que se facturó.',
    usesPeriod: true,
    columns: [
      { key: 'code', label: 'Código', width: 14 },
      { key: 'description', label: 'Descripción', width: 40 },
      { key: 'quantity', label: 'Cantidad', format: 'number', total: true, width: 12 },
      { key: 'net_amount', label: 'Neto vendido', format: 'money', total: true, width: 16 },
      { key: 'comprobantes', label: 'Comprob.', format: 'integer', total: true, width: 10 },
    ],
    run: (p) => callReport('report_top_articles', periodArgs(p)),
  },
  {
    id: 'ventas-mensual',
    area: 'COMERCIAL',
    name: 'Comparativo mensual',
    description: 'Facturación mes a mes dentro del período elegido.',
    usesPeriod: true,
    columns: [
      { key: 'periodo', label: 'Período', width: 12 },
      { key: 'comprobantes', label: 'Comprob.', format: 'integer', total: true, width: 10 },
      { key: 'net_amount', label: 'Neto', format: 'money', total: true, width: 16 },
      { key: 'vat_amount', label: 'IVA', format: 'money', total: true, width: 16 },
      { key: 'total_amount', label: 'Total', format: 'money', total: true, width: 16 },
    ],
    run: (p) => callReport('report_monthly_sales', periodArgs(p)),
  },

  {
    id: 'saldos-clientes',
    area: 'CUENTAS_CORRIENTES',
    name: 'Composición de saldos — clientes',
    description: 'Qué comprobantes forman el saldo de cada cliente, con sus días de mora.',
    usesPeriod: false,
    columns: [
      { key: 'customer_name', label: 'Cliente', width: 30 },
      { key: 'comprobante', label: 'Comprobante', width: 22 },
      { key: 'issue_date', label: 'Emisión', format: 'date', width: 12 },
      { key: 'due_date', label: 'Vencimiento', format: 'date', width: 12 },
      { key: 'dias_vencido', label: 'Días', format: 'integer', width: 8 },
      { key: 'total_amount', label: 'Total', format: 'money', total: true, width: 14 },
      { key: 'paid_amount', label: 'Cobrado', format: 'money', total: true, width: 14 },
      { key: 'balance', label: 'Saldo', format: 'money', total: true, width: 14 },
    ],
    run: () => callReport('report_customer_balances'),
  },
  {
    id: 'antiguedad-clientes',
    area: 'CUENTAS_CORRIENTES',
    name: 'Antigüedad de saldos — clientes',
    description: 'La deuda de cada cliente repartida por tramos de mora. A quién hay que reclamar.',
    usesPeriod: false,
    columns: [
      { key: 'customer_name', label: 'Cliente', width: 34 },
      { key: 'a_vencer', label: 'A vencer', format: 'money', total: true, width: 15 },
      { key: 'd1_30', label: '1 a 30', format: 'money', total: true, width: 15 },
      { key: 'd31_60', label: '31 a 60', format: 'money', total: true, width: 15 },
      { key: 'd61_90', label: '61 a 90', format: 'money', total: true, width: 15 },
      { key: 'd90_mas', label: 'Más de 90', format: 'money', total: true, width: 15 },
      { key: 'total', label: 'Total', format: 'money', total: true, width: 16 },
    ],
    run: () => callReport('report_customer_aging'),
  },
  {
    id: 'saldos-proveedores',
    area: 'CUENTAS_CORRIENTES',
    name: 'Composición de saldos — proveedores',
    description:
      'Qué comprobantes forman el saldo con cada proveedor. Las notas de crédito figuran en negativo.',
    usesPeriod: false,
    columns: [
      { key: 'supplier_name', label: 'Proveedor', width: 30 },
      { key: 'comprobante', label: 'Comprobante', width: 24 },
      { key: 'issue_date', label: 'Emisión', format: 'date', width: 12 },
      { key: 'due_date', label: 'Vencimiento', format: 'date', width: 12 },
      { key: 'dias_vencido', label: 'Días', format: 'integer', width: 8 },
      { key: 'total_amount', label: 'Total', format: 'money', width: 14 },
      { key: 'settled_amount', label: 'Pagado', format: 'money', width: 14 },
      { key: 'balance', label: 'Saldo', format: 'money', total: true, width: 14 },
    ],
    run: () => callReport('report_supplier_balances'),
  },
  {
    id: 'antiguedad-proveedores',
    area: 'CUENTAS_CORRIENTES',
    name: 'Antigüedad de saldos — proveedores',
    description:
      'Lo que se le debe a cada proveedor por tramos. Las notas de crédito van enteras a "a vencer", en negativo.',
    usesPeriod: false,
    columns: [
      { key: 'supplier_name', label: 'Proveedor', width: 34 },
      { key: 'a_vencer', label: 'A vencer', format: 'money', total: true, width: 15 },
      { key: 'd1_30', label: '1 a 30', format: 'money', total: true, width: 15 },
      { key: 'd31_60', label: '31 a 60', format: 'money', total: true, width: 15 },
      { key: 'd61_90', label: '61 a 90', format: 'money', total: true, width: 15 },
      { key: 'd90_mas', label: 'Más de 90', format: 'money', total: true, width: 15 },
      { key: 'total', label: 'Total', format: 'money', total: true, width: 16 },
    ],
    run: () => callReport('report_supplier_aging'),
  },

  // ── Impositivos ──────────────────────────────────────────────────
  {
    id: 'libro-iva-ventas',
    area: 'IMPOSITIVO',
    name: 'Libro IVA Ventas',
    description: 'Comprobantes emitidos en el período, con neto e IVA discriminados por comprobante.',
    usesPeriod: true,
    columns: [
      { key: 'issue_date', label: 'Fecha', format: 'date', width: 12 },
      { key: 'tipo', label: 'Tipo', width: 14 },
      { key: 'comprobante', label: 'Comprobante', width: 20 },
      { key: 'razon_social', label: 'Razón social', width: 30 },
      { key: 'cuit', label: 'CUIT', width: 14 },
      { key: 'condicion_iva', label: 'Cond. IVA', width: 20 },
      { key: 'neto', label: 'Neto', format: 'money', total: true, width: 14 },
      { key: 'iva', label: 'IVA', format: 'money', total: true, width: 14 },
      { key: 'total', label: 'Total', format: 'money', total: true, width: 14 },
    ],
    run: (p) => callReport('report_vat_sales', periodArgs(p)),
  },
  {
    id: 'libro-iva-compras',
    area: 'IMPOSITIVO',
    name: 'Libro IVA Compras',
    description:
      'Comprobantes recibidos en el período. Las notas de crédito figuran con todos sus importes en negativo.',
    usesPeriod: true,
    columns: [
      { key: 'issue_date', label: 'Fecha', format: 'date', width: 12 },
      { key: 'tipo', label: 'Tipo', width: 18 },
      { key: 'comprobante', label: 'Comprobante', width: 20 },
      { key: 'razon_social', label: 'Razón social', width: 30 },
      { key: 'cuit', label: 'CUIT', width: 14 },
      { key: 'condicion_iva', label: 'Cond. IVA', width: 20 },
      { key: 'neto_gravado', label: 'Neto gravado', format: 'money', total: true, width: 14 },
      { key: 'iva', label: 'IVA', format: 'money', total: true, width: 14 },
      { key: 'neto_exento', label: 'Neto exento', format: 'money', total: true, width: 14 },
      { key: 'neto_no_gravado', label: 'No gravado', format: 'money', total: true, width: 14 },
      { key: 'percepciones', label: 'Percepciones', format: 'money', total: true, width: 14 },
      { key: 'total', label: 'Total', format: 'money', total: true, width: 14 },
    ],
    run: (p) => callReport('report_vat_purchases', periodArgs(p)),
  },
  {
    id: 'retenciones-sufridas',
    area: 'IMPOSITIVO',
    name: 'Retenciones sufridas',
    description: 'Lo que los clientes retuvieron al pagarnos. Crédito fiscal a favor del taller.',
    usesPeriod: true,
    columns: [
      { key: 'receipt_date', label: 'Fecha', format: 'date', width: 12 },
      { key: 'recibo', label: 'Recibo', width: 16 },
      { key: 'cliente', label: 'Cliente', width: 28 },
      { key: 'impuesto', label: 'Impuesto', width: 22 },
      { key: 'jurisdiccion', label: 'Jurisdicción', width: 16 },
      { key: 'certificado', label: 'Certificado', width: 16 },
      { key: 'importe', label: 'Importe', format: 'money', total: true, width: 14 },
    ],
    run: (p) => callReport('report_retentions_suffered', periodArgs(p)),
  },
  {
    id: 'retenciones-practicadas',
    area: 'IMPOSITIVO',
    name: 'Retenciones practicadas',
    description: 'Lo que el taller retuvo a proveedores al pagarles. Deuda con ARCA a depositar.',
    usesPeriod: true,
    columns: [
      { key: 'payment_date', label: 'Fecha', format: 'date', width: 12 },
      { key: 'orden', label: 'Orden de pago', width: 16 },
      { key: 'proveedor', label: 'Proveedor', width: 28 },
      { key: 'cuit', label: 'CUIT', width: 14 },
      { key: 'impuesto', label: 'Impuesto', width: 22 },
      { key: 'jurisdiccion', label: 'Jurisdicción', width: 16 },
      { key: 'certificado', label: 'Certificado', width: 16 },
      { key: 'importe', label: 'Importe', format: 'money', total: true, width: 14 },
    ],
    run: (p) => callReport('report_retentions_applied', periodArgs(p)),
  },

  // ── Stock y tesorería ────────────────────────────────────────────
  {
    id: 'stock-valorizado',
    area: 'STOCK_TESORERIA',
    name: 'Stock valorizado',
    description: 'El inventario a precio de compra: es lo que costó, no lo que se vendería.',
    usesPeriod: false,
    columns: [
      { key: 'code', label: 'Código', width: 14 },
      { key: 'description', label: 'Descripción', width: 36 },
      { key: 'stock', label: 'Stock', format: 'number', total: true, width: 10 },
      { key: 'precio_compra', label: 'P. compra', format: 'money', width: 14 },
      { key: 'valorizado', label: 'Valorizado', format: 'money', total: true, width: 16 },
      { key: 'precio_venta', label: 'P. venta', format: 'money', width: 14 },
      { key: 'proveedor', label: 'Prov. preferido', width: 22 },
    ],
    run: () => callReport('report_stock_valued'),
  },
  {
    id: 'stock-sin-movimiento',
    area: 'STOCK_TESORERIA',
    name: 'Artículos sin movimiento',
    description: 'Tienen stock pero no se facturaron en el período: capital inmovilizado.',
    usesPeriod: true,
    columns: [
      { key: 'code', label: 'Código', width: 14 },
      { key: 'description', label: 'Descripción', width: 34 },
      { key: 'stock', label: 'Stock', format: 'number', total: true, width: 10 },
      { key: 'precio_compra', label: 'P. compra', format: 'money', width: 14 },
      { key: 'valorizado', label: 'Valorizado', format: 'money', total: true, width: 16 },
      { key: 'ultima_venta', label: 'Última venta', format: 'date', width: 14 },
    ],
    run: (p) => callReport('report_idle_stock', periodArgs(p)),
  },
  {
    id: 'precios-desactualizados',
    area: 'STOCK_TESORERIA',
    name: 'Precios desactualizados',
    description: 'Artículos ordenados por cuánto hace que no cambia su precio, de más viejo a más nuevo.',
    usesPeriod: false,
    columns: [
      { key: 'code', label: 'Código', width: 14 },
      { key: 'description', label: 'Descripción', width: 34 },
      { key: 'proveedor', label: 'Prov. preferido', width: 22 },
      { key: 'precio_compra', label: 'P. compra', format: 'money', width: 14 },
      { key: 'precio_venta', label: 'P. venta', format: 'money', width: 14 },
      { key: 'actualizado', label: 'Últ. cambio', format: 'date', width: 14 },
      { key: 'dias_sin_cambiar', label: 'Días', format: 'integer', width: 8 },
    ],
    run: () => callReport('report_stale_prices'),
  },
  {
    id: 'libro-caja',
    area: 'STOCK_TESORERIA',
    name: 'Libro de caja',
    description: 'Movimientos de tesorería del período, una fila por partida.',
    usesPeriod: true,
    columns: [
      { key: 'movement_date', label: 'Fecha', format: 'date', width: 12 },
      { key: 'comprobante', label: 'Comprobante', width: 14 },
      { key: 'tipo', label: 'Tipo', width: 14 },
      { key: 'detalle', label: 'Detalle', width: 30 },
      { key: 'concepto', label: 'Concepto', width: 18 },
      { key: 'beneficiario', label: 'Beneficiario', width: 20 },
      { key: 'medio', label: 'Medio', width: 18 },
      { key: 'ingreso', label: 'Ingreso', format: 'money', total: true, width: 14 },
      { key: 'egreso', label: 'Egreso', format: 'money', total: true, width: 14 },
    ],
    run: (p) => callReport('report_cash_book', periodArgs(p)),
  },
  {
    id: 'arqueo',
    area: 'STOCK_TESORERIA',
    name: 'Arqueo por medio de pago',
    description: 'Saldo actual de cada caja, cuenta y de la cartera de cheques.',
    usesPeriod: false,
    columns: [
      { key: 'medio', label: 'Medio de pago', width: 26 },
      { key: 'tipo', label: 'Tipo', width: 16 },
      { key: 'saldo_inicial', label: 'Saldo inicial', format: 'money', total: true, width: 16 },
      { key: 'movimientos', label: 'Movimientos', format: 'money', total: true, width: 16 },
      { key: 'saldo', label: 'Saldo', format: 'money', total: true, width: 16 },
    ],
    run: () => callReport('report_cash_count'),
  },
  {
    id: 'cheques-cartera',
    area: 'STOCK_TESORERIA',
    name: 'Cheques en cartera',
    description: 'Valores en mano por fecha de cobro. Los depositados siguen contando: el riesgo sigue siendo del taller hasta que el banco acredita.',
    usesPeriod: false,
    columns: [
      { key: 'due_date', label: 'Vence', format: 'date', width: 12 },
      { key: 'dias', label: 'Días', format: 'integer', width: 8 },
      { key: 'numero', label: 'Número', width: 14 },
      { key: 'banco', label: 'Banco', width: 22 },
      { key: 'librador', label: 'Librador', width: 24 },
      { key: 'estado', label: 'Estado', width: 14 },
      { key: 'depositado_en', label: 'Depositado en', width: 20 },
      { key: 'importe', label: 'Importe', format: 'money', total: true, width: 14 },
    ],
    run: () => callReport('report_checks_portfolio'),
  },

  // ── Operaciones de taller ────────────────────────────────────────
  {
    id: 'tiempos-por-etapa',
    area: 'OPERACIONES',
    name: 'Tiempos por etapa',
    description:
      'Cuánto duró cada tramo de OT por estado, sector y empleado, para detectar cuellos de botella y horas muertas.',
    usesPeriod: true,
    columns: [
      { key: 'status_label', label: 'Estado', width: 18 },
      { key: 'sector', label: 'Sector', width: 18 },
      { key: 'employee_name', label: 'Empleado', width: 22 },
      { key: 'assignments', label: 'Tramos', format: 'integer', total: true, width: 10 },
      { key: 'avg_hours', label: 'Horas prom.', format: 'number', width: 12 },
      { key: 'total_hours', label: 'Horas totales', format: 'number', total: true, width: 14 },
    ],
    run: (p) => callReport('report_stage_times', periodArgs(p)),
  },
  {
    id: 'rentabilidad-ot',
    area: 'OPERACIONES',
    name: 'Rentabilidad por OT',
    description:
      'Margen bruto real de cada OT facturada: lo cobrado contra el costo histórico de los repuestos y el costo de las horas trabajadas.',
    usesPeriod: true,
    columns: [
      { key: 'ot_number', label: 'OT', width: 12 },
      { key: 'cliente', label: 'Cliente', width: 26 },
      { key: 'fecha_factura', label: 'Fecha', format: 'date', width: 12 },
      { key: 'ingreso', label: 'Ingreso', format: 'money', total: true, width: 14 },
      { key: 'costo_repuestos', label: 'Costo repuestos', format: 'money', total: true, width: 16 },
      { key: 'costo_mano_obra', label: 'Costo mano de obra', format: 'money', total: true, width: 16 },
      { key: 'costo_total', label: 'Costo total', format: 'money', total: true, width: 14 },
      { key: 'margen', label: 'Margen $', format: 'money', total: true, width: 14 },
      { key: 'margen_pct', label: 'Margen %', format: 'number', width: 10 },
    ],
    run: (p) => callReport('report_work_order_margin', periodArgs(p)),
  },
];

export function findReport(id: string): ReportDefinition | undefined {
  return REPORTS.find((r) => r.id === id);
}

// ===========================================================================
// Formato
// ===========================================================================

export function formatCell(value: unknown, format: ColumnFormat = 'text'): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (format) {
    case 'money':
      return `$ ${formatMoney(Number(value))}`;
    case 'number':
      return Number(value).toLocaleString('es-AR', { maximumFractionDigits: 2 });
    case 'integer':
      return Number(value).toLocaleString('es-AR', { maximumFractionDigits: 0 });
    case 'date':
      return formatDate(String(value));
    default:
      return String(value);
  }
}

export function isNumeric(format: ColumnFormat = 'text'): boolean {
  return format === 'money' || format === 'number' || format === 'integer';
}

/** Totales de las columnas marcadas. Se calculan sobre lo que se ve. */
export function computeTotals(
  rows: Record<string, unknown>[],
  columns: ReportColumn[]
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const column of columns) {
    if (!column.total) continue;
    totals[column.key] = rows.reduce((sum, row) => sum + (Number(row[column.key]) || 0), 0);
  }
  return totals;
}

// ===========================================================================
// Exportación a Excel
// ===========================================================================

/** Período legible para el encabezado de la planilla. */
function periodLabel(report: ReportDefinition, params: ReportParams): string {
  if (!report.usesPeriod) return `Al ${formatDate(todayLocal())}`;
  return `Período: ${formatDate(params.from)} al ${formatDate(params.to)}`;
}

/**
 * Escribe la planilla.
 *
 * Los importes van como NÚMEROS, no como texto: es el error más común al
 * exportar y el que arruina el archivo sin que se note hasta que alguien
 * intenta sumar una columna en Excel.
 *
 * Sin negritas ni colores: la edición comunitaria de SheetJS no escribe
 * estilos. Se compensa con filas separadoras y con la fila de totales.
 */
export function exportReportToExcel(
  report: ReportDefinition,
  rows: Record<string, unknown>[],
  params: ReportParams
): void {
  const totals = computeTotals(rows, report.columns);
  const hasTotals = report.columns.some((c) => c.total);

  const matrix: unknown[][] = [
    [report.name],
    [periodLabel(report, params)],
    [`Generado el ${formatDate(todayLocal())}`],
    [],
    report.columns.map((c) => c.label),
  ];

  for (const row of rows) {
    matrix.push(
      report.columns.map((column) => {
        const value = row[column.key];
        if (value === null || value === undefined) return isNumeric(column.format) ? 0 : '';
        if (isNumeric(column.format)) return Number(value);
        if (column.format === 'date') return formatDate(String(value));
        return String(value);
      })
    );
  }

  if (hasTotals && rows.length > 0) {
    matrix.push([]);
    matrix.push(
      report.columns.map((column, index) => {
        if (column.total) return totals[column.key];
        return index === 0 ? 'TOTALES' : '';
      })
    );
  }

  const sheet = XLSX.utils.aoa_to_sheet(matrix);
  sheet['!cols'] = report.columns.map((c) => ({ wch: c.width ?? 16 }));

  // El formato numérico se aplica celda por celda: SheetJS no tiene estilos de
  // columna, así que hay que recorrer el rango.
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  for (let r = 4; r <= range.e.r; r++) {
    report.columns.forEach((column, c) => {
      if (!isNumeric(column.format)) return;
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === 'n') {
        cell.z = column.format === 'integer' ? '#,##0' : '#,##0.00';
      }
    });
  }

  const book = XLSX.utils.book_new();
  // Excel no admite más de 31 caracteres ni algunos símbolos en el nombre de
  // una hoja, y rechaza el archivo entero si se pasa.
  const sheetName = report.name.replace(/[\\/?*[\]:]/g, '').slice(0, 31);
  XLSX.utils.book_append_sheet(book, sheet, sheetName);

  const stamp = report.usesPeriod ? `${params.from}_${params.to}` : todayLocal();
  XLSX.writeFile(book, `${report.id}_${stamp}.xlsx`);
}

/** Traduce errores de base a mensajes accionables para el usuario. */
export function describeReportError(message: string): string {
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de informes en la base (supabase/reports.sql).';
  }
  return message;
}
