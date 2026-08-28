-- ===========================================================================
-- Envío de facturas por mail y WhatsApp (adjunto en PDF)
-- ===========================================================================
-- Migración: invoice_sending_gmail_credential
--
-- La clave de aplicación de Gmail se carga desde Configuración pero nunca se
-- guarda en una tabla ni viaja de vuelta al navegador: se guarda en la
-- bóveda de Supabase (mismo patrón que cron_secret en whatsapp.sql) bajo el
-- nombre 'gmail_app_password'. set_gmail_credential la escribe (solo admin);
-- has_gmail_credential dice si ya hay una cargada, sin revelarla; y
-- read_gmail_credential la devuelve — pero queda sin permiso para
-- authenticated/anon, así que solo la puede llamar la Edge Function
-- enviar-factura con la clave de servicio (mismo esquema de grants que
-- despachar_whatsapp: revocada para todos salvo postgres/service_role).

create or replace function public.set_gmail_credential(p_password text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if not is_admin() then
    raise exception 'Solo un administrador puede cargar la credencial de Gmail.';
  end if;

  if p_password is null or trim(p_password) = '' then
    raise exception 'La credencial no puede estar vacía.';
  end if;

  if exists (select 1 from vault.secrets where name = 'gmail_app_password') then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'gmail_app_password'),
      trim(p_password)
    );
  else
    perform vault.create_secret(trim(p_password), 'gmail_app_password', 'Clave de aplicación de Gmail para enviar facturas.');
  end if;
end;
$$;

create or replace function public.has_gmail_credential()
returns boolean
language sql
security definer
set search_path = public, vault
as $$
  select exists (select 1 from vault.secrets where name = 'gmail_app_password');
$$;

create or replace function public.read_gmail_credential()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'gmail_app_password';
$$;

revoke execute on function public.set_gmail_credential(text) from public, anon;
revoke execute on function public.has_gmail_credential() from public, anon;
revoke execute on function public.read_gmail_credential() from public, anon, authenticated;

grant execute on function public.set_gmail_credential(text) to authenticated;
grant execute on function public.has_gmail_credential() to authenticated;
-- read_gmail_credential: sin grant a authenticated a propósito. Solo la
-- llama la Edge Function enviar-factura con la clave de servicio.
