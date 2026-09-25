-- ===========================================================================
-- Listados de comprobantes estilo Tango: "Enviado" y "Etiquetar"
-- ===========================================================================
-- Migración sugerida: listados_de_comprobantes
--
-- Los listados de facturas, notas de crédito, recibos, presupuestos y remitos
-- pasan a tener la columna "Enviado" y la acción "Etiquetar", como en Tango.
-- Ninguna de las dos cosas existía: el envío por mail o WhatsApp no dejaba
-- rastro, y no había forma de marcar un comprobante.
--
-- Las dos se escriben por funciones y no con un update directo desde la app:
-- los comprobantes emitidos son registros congelados y ninguna política les
-- abre el update. Estas funciones tocan solo estas dos columnas, nada más.

alter table invoices     add column if not exists enviado_at timestamptz;
alter table credit_notes add column if not exists enviado_at timestamptz;
alter table receipts     add column if not exists enviado_at timestamptz;
alter table quotations   add column if not exists enviado_at timestamptz;
alter table remitos      add column if not exists enviado_at timestamptz;

alter table invoices     add column if not exists etiquetas text[] not null default '{}';
alter table credit_notes add column if not exists etiquetas text[] not null default '{}';
alter table receipts     add column if not exists etiquetas text[] not null default '{}';
alter table quotations   add column if not exists etiquetas text[] not null default '{}';
alter table remitos      add column if not exists etiquetas text[] not null default '{}';

-- El tipo de comprobante que llega desde la app se traduce a una tabla de una
-- lista cerrada: nunca se arma el nombre de la tabla con lo que manda el
-- cliente.
create or replace function public._tabla_de_comprobante(p_tipo text)
returns text
language sql
immutable
as $$
  select case p_tipo
    when 'factura'      then 'invoices'
    when 'nota_credito' then 'credit_notes'
    when 'recibo'       then 'receipts'
    when 'presupuesto'  then 'quotations'
    when 'remito'       then 'remitos'
  end
$$;

create or replace function public.marcar_comprobante_enviado(p_tipo text, p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tabla text := _tabla_de_comprobante(p_tipo);
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if v_tabla is null then
    raise exception 'Tipo de comprobante desconocido: %', p_tipo;
  end if;

  execute format('update %I set enviado_at = now() where id = $1', v_tabla) using p_id;
end;
$$;

create or replace function public.etiquetar_comprobante(p_tipo text, p_id uuid, p_etiquetas text[])
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tabla text := _tabla_de_comprobante(p_tipo);
  v_limpias text[];
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if v_tabla is null then
    raise exception 'Tipo de comprobante desconocido: %', p_tipo;
  end if;

  -- Sin vacías ni repetidas, en el orden en que se escribieron.
  select coalesce(array_agg(e order by primera), '{}')
    into v_limpias
    from (
      select btrim(e) as e, min(ord) as primera
        from unnest(coalesce(p_etiquetas, '{}')) with ordinality as t(e, ord)
       where btrim(e) <> ''
       group by btrim(e)
    ) s;

  execute format('update %I set etiquetas = $1 where id = $2', v_tabla) using v_limpias, p_id;
  return v_limpias;
end;
$$;

revoke all on function public.marcar_comprobante_enviado(text, uuid) from public, anon;
revoke all on function public.etiquetar_comprobante(text, uuid, text[]) from public, anon;
grant execute on function public.marcar_comprobante_enviado(text, uuid) to authenticated;
grant execute on function public.etiquetar_comprobante(text, uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'enviado_at'
      and table_name in ('invoices','credit_notes','receipts','quotations','remitos')) as columnas_enviado,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'etiquetas'
      and table_name in ('invoices','credit_notes','receipts','quotations','remitos')) as columnas_etiquetas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('marcar_comprobante_enviado','etiquetar_comprobante')) as funciones;
