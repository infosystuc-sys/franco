-- ===========================================================================
-- Consulta de padrón en ARCA: traer los datos por CUIT o DNI
-- ===========================================================================
-- Migración: padron_arca
--
-- Dar de alta un cliente o un proveedor es copiar a mano razón social,
-- condición de IVA y domicilio desde una constancia en PDF. ARCA publica esos
-- mismos datos por web service: con el CUIT alcanza.
--
-- ── Dos certificados, dos propósitos ──────────────────────────────────────
-- ARCA no emite un permiso genérico: cada certificado habilita servicios
-- puntuales para un CUIT. Acá conviven dos:
--
--   PADRON       consulta de datos de terceros. El certificado puede estar a
--                nombre de otro CUIT que el del taller: a ARCA solo le importa
--                quién firma la consulta, no para quién se consulta.
--   FACTURACION  emisión de comprobantes (todavía sin usar). Este SÍ tiene que
--                ser del CUIT que factura: el CAE se pide a nombre del emisor.
--
-- Se deja el lugar hecho para el segundo aunque hoy solo se cargue el primero;
-- son el mismo tipo de dato con el mismo cuidado, y separarlos después
-- significaría migrar una clave privada de tabla.
--
-- ── Por qué una tabla sin policies ────────────────────────────────────────
-- Igual que ai_credentials: acá vive una CLAVE PRIVADA. Con RLS activo y sin
-- policies, nadie con sesión lee ni escribe, ni siquiera un admin desde el
-- navegador. Solo la llave de servicio —la de la Edge Function, del lado del
-- servidor— pasa por encima. El admin carga el certificado por una función que
-- valida su rol, y la pantalla nunca recibe de vuelta la clave.

create table if not exists public.arca_credentials (
  proposito text primary key check (proposito in ('PADRON', 'FACTURACION')),
  -- CUIT que firma la consulta. Va en cada llamada como cuitRepresentada.
  cuit text not null check (cuit ~ '^[0-9]{11}$'),
  cert_pem text not null,
  key_pem text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.arca_credentials enable row level security;
-- A propósito sin policies. Ver el comentario de arriba.

revoke all on public.arca_credentials from anon, authenticated;

-- ── El ticket de acceso, reusado mientras viva ────────────────────────────
-- WSAA devuelve un token y una firma que valen 12 horas. Pedir uno nuevo por
-- cada consulta hace que ARCA bloquee por exceso de tráfico, así que el que
-- está vigente se reusa. Es cache, no secreto de larga vida, pero vive en la
-- misma tabla cerrada: con el par token/sign se puede consultar el padrón.
create table if not exists public.arca_tickets (
  -- Un ticket por servicio: el de padrón A5 no sirve para el A13.
  servicio text primary key,
  token text not null,
  sign text not null,
  expira timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.arca_tickets enable row level security;
revoke all on public.arca_tickets from anon, authenticated;

-- ── Cargar un certificado ─────────────────────────────────────────────────
-- Los archivos llegan tal cual los bajó el admin de ARCA: el .crt y el .key en
-- formato PEM. Se validan los encabezados para que un archivo equivocado falle
-- acá y no doce horas después contra ARCA, con un error que no dice nada.
create or replace function public.guardar_certificado_arca(
  p_proposito text,
  p_cuit text,
  p_cert text,
  p_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuit text := regexp_replace(coalesce(p_cuit, ''), '[^0-9]', '', 'g');
  v_cert text := btrim(coalesce(p_cert, ''));
  v_key text := btrim(coalesce(p_key, ''));
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if p_proposito not in ('PADRON', 'FACTURACION') then
    raise exception 'Propósito desconocido: %', p_proposito;
  end if;

  if v_cuit !~ '^[0-9]{11}$' then
    raise exception 'El CUIT tiene que tener 11 dígitos.';
  end if;

  if v_cert not like '-----BEGIN CERTIFICATE-----%' then
    raise exception 'Eso no parece un certificado. Tiene que empezar con -----BEGIN CERTIFICATE-----';
  end if;

  -- ARCA entrega la clave en PKCS#8 ("PRIVATE KEY") y openssl vieja en PKCS#1
  -- ("RSA PRIVATE KEY"). Las dos sirven.
  if v_key not like '-----BEGIN PRIVATE KEY-----%'
     and v_key not like '-----BEGIN RSA PRIVATE KEY-----%' then
    raise exception 'Eso no parece una clave privada. Tiene que empezar con -----BEGIN PRIVATE KEY-----';
  end if;

  insert into arca_credentials (proposito, cuit, cert_pem, key_pem, updated_at, updated_by)
  values (p_proposito, v_cuit, v_cert, v_key, now(), auth.uid())
  on conflict (proposito) do update
    set cuit = excluded.cuit,
        cert_pem = excluded.cert_pem,
        key_pem = excluded.key_pem,
        updated_at = now(),
        updated_by = excluded.updated_by;

  -- Certificado nuevo, tickets viejos a la basura: los que están en cache se
  -- emitieron con el anterior y ARCA los va a rechazar.
  -- El "where" que siempre se cumple está para el guardarraíl de la base, que
  -- rechaza un DELETE pelado: acá vaciar la tabla ES la intención.
  delete from arca_tickets where servicio is not null;
end;
$$;

-- ── Sacar un certificado ──────────────────────────────────────────────────
create or replace function public.borrar_certificado_arca(p_proposito text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  delete from arca_credentials where proposito = p_proposito;
  delete from arca_tickets where servicio is not null;
end;
$$;

-- ── Qué hay cargado, sin devolver nada sensible ───────────────────────────
-- El CUIT no es secreto —es público por definición— y es lo único que permite
-- reconocer de un vistazo cuál certificado está puesto.
create or replace function public.estado_certificados_arca()
returns table (
  proposito text,
  cargado boolean,
  cuit text,
  actualizado timestamptz,
  ticket_vigente_hasta timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  return query
  select p.proposito,
         c.proposito is not null as cargado,
         c.cuit,
         c.updated_at as actualizado,
         (select max(t.expira) from arca_tickets t) as ticket_vigente_hasta
  from (values ('PADRON'), ('FACTURACION')) as p(proposito)
  left join arca_credentials c on c.proposito = p.proposito;
end;
$$;

grant execute on function public.guardar_certificado_arca(text, text, text, text) to authenticated;
grant execute on function public.borrar_certificado_arca(text) to authenticated;
grant execute on function public.estado_certificados_arca() to authenticated;
