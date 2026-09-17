import { supabase } from '@/src/lib/supabase';

/**
 * El mecánico de una OT y su cuenta corriente.
 *
 * Cobra por sobrefacturación: al cotizar se define un monto (o un porcentaje)
 * que se reparte DENTRO de los precios de los renglones. El cliente ve precios
 * más altos y ninguna línea delata el recargo; esa diferencia es lo que le
 * queda al mecánico.
 *
 * Se le acredita al FACTURAR la orden, no al cotizar: hasta que no hay
 * comprobante no hay nada devengado. Anular la factura lo revierte.
 *
 * Todo esto lo ve solo un admin — son pagos a personas y renglones inflados.
 */

export type MechanicEntryKind = 'SOBREFACTURACION' | 'PAGO' | 'AJUSTE';

export const MECHANIC_ENTRY_LABELS: Record<MechanicEntryKind, string> = {
  SOBREFACTURACION: 'Sobrefacturación',
  PAGO: 'Pago',
  AJUSTE: 'Ajuste',
};

export interface MechanicBalance {
  mechanicId: string;
  mechanicName: string;
  devengado: number;
  pagado: number;
  saldo: number;
  movimientos: number;
}

export interface MechanicEntry {
  id: string;
  kind: MechanicEntryKind;
  amount: number;
  entryDate: string;
  notes: string | null;
  workOrderNumber: string | null;
  invoiceFullNumber: string | null;
}

/** Saldo por mecánico. Positivo es lo que se le debe. */
export async function fetchMechanicBalances(): Promise<MechanicBalance[]> {
  const { data, error } = await supabase.rpc('saldos_de_mecanicos');
  if (error) throw error;
  return ((data ?? []) as any[]).map((row) => ({
    mechanicId: row.mechanic_id,
    mechanicName: row.mechanic_name,
    devengado: Number(row.devengado),
    pagado: Number(row.pagado),
    saldo: Number(row.saldo),
    movimientos: Number(row.movimientos),
  }));
}

/** El detalle de la cuenta de un mecánico, del movimiento más nuevo al más viejo. */
export async function fetchMechanicEntries(mechanicId: string): Promise<MechanicEntry[]> {
  const { data, error } = await supabase
    .from('mechanic_account_entries')
    .select(
      `id, kind, amount, entry_date, notes,
       work_order:work_orders(number),
       invoice:invoices(full_number)`
    )
    .eq('mechanic_id', mechanicId)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;

  return ((data ?? []) as any[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    amount: Number(row.amount),
    entryDate: row.entry_date,
    notes: row.notes,
    workOrderNumber: row.work_order?.number ?? null,
    invoiceFullNumber: row.invoice?.full_number ?? null,
  }));
}

export async function pagarAMecanico(
  mechanicId: string,
  monto: number,
  fecha: string,
  notas: string
): Promise<void> {
  const { error } = await supabase.rpc('pagar_a_mecanico', {
    p_mechanic_id: mechanicId,
    p_monto: monto,
    p_fecha: fecha,
    p_notas: notas.trim() || null,
  });
  if (error) throw error;
}

/**
 * Qué recargo se le pidió a la orden. Se usa para mostrarlo antes de cotizar
 * de nuevo: cotizar otra vez reemplaza el recargo, no lo suma.
 */
export interface Sobrefacturacion {
  /** Monto fijo, o null si se define por porcentaje. */
  monto: number | null;
  /** Porcentaje sobre el neto de los renglones, o null si es monto fijo. */
  porcentaje: number | null;
}

/**
 * Cuánto se va a repartir según lo elegido. La base recalcula esto mismo al
 * aplicarlo; acá es para mostrarle el número a quien lo está definiendo.
 */
export function montoDeSobrefacturacion(neto: number, valor: Sobrefacturacion): number {
  if (valor.monto !== null) return Math.max(0, valor.monto);
  if (valor.porcentaje !== null) return Math.round(neto * valor.porcentaje) / 100;
  return 0;
}
