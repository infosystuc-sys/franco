-- ===========================================================================
-- Proveedor de lectura de comprobantes y sus claves
-- ===========================================================================
-- Migración: claves_de_ia
--
-- La lectura de facturas de compra se hacía siempre con Gemini, con la clave
-- guardada como secreto de la función. Cuando el modelo se satura —503, "high
-- demand"— no hay a dónde ir. Ahora se puede elegir proveedor y cargar la
-- clave desde Configuración, sin tocar secretos del servidor.
--
-- ── Por qué una tabla aparte y no app_settings ────────────────────────────
-- app_settings tiene policy de SELECT para admins: cualquier admin logueado
-- puede leer su contenido DESDE EL NAVEGADOR. Una clave de API ahí queda a un
-- fetch de distancia de cualquiera que consiga una sesión de admin, y las
-- claves de IA se cobran por uso.
--
-- Esta tabla NO tiene ninguna policy: con RLS activo y sin policies, nadie con
-- sesión lee ni escribe. Solo la llave de servicio —que usa la Edge Function,
-- del lado del servidor— pasa por encima de RLS. El admin carga y borra por
-- funciones que validan su rol, y la pantalla nunca recibe la clave completa:
-- solo si está cargada y sus últimos cuatro caracteres, para reconocerla.

create table public.ai_credentials (
  provider text primary key check (provider in ('GEMINI', 'ANTHROPIC')),
  api_key text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.ai_credentials enable row level security;
-- A propósito sin policies. Ver el comentario de arriba.

revoke all on public.ai_credentials from anon, authenticated;

-- ── Qué proveedor usar ────────────────────────────────────────────────────
-- Esto sí va en app_settings: es una preferencia, no un secreto.
insert into public.app_settings (key, value)
values ('ai_provider', 'GEMINI')
on conflict (key) do nothing;

-- ── Con cuál se leyó cada comprobante ─────────────────────────────────────
-- Se guarda por comprobante y no solo la preferencia actual: si la lectura se
-- resolvió con el proveedor de respaldo, quien revisa tiene que poder ver con
-- cuál se leyó en realidad.
alter table public.purchase_invoice_extractions
  add column if not exists ai_provider text;

-- ── Cargar una clave ──────────────────────────────────────────────────────
create or replace function public.guardar_clave_ia(p_provider text, p_api_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clave text := nullif(trim(p_api_key), '');
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if p_provider not in ('GEMINI', 'ANTHROPIC') then
    raise exception 'Proveedor desconocido: %', p_provider;
  end if;
  if v_clave is null then
    raise exception 'La clave no puede quedar vacía. Para sacarla, usá borrar_clave_ia.';
  end if;

  insert into ai_credentials (provider, api_key, updated_at, updated_by)
  values (p_provider, v_clave, now(), auth.uid())
  on conflict (provider) do update
    set api_key = excluded.api_key,
        updated_at = now(),
        updated_by = excluded.updated_by;
end;
$$;

-- ── Sacar una clave ───────────────────────────────────────────────────────
create or replace function public.borrar_clave_ia(p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  delete from ai_credentials where provider = p_provider;
end;
$$;

-- ── Qué hay cargado, sin devolver la clave ────────────────────────────────
-- Los últimos cuatro caracteres alcanzan para reconocer cuál es sin exponerla.
-- Cuatro caracteres no permiten reconstruir nada: las claves de ambos
-- proveedores son largas y aleatorias.
create or replace function public.estado_claves_ia()
returns table (provider text, configurada boolean, ultimos4 text, actualizada timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  return query
  select p.provider,
         c.provider is not null as configurada,
         right(c.api_key, 4) as ultimos4,
         c.updated_at as actualizada
  from (values ('GEMINI'), ('ANTHROPIC')) as p(provider)
  left join ai_credentials c on c.provider = p.provider;
end;
$$;

grant execute on function public.guardar_clave_ia(text, text) to authenticated;
grant execute on function public.borrar_clave_ia(text) to authenticated;
grant execute on function public.estado_claves_ia() to authenticated;
