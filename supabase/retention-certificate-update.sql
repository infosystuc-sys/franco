-- ===========================================================================
-- Cargar el comprobante de una retención pendiente
-- ===========================================================================
-- Migración: retention-certificate-update
--
-- receipt_values no tiene políticas de escritura (se escribe solo desde
-- save_receipt): esta es la otra mitad de "Gestión de retenciones
-- pendientes" — cuando el comprobante finalmente llega, así sale de la
-- lista de pendientes sin abrir una puerta de escritura directa a la tabla.
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de retention-claims.sql.

create or replace function public.set_retention_certificate(
  p_receipt_value_id uuid,
  p_certificate_number text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value receipt_values%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_certificate_number), '') = '' then
    raise exception 'Indicá el número de comprobante.';
  end if;

  select * into v_value from receipt_values where id = p_receipt_value_id;
  if not found then
    raise exception 'La retención no existe.';
  end if;
  if v_value.kind <> 'RETENCION' then
    raise exception 'Ese valor no es una retención.';
  end if;

  update receipt_values
     set certificate_number = trim(p_certificate_number)
   where id = p_receipt_value_id;
end;
$$;

revoke all on function public.set_retention_certificate(uuid, text) from public, anon;
grant execute on function public.set_retention_certificate(uuid, text) to authenticated;
