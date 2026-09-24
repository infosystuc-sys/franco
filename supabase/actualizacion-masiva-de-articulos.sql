-- ===========================================================================
-- Actualización masiva de artículos
-- ===========================================================================
-- Migración sugerida: actualizacion_masiva_articulos
--
-- Cambiar la utilidad de un rubro entero, marcar una familia como que lleva
-- stock, desactivar todo lo de una marca. Hoy eso es abrir ficha por ficha, y
-- con dieciséis mil artículos no se hace.
--
-- ── Dos pasos, siempre ─────────────────────────────────────────────────────
-- La función sabe contar sin tocar nada (p_solo_contar). La pantalla cuenta
-- primero y muestra cuántos artículos caen en el filtro; recién con ese número
-- a la vista se confirma. Un filtro vacío alcanza los dieciséis mil, y la
-- diferencia entre eso y los cuarenta que se querían cambiar tiene que verse
-- ANTES, no después.
--
-- ── La marca es el campo peligroso ─────────────────────────────────────────
-- Hay un índice único sobre (número de fábrica, marca). Poner la misma marca a
-- muchos artículos que comparten número de fábrica los vuelve idénticos entre
-- sí y el índice lo rechaza, abortando todo. Igual que en la importación de
-- listas: los que chocarían se saltean, se cuentan y se informan, en vez de
-- tirar abajo el resto del cambio.

