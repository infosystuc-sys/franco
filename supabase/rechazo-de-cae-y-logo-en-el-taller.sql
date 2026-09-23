-- ===========================================================================
-- El motivo del rechazo de ARCA, y el logo para los comprobantes sin sesión
-- ===========================================================================
-- Migración sugerida: rechazo_de_cae_y_logo
--
-- Dos cosas sin relación entre sí, juntas porque son chicas.
--
-- 1. Cuando ARCA rechaza, el motivo tiene que sobrevivir. Hasta ahora vivía en
--    la memoria de la pantalla: quien cerraba la factura y volvía se
--    encontraba con una pendiente y ninguna explicación de por qué. El motivo
--    es justamente lo que hay que corregir para reintentar.
--
-- 2. datos_del_taller() suma el logo. Es la que sirve el encabezado a quien no
--    tiene sesión —el cliente que abre el link del presupuesto—, así que sin
--    esto el logo configurable no llega a la cotización.

-- ---------------------------------------------------------------------------
-- 1. Por qué ARCA rechazó
-- ---------------------------------------------------------------------------
alter table invoices
  add column if not exists cae_rechazo text,
  add column if not exists cae_rechazado_at timestamptz;

comment on column invoices.cae_rechazo is
  'Motivo del último rechazo de ARCA. Se borra cuando el CAE finalmente sale.';

-- ---------------------------------------------------------------------------
-- 2. Anotar el rechazo
-- ---------------------------------------------------------------------------
-- Solo anota. No cambia el estado ni el número a propósito: la factura sigue
-- en PENDIENTE_CAE para que el reintento use el mismo número, que es lo que
-- evita el hueco en la numeración.
create or replace function public.registrar_rechazo_cae(
  p_invoice_id uuid,
  p_motivo text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status invoice_status;
begin
  if not (is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'No autorizado.';
  end if;

  select status into v_status from invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'La factura no existe.';
  end if;
  if v_status <> 'PENDIENTE_CAE' then
    raise exception 'La factura no está esperando un CAE: está %.', v_status;
  end if;

  update invoices
     set cae_rechazo = nullif(trim(coalesce(p_motivo, '')), ''),
         cae_rechazado_at = now()
   where id = p_invoice_id;
end;
$$;

revoke all on function public.registrar_rechazo_cae(uuid, text) from public, anon;
grant execute on function public.registrar_rechazo_cae(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Un CAE otorgado borra el rechazo anterior
-- ---------------------------------------------------------------------------
-- Si no, una factura emitida seguiría mostrando el motivo del intento fallido
-- y parecería que algo quedó mal cuando ya está resuelto.
create or replace function public.confirmar_cae(
  p_invoice_id uuid,
  p_cae text,
  p_cae_due_date date,
  p_simulado boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status invoice_status;
  v_cae text := trim(coalesce(p_cae, ''));
begin
  if not (is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Solo un administrador puede confirmar el CAE de una factura.';
  end if;

  if v_cae !~ '^\d{14}$' then
    raise exception 'El CAE tiene que ser de 14 dígitos.';
  end if;

  if p_cae_due_date is null then
    raise exception 'El CAE tiene que venir con su fecha de vencimiento.';
  end if;

  select status into v_status
    from invoices
   where id = p_invoice_id
   for update;

  if not found then
    raise exception 'La factura no existe.';
  end if;

  if v_status <> 'PENDIENTE_CAE' then
    raise exception 'La factura no está esperando un CAE: está %.', v_status;
  end if;

  update invoices
     set status           = 'EMITIDA',
         cae              = v_cae,
         cae_due_date     = p_cae_due_date,
         cae_simulated    = coalesce(p_simulado, false),
         cae_rechazo      = null,
         cae_rechazado_at = null
   where id = p_invoice_id;
end;
$$;

revoke all on function public.confirmar_cae(uuid, text, date, boolean) from public, anon;
grant execute on function public.confirmar_cae(uuid, text, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. datos_del_taller() devuelve el logo
-- ---------------------------------------------------------------------------
-- Cambia la lista de columnas que devuelve, y eso no se puede hacer con
-- "create or replace": hay que soltarla y volver a crearla. Al soltarla se
-- pierden los permisos, así que se vuelven a dar abajo, iguales a como
-- estaban: anon incluido, porque el presupuesto se abre sin sesión.
drop function if exists public.datos_del_taller();

create function public.datos_del_taller()
returns table(
  legal_name text, trade_name text, tax_id text, tax_condition text,
  gross_income text, activity_start_date date,
  address_street text, address_city text, address_state text, address_zip text,
  phone text, email text, logo text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    legal_name, trade_name, tax_id, tax_condition, gross_income,
    activity_start_date, address_street, address_city, address_state,
    address_zip, phone, email, logo
  from company_settings;
$$;

grant execute on function public.datos_del_taller() to public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_name = 'invoices' and column_name in ('cae_rechazo', 'cae_rechazado_at')) as columnas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'registrar_rechazo_cae') as funcion_rechazo,
  (select logo is null from datos_del_taller()) as taller_sin_logo;
