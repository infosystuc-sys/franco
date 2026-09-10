import { supabase } from '@/src/lib/supabase';

/**
 * Proveedor de lectura de comprobantes y sus claves.
 *
 * La clave nunca viaja al navegador: vive en ai_credentials, una tabla sin
 * policies que solo la llave de servicio —la que usa la Edge Function— puede
 * leer. Desde acá se carga, se borra y se consulta si está cargada, pero no
 * se puede recuperar. Por eso el formulario pide la clave entera cada vez que
 * se quiere cambiar, en vez de traerla para editarla.
 */

export type AiProvider = 'GEMINI' | 'ANTHROPIC';

export const AI_PROVIDERS: AiProvider[] = ['GEMINI', 'ANTHROPIC'];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  GEMINI: 'Gemini (Google)',
  ANTHROPIC: 'Claude (Anthropic)',
};

/** Dónde se saca cada clave, para no hacer buscar. */
export const AI_PROVIDER_CONSOLES: Record<AiProvider, string> = {
  GEMINI: 'aistudio.google.com/apikey',
  ANTHROPIC: 'console.anthropic.com',
};

export interface AiKeyStatus {
  provider: AiProvider;
  configurada: boolean;
  ultimos4: string | null;
  actualizada: string | null;
}

export async function fetchAiKeyStatus(): Promise<AiKeyStatus[]> {
  const { data, error } = await supabase.rpc('estado_claves_ia');
  if (error) throw error;
  return (data ?? []).map((fila: Record<string, unknown>) => ({
    provider: fila.provider as AiProvider,
    configurada: Boolean(fila.configurada),
    ultimos4: (fila.ultimos4 as string) ?? null,
    actualizada: (fila.actualizada as string) ?? null,
  }));
}

export async function saveAiKey(provider: AiProvider, apiKey: string): Promise<void> {
  const { error } = await supabase.rpc('guardar_clave_ia', {
    p_provider: provider,
    p_api_key: apiKey,
  });
  if (error) throw error;
}

export async function deleteAiKey(provider: AiProvider): Promise<void> {
  const { error } = await supabase.rpc('borrar_clave_ia', { p_provider: provider });
  if (error) throw error;
}

export async function fetchAiProvider(): Promise<AiProvider> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'ai_provider')
    .maybeSingle();
  if (error) throw error;
  return data?.value === 'ANTHROPIC' ? 'ANTHROPIC' : 'GEMINI';
}

export async function saveAiProvider(provider: AiProvider): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key: 'ai_provider', value: provider }, { onConflict: 'key' });
  if (error) throw error;
}