create table if not exists actualizacion_masiva_log (
  id uuid primary key default gen_random_uuid(),
  filtro jsonb not null,
  cambios jsonb not null,
  afectados int not null,
  salteados int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table actualizacion_masiva_log enable row level security;

drop policy if exists "solo admin" on actualizacion_masiva_log;
create policy "solo admin" on actualizacion_masiva_log for select to authenticated using (is_admin());

-- ---------------------------------------------------------------------------
-- Los valores que existen hoy, para armar el filtro sin adivinar
-- ---------------------------------------------------------------------------
create or replace function public.valores_de_clasificacion()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select jsonb_build_object(
    'rubros', coalesce((select jsonb_agg(distinct rubro order by rubro)
                          from articles where rubro is not null), '[]'::jsonb),
    'familias', coalesce((select jsonb_agg(distinct familia order by familia)
                            from articles where familia is not null), '[]'::jsonb),
    'marcas', coalesce((select jsonb_agg(distinct brand order by brand)
                          from articles where brand is not null), '[]'::jsonb)
  );
$function$;

grant execute on function public.valores_de_clasificacion() to authenticated;

-- ---------------------------------------------------------------------------
-- Contar o actualizar
-- ---------------------------------------------------------------------------
-- p_filtro:  { codigo_desde, codigo_hasta, rubro, familia, marca, part_kind,
--              supplier_id, activos (bool), texto }   — todo opcional, se suman
-- p_cambios: { markup_percent, rubro, familia, marca, part_kind,
--              tracks_stock, active }                 — solo las claves presentes
--
-- En los textos, la cadena vacía significa "dejarlo sin valor"; la clave
-- ausente significa "no tocar este campo". Son cosas distintas y hay que poder
-- decir las dos.
create or replace function public.actualizar_articulos_en_masa(
  p_filtro jsonb,
  p_cambios jsonb,
  p_solo_contar boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_ids uuid[];
  v_afectados int := 0;
  v_salteados int := 0;
  v_marca text;
  v_id uuid;
  v_choca boolean;
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if p_cambios is null or p_cambios = '{}'::jsonb then
    raise exception 'No elegiste ningún campo para cambiar.';
  end if;

  -- ── A quiénes alcanza ───────────────────────────────────────────────────
  select array_agg(a.id) into v_ids
  from articles a
  where (p_filtro->>'codigo_desde' is null or a.code >= p_filtro->>'codigo_desde')
    and (p_filtro->>'codigo_hasta' is null or a.code <= p_filtro->>'codigo_hasta')
    and (p_filtro->>'rubro'    is null or upper(trim(coalesce(a.rubro, '')))   = upper(trim(p_filtro->>'rubro')))
    and (p_filtro->>'familia'  is null or upper(trim(coalesce(a.familia, ''))) = upper(trim(p_filtro->>'familia')))
    and (p_filtro->>'marca'    is null or upper(trim(coalesce(a.brand, '')))   = upper(trim(p_filtro->>'marca')))
    and (p_filtro->>'part_kind' is null or a.part_kind = p_filtro->>'part_kind')
    and (p_filtro->>'activos'  is null or a.active = (p_filtro->>'activos')::boolean)
    and (p_filtro->>'texto'    is null or a.description ilike '%' || (p_filtro->>'texto') || '%')
    and (p_filtro->>'supplier_id' is null or exists (
          select 1 from article_suppliers s
           where s.article_id = a.id
             and s.supplier_id = (p_filtro->>'supplier_id')::uuid));

  v_ids := coalesce(v_ids, '{}');

  if p_solo_contar then
    return jsonb_build_object('alcanzados', cardinality(v_ids));
  end if;

  if cardinality(v_ids) = 0 then
    return jsonb_build_object('afectados', 0, 'salteados', 0);
  end if;

  -- ── La marca, uno por uno, porque puede chocar ──────────────────────────
  if p_cambios ? 'marca' then
    v_marca := nullif(trim(p_cambios->>'marca'), '');

    foreach v_id in array v_ids loop
      select exists (
        select 1 from articles otro
         join articles este on este.id = v_id
        where otro.id <> v_id
          and otro.factory_code is not null
          and otro.factory_code = este.factory_code
          and coalesce(upper(trim(otro.brand)), '') = coalesce(upper(trim(v_marca)), '')
      ) into v_choca;

      if v_choca then
        v_salteados := v_salteados + 1;
      else
        update articles set brand = v_marca where id = v_id;
      end if;
    end loop;
  end if;

  -- Si lo único que se pedía era la marca, no hay nada más que escribir. Sin
  -- este corte el update de abajo reescribiría cada fila poniéndole los
  -- valores que ya tenía, disparando sus triggers para nada.
  if not (p_cambios ?| array['markup_percent', 'rubro', 'familia', 'part_kind', 'tracks_stock', 'active']) then
    v_afectados := cardinality(v_ids) - v_salteados;

    insert into actualizacion_masiva_log (filtro, cambios, afectados, salteados, created_by)
    values (coalesce(p_filtro, '{}'::jsonb), p_cambios, v_afectados, v_salteados, auth.uid());

    return jsonb_build_object('afectados', v_afectados, 'salteados', v_salteados);
  end if;

  -- ── El resto, de una sola vez ───────────────────────────────────────────
  -- markup_percent lo mira un disparador que recalcula el precio de venta, así
  -- que cambiarlo acá ya deja los precios al día.
  update articles a
     set markup_percent = case when p_cambios ? 'markup_percent'
                               then nullif(p_cambios->>'markup_percent', '')::numeric
                               else a.markup_percent end,
         rubro          = case when p_cambios ? 'rubro'
                               then nullif(trim(p_cambios->>'rubro'), '')
                               else a.rubro end,
         familia        = case when p_cambios ? 'familia'
                               then nullif(trim(p_cambios->>'familia'), '')
                               else a.familia end,
         part_kind      = case when p_cambios ? 'part_kind'
                               then nullif(p_cambios->>'part_kind', '')
                               else a.part_kind end,
         tracks_stock   = case when p_cambios ? 'tracks_stock'
                               then (p_cambios->>'tracks_stock')::boolean
                               else a.tracks_stock end,
         active         = case when p_cambios ? 'active'
                               then (p_cambios->>'active')::boolean
                               else a.active end
   where a.id = any(v_ids);

  get diagnostics v_afectados = row_count;

  insert into actualizacion_masiva_log (filtro, cambios, afectados, salteados, created_by)
  values (coalesce(p_filtro, '{}'::jsonb), p_cambios, v_afectados, v_salteados, auth.uid());

  return jsonb_build_object('afectados', v_afectados, 'salteados', v_salteados);
end;
$function$;

revoke all on function public.actualizar_articulos_en_masa(jsonb, jsonb, boolean) from public, anon;
grant execute on function public.actualizar_articulos_en_masa(jsonb, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select jsonb_array_length(public.valores_de_clasificacion()->'rubros')) as rubros,
  (select jsonb_array_length(public.valores_de_clasificacion()->'marcas')) as marcas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('actualizar_articulos_en_masa','valores_de_clasificacion')) as funciones;
