-- ===========================================================================
-- Tarea programada (pg_cron)
-- ===========================================================================
-- Requiere la extensión pg_cron habilitada en el proyecto (Database →
-- Extensions en el dashboard de Supabase, o CREATE EXTENSION pg_cron;).
--
-- Despacha la cola de WhatsApp cada minuto. La función public.despachar_whatsapp()
-- ya está creada por 06-functions.sql; ESTE cron solo la dispara — el trabajo
-- real (leer app_settings, llamar a Evolution) vive en la función.
--
-- OJO: en la base original, esta función habla con Evolution API usando
-- variables de entorno que se leen en la Edge Function despachar-whatsapp
-- (no en esta función SQL) — este cron llama a una función que a su vez debe
-- ser reemplazada/coordinada con esa Edge Function. Ver el punto 6 del
-- documento principal (Edge Functions) antes de activar este cron: si se
-- activa sin las credenciales de Evolution configuradas, no manda nada, solo
-- deja mensajes marcados como fallidos.

SELECT cron.schedule(
  'despachar-whatsapp',
  '* * * * *',
  $$select public.despachar_whatsapp()$$
);
