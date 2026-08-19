import { supabase } from '@/src/lib/supabase';

export type NotificationKind = 'LINK_SEGUIMIENTO' | 'CAMBIO_ESTADO' | 'COTIZACION' | 'FACTURA';
export type NotificationStatus = 'PENDIENTE' | 'ENVIADO' | 'FALLIDO' | 'DESCARTADO';

export const KIND_LABELS: Record<NotificationKind, string> = {
  LINK_SEGUIMIENTO: 'Link de seguimiento',
  CAMBIO_ESTADO: 'Cambio de estado',
  COTIZACION: 'Presupuesto',
  FACTURA: 'Factura',
};

export const STATUS_LABELS: Record<NotificationStatus, string> = {
  PENDIENTE: 'Pendiente',
  ENVIADO: 'Enviado',
  FALLIDO: 'Fallido',
  DESCARTADO: 'Descartado',
};

export const STATUS_STRIP: Record<NotificationStatus, string> = {
  PENDIENTE: '#e07b1a',
  ENVIADO: '#2e7d32',
  FALLIDO: '#c62828',
  DESCARTADO: '#9a9a9a',
};

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  status: NotificationStatus;
  toPhone: string | null;
  body: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  customerName: string | null;
  workOrderNumber: string | null;
  quotationNumber: string | null;
}

export async function fetchNotifications(limit = 100): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select(
      `id, kind, status, to_phone, body, attempts, last_error, created_at, sent_at,
       customer:customers(name),
       work_order:work_orders(number),
       quotation:quotations(number)`
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    toPhone: row.to_phone,
    body: row.body,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    customerName: row.customer?.name ?? null,
    workOrderNumber: row.work_order?.number ?? null,
    quotationNumber: row.quotation?.number ?? null,
  }));
}

export interface WhatsappSettings {
  enabled: boolean;
  testMode: boolean;
  testPhone: string;
  publicBaseUrl: string;
}

export async function fetchWhatsappSettings(): Promise<WhatsappSettings> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['whatsapp_enabled', 'whatsapp_test_mode', 'whatsapp_test_phone', 'public_base_url']);
  if (error) throw error;

  const map: Record<string, string> = {};
  (data ?? []).forEach((r: any) => { map[r.key] = r.value; });

  return {
    enabled: map.whatsapp_enabled === 'true',
    testMode: map.whatsapp_test_mode === 'true',
    testPhone: map.whatsapp_test_phone ?? '',
    publicBaseUrl: map.public_base_url ?? '',
  };
}

export async function updateSetting(key: string, value: string): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key);
  if (error) throw error;
}
