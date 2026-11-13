import { supabase } from '@/src/lib/supabase';

/**
 * Recordatorios automáticos por WhatsApp: presupuestos sin respuesta,
 * trabajos terminados sin retirar y saldos vencidos. Los encola una vez por
 * día la base (enviar_recordatorios, ver
 * supabase/migrations/20261113_recordatorios_automaticos.sql); acá se prenden
 * y se configuran. Viven en app_settings, clave 'recordatorios'.
 */

export interface ConfigRecordatorios {
  cotizaciones: { activo: boolean; cada: number; maximo: number };
  terminados: { activo: boolean; cada: number; maximo: number };
  saldos: { activo: boolean; cada: number; minimo: number };
}

export const RECORDATORIOS_POR_DEFECTO: ConfigRecordatorios = {
  cotizaciones: { activo: false, cada: 3, maximo: 3 },
  terminados: { activo: false, cada: 2, maximo: 3 },
  saldos: { activo: false, cada: 7, minimo: 1000 },
};

const SIN_MIGRACION = 'Falta correr la migración 20261113_recordatorios_automaticos.sql en Supabase.';

/** null si la migración todavía no corrió (no existe la clave). */
export async function fetchConfigRecordatorios(): Promise<ConfigRecordatorios | null> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'recordatorios').maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const guardada = JSON.parse(data.value) as Partial<ConfigRecordatorios>;
  return {
    cotizaciones: { ...RECORDATORIOS_POR_DEFECTO.cotizaciones, ...guardada.cotizaciones },
    terminados: { ...RECORDATORIOS_POR_DEFECTO.terminados, ...guardada.terminados },
    saldos: { ...RECORDATORIOS_POR_DEFECTO.saldos, ...guardada.saldos },
  };
}

export async function guardarConfigRecordatorios(config: ConfigRecordatorios): Promise<void> {
  const { data, error } = await supabase
    .from('app_settings')
    .update({ value: JSON.stringify(config), updated_at: new Date().toISOString() })
    .eq('key', 'recordatorios')
    .select('key');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error(SIN_MIGRACION);
}

/** Corre la tanda ahora, sin esperar al horario. Devuelve cuántos encoló de cada uno. */
export async function enviarRecordatoriosAhora(): Promise<{ cotizaciones: number; terminados: number; saldos: number }> {
  const { data, error } = await supabase.rpc('enviar_recordatorios');
  if (error) {
    if (/enviar_recordatorios|schema cache/i.test(error.message)) throw new Error(SIN_MIGRACION);
    throw error;
  }
  return data as { cotizaciones: number; terminados: number; saldos: number };
}
