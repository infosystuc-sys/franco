-- ===========================================================================
-- La IA predeterminada pasa a ser Anthropic
-- ===========================================================================
-- Migración sugerida: ia_predeterminada_anthropic
--
-- El valor guardado decía GEMINI, y el código también tomaba Gemini cuando no
-- había nada elegido. Las dos cosas cambian a Anthropic.
--
-- Es por medición, no por preferencia. Leyendo el mismo comprobante contra la
-- misma clave, Gemini devolvió 503 por saturación, 429 por cuota agotada y
-- tiempos de 3,6 · 8,0 · 49,3 · 55,3 · 75,6 segundos —ya con el pensamiento
-- apagado, así que no era eso—. Anthropic venía resolviendo parejo en el orden
-- de los 27 segundos.
--
-- Para algo que alguien está esperando en pantalla, importa más que tarde
-- siempre lo mismo que que a veces tarde poco: 3 segundos una vez y 75 la
-- siguiente se vive como que la app se colgó.
--
-- Gemini no queda afuera: sigue como respaldo automático si Anthropic falla, y
-- se puede volver a elegir desde Configuración cuando su cuota se normalice.

insert into app_settings (key, value)
values ('ai_provider', 'ANTHROPIC')
on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select value as ia_predeterminada from app_settings where key = 'ai_provider';
