-- Comprobantes de compra que llegan por correo.
--
-- Se configura una casilla de Gmail (Configuración → Correo de compras). Cada
-- 10 minutos la Edge Function leer-correo-compras revisa los mails sin leer
-- que tengan adjuntos, sube cada PDF (o foto) como borrador y lo manda a leer
-- con IA. Quedan en "Compras con IA" para revisar y confirmar, igual que los
-- que se suben a mano. El mail queda marcado como leído.
--
-- La clave de aplicación de Gmail va a la bóveda (vault), como la del envío
-- de facturas: nunca se puede leer desde el navegador.

-- De dónde salió cada borrador ("Correo: Proveedor X <...> — Asunto").
alter table public.purchase_invoice_extractions
  add column if not exists origen text;

-- ── Guardar la casilla ──────────────────────────────────────────────────────
-- La clave vacía deja la que estaba: así se puede cambiar el tipo o la
-- dirección sin volver a escribirla.
create or replace function public.set_correo_compras(p_email text, p_password text, p_tipo text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if not is_admin() then
    raise exception 'Solo un administrador puede configurar el correo de compras.';
  end if;
  if coalesce(trim(p_email), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'La dirección de correo no es válida.';
  end if;
  if p_tipo not in ('ARTICULOS', 'CONCEPTOS') then
    raise exception 'El tipo de compra tiene que ser ARTICULOS o CONCEPTOS.';
  end if;

  if coalesce(trim(p_password), '') <> '' then
    if exists (select 1 from vault.secrets where name = 'gmail_compras_app_password') then
      perform vault.update_secret(
        (select id from vault.secrets where name = 'gmail_compras_app_password'),
        replace(trim(p_password), ' ', '')
      );
    else
      perform vault.create_secret(
        replace(trim(p_password), ' ', ''),
        'gmail_compras_app_password',
        'Clave de aplicación de Gmail de la casilla que recibe comprobantes de compra.'
      );
    end if;
  elsif not exists (select 1 from vault.secrets where name = 'gmail_compras_app_password') then
    raise exception 'Falta la clave de aplicación de Gmail.';
  end if;

  insert into app_settings (key, value) values
    ('compras_correo', lower(trim(p_email))),
    ('compras_correo_tipo', p_tipo),
    -- A nombre de quién quedan los borradores que se leen solos.
    ('compras_correo_usuario', auth.uid()::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

-- Deja de revisar la casilla y borra la clave.
create or replace function public.borrar_correo_compras()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if not is_admin() then
    raise exception 'Solo un administrador puede configurar el correo de compras.';
  end if;
  delete from app_settings where key in ('compras_correo', 'compras_correo_tipo', 'compras_correo_usuario', 'compras_correo_ultima');
  delete from vault.secrets where name = 'gmail_compras_app_password';
end;
$$;

-- Lo que se muestra en Configuración: nunca la clave, solo si está cargada.
create or replace function public.correo_compras_configurado()
returns table (email text, tipo text, tiene_clave boolean, ultima_revision text)
language sql
security definer
set search_path = public, vault
as $$
  select
    (select value from app_settings where key = 'compras_correo'),
    coalesce((select value from app_settings where key = 'compras_correo_tipo'), 'ARTICULOS'),
    exists (select 1 from vault.secrets where name = 'gmail_compras_app_password'),
    (select value from app_settings where key = 'compras_correo_ultima')
  where is_admin();
$$;

-- Solo para la Edge Function, con la clave de servicio.
create or replace function public.read_correo_compras()
returns table (email text, password text, tipo text, usuario uuid)
language sql
security definer
set search_path = public, vault
as $$
  select
    (select value from app_settings where key = 'compras_correo'),
    (select decrypted_secret from vault.decrypted_secrets where name = 'gmail_compras_app_password'),
    coalesce((select value from app_settings where key = 'compras_correo_tipo'), 'ARTICULOS'),
    (select nullif(value, '')::uuid from app_settings where key = 'compras_correo_usuario');
$$;

revoke execute on function public.set_correo_compras(text, text, text) from public, anon;
revoke execute on function public.borrar_correo_compras() from public, anon;
revoke execute on function public.correo_compras_configurado() from public, anon;
revoke execute on function public.read_correo_compras() from public, anon, authenticated;
grant execute on function public.set_correo_compras(text, text, text) to authenticated;
grant execute on function public.borrar_correo_compras() to authenticated;
grant execute on function public.correo_compras_configurado() to authenticated;

-- ── El cron ─────────────────────────────────────────────────────────────────
-- Igual que el despachador de WhatsApp: llama a la función con el secreto
-- compartido (cron_secret). Sin casilla configurada no llama a nada.
create or replace function public.leer_correo_compras()
returns void
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_secreto text;
begin
  if not exists (select 1 from app_settings where key = 'compras_correo') then
    return;
  end if;
  select decrypted_secret into v_secreto from vault.decrypted_secrets where name = 'cron_secret';
  if v_secreto is null then
    raise warning 'No está cargado el secreto cron_secret en la bóveda.';
    return;
  end if;
  perform net.http_post(
    url := 'https://mnoqdqjhsylohlvuekfh.supabase.co/functions/v1/leer-correo-compras',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secreto),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

revoke execute on function public.leer_correo_compras() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'leer-correo-compras') then
    perform cron.unschedule('leer-correo-compras');
  end if;
  perform cron.schedule('leer-correo-compras', '*/10 * * * *', 'select public.leer_correo_compras()');
end $$;

notify pgrst, 'reload schema';
