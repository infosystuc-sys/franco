import { supabase } from '@/src/lib/supabase';

/**
 * Imputación de comprobantes.
 *
 * Imputar es aparear dos listas: lo que la parte tiene a favor —recibos con
 * plata a cuenta, notas de crédito sin aplicar, órdenes de pago— contra lo que
 * debe. Este módulo rehace ese apareo cuando quedó mal.
 *
 * No toca los comprobantes: el recibo sigue diciendo que entraron $ 100.000 y
 * por qué medio. Lo que cambia es contra qué factura se imputaron.
 *
 * La base recibe el cuadro completo, no las diferencias: la pantalla manda lo
 * que se ve. Así dos personas imputando a la vez no suman dos veces lo mismo.
 */

export type Circuito = 'VENTAS' | 'COMPRAS';

/** Un comprobante que cancela: factura del cliente, o comprobante del proveedor. */
export interface Deuda {
  id: string;
  fullNumber: string;
  issueDate: string;
  dueDate: string | null;
  totalAmount: number;
  /** Lo ya imputado por cualquier vía. */
  imputado: number;
}

/** Un comprobante a favor: recibo, nota de crédito, orden de pago. */
export interface Credito {
  id: string;
  fullNumber: string;
  fecha: string;
  totalAmount: number;
  /** De qué clase es, porque la base los guarda en tablas distintas. */
  clase: 'RECIBO' | 'NOTA_CREDITO' | 'ORDEN_PAGO';
  allocations: { deudaId: string; amount: number }[];
}

export interface CuentaDeLaParte {
  deudas: Deuda[];
  creditos: Credito[];
}

export async function fetchCuenta(
  circuito: Circuito,
  parteId: string
): Promise<CuentaDeLaParte> {
  const rpc = circuito === 'VENTAS' ? 'cuenta_del_cliente' : 'cuenta_del_proveedor';
  const arg = circuito === 'VENTAS' ? { p_customer_id: parteId } : { p_supplier_id: parteId };

  const { data, error } = await supabase.rpc(rpc, arg);
  if (error) throw error;
  const d = (data ?? {}) as any;

  if (circuito === 'VENTAS') {
    return {
      deudas: (d.facturas ?? []).map((f: any) => ({
        id: f.id,
        fullNumber: f.full_number,
        issueDate: f.issue_date,
        dueDate: f.due_date,
        totalAmount: Number(f.total_amount),
        imputado: Number(f.paid_amount) + Number(f.credited_amount),
      })),
      creditos: [
        ...(d.recibos ?? []).map((r: any) => mapCredito(r, 'RECIBO', r.receipt_date)),
        ...(d.notas ?? []).map((n: any) => mapCredito(n, 'NOTA_CREDITO', n.issue_date)),
      ],
    };
  }

  return {
    // Del lado de compras la nota de crédito es un comprobante más, con signo
    // negativo: no va en la columna de la izquierda sino acá, y se imputa
    // restando. Por eso se listan todos juntos.
    deudas: (d.comprobantes ?? [])
      .filter((c: any) => c.doc_type !== 'NOTA_CREDITO')
      .map((c: any) => ({
        id: c.id,
        fullNumber: c.full_number,
        issueDate: c.issue_date,
        dueDate: c.due_date,
        totalAmount: Number(c.total_amount),
        imputado: Number(c.settled_amount),
      })),
    creditos: [
      ...(d.ordenes ?? []).map((o: any) => ({
        id: o.id,
        fullNumber: o.full_number,
        fecha: o.payment_date,
        totalAmount: Number(o.total_amount),
        clase: 'ORDEN_PAGO' as const,
        allocations: (o.allocations ?? []).map((a: any) => ({
          deudaId: a.purchase_invoice_id,
          amount: Number(a.amount),
        })),
      })),
    ],
  };
}

function mapCredito(row: any, clase: Credito['clase'], fecha: string): Credito {
  return {
    id: row.id,
    fullNumber: row.full_number,
    fecha,
    totalAmount: Number(row.total_amount),
    clase,
    allocations: (row.allocations ?? []).map((a: any) => ({
      deudaId: a.invoice_id,
      amount: Number(a.amount),
    })),
  };
}

export async function guardarImputacion(
  circuito: Circuito,
  parteId: string,
  creditos: Credito[],
  motivo: string
): Promise<void> {
  if (circuito === 'VENTAS') {
    const recibos = creditos
      .filter((c) => c.clase === 'RECIBO')
      .flatMap((c) =>
        c.allocations
          .filter((a) => a.amount > 0)
          .map((a) => ({ receipt_id: c.id, invoice_id: a.deudaId, amount: a.amount }))
      );
    const notas = creditos
      .filter((c) => c.clase === 'NOTA_CREDITO')
      .flatMap((c) =>
        c.allocations
          .filter((a) => a.amount > 0)
          .map((a) => ({ credit_note_id: c.id, invoice_id: a.deudaId, amount: a.amount }))
      );

    const { error } = await supabase.rpc('imputar_ventas', {
      p_customer_id: parteId,
      p_recibos: recibos,
      p_notas: notas,
      p_motivo: motivo.trim() || null,
    });
    if (error) throw error;
    return;
  }

  const imputaciones = creditos.flatMap((c) =>
    c.allocations
      .filter((a) => a.amount !== 0)
      .map((a) => ({
        payment_order_id: c.id,
        purchase_invoice_id: a.deudaId,
        amount: a.amount,
      }))
  );

  const { error } = await supabase.rpc('imputar_compras', {
    p_supplier_id: parteId,
    p_imputaciones: imputaciones,
    p_motivo: motivo.trim() || null,
  });
  if (error) throw error;
}

export interface CambioDeImputacion {
  id: string;
  circuito: Circuito;
  parteNombre: string;
  motivo: string | null;
  createdAt: string;
  antes: unknown;
  despues: unknown;
}

export async function fetchHistorialImputacion(parteId: string): Promise<CambioDeImputacion[]> {
  const { data, error } = await supabase
    .from('imputacion_log')
    .select('id, circuito, parte_nombre, motivo, created_at, antes, despues')
    .eq('parte_id', parteId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    circuito: row.circuito,
    parteNombre: row.parte_nombre,
    motivo: row.motivo,
    createdAt: row.created_at,
    antes: row.antes,
    despues: row.despues,
  }));
}
