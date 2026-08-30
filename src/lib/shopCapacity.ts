import { supabase } from '@/src/lib/supabase';
import { WORKPLACES, type Workplace } from '@/src/lib/employees';

export interface WorkplaceCapacity {
  workplace: Workplace;
  capacity: number;
}

/**
 * Cupo configurado por sector. Siempre devuelve los WORKPLACES conocidos, en
 * ese orden — si a algún sector todavía no le llegó la fila (no debería
 * pasar, viene sembrada), se completa con cupo 1 en vez de romper la vista.
 */
export async function fetchWorkplaceCapacities(): Promise<WorkplaceCapacity[]> {
  const { data, error } = await supabase.from('workplace_capacity').select('workplace, capacity');
  if (error) throw error;

  const byWorkplace = new Map((data ?? []).map((r: any) => [r.workplace as Workplace, Number(r.capacity)]));
  return WORKPLACES.map((workplace) => ({ workplace, capacity: byWorkplace.get(workplace) ?? 1 }));
}

export async function updateWorkplaceCapacity(workplace: Workplace, capacity: number): Promise<void> {
  const { error } = await supabase.from('workplace_capacity').update({ capacity }).eq('workplace', workplace);
  if (error) throw error;
}

export interface ShopOccupancyRow {
  workOrderId: string;
  workOrderNumber: string;
  customerName: string;
  vehicleLabel: string;
  workplace: Workplace | null;
  employeeName: string | null;
  statusLabel: string;
  statusColor: string;
  estimatedDeliveryDate: string | null;
  daysInShop: number;
  createdAt: string;
}

/**
 * Una fila por OT activa (no terminal). Sale de work_orders con el sector
 * del empleado asignado embebido — no hay una tabla de ocupación propia, la
 * ocupación de cada sector es simplemente contar estas filas agrupadas por
 * workplace.
 */
export async function fetchShopOccupancy(): Promise<ShopOccupancyRow[]> {
  const { data, error } = await supabase
    .from('work_orders')
    .select(
      `id, number, created_at, estimated_delivery_date,
       status:work_order_statuses(label, color, is_terminal),
       customer:customers(name),
       vehicle:vehicles(brand, model, license_plate),
       employee:employees(name, workplace)`
    )
    .order('created_at', { ascending: true });

  if (error) throw error;

  const now = Date.now();
  return (data ?? [])
    .filter((row: any) => !row.status.is_terminal)
    .map((row: any) => ({
      workOrderId: row.id,
      workOrderNumber: row.number,
      customerName: row.customer?.name ?? '—',
      vehicleLabel: [row.vehicle?.brand, row.vehicle?.model].filter(Boolean).join(' ') || '—',
      workplace: row.employee?.workplace ?? null,
      employeeName: row.employee?.name ?? null,
      statusLabel: row.status.label,
      statusColor: row.status.color,
      estimatedDeliveryDate: row.estimated_delivery_date,
      daysInShop: Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 86_400_000)),
      createdAt: row.created_at,
    }));
}
