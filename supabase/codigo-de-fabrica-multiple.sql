-- ===========================================================================
-- Varios prefijos por proveedor, y la marca como parte de la identidad
-- ===========================================================================
-- Migración: codigo_de_fabrica_multiple
--
-- Continúa supabase/codigo-de-fabrica.sql. Dos cosas que aparecieron al leer
-- las listas reales de los tres proveedores de Bosch:
--
-- 1. UN PREFIJO NO ALCANZA.
--    Maximiliano Diesel no usa un prefijo: usa cuatro, y elige según la
--    familia de la pieza. Sobre sus 2.685 renglones Bosch:
--        F -> 1.626 códigos, 100% Bosch  (common rail 0445, sensores 0281,
--                                          repuestos de bomba 146x, 0414)
--        B ->   822 códigos, 100% Bosch  (convencional: toberas 0433,
--                                          elementos 2418, 1418)
--        C ->    92 códigos,  99% Bosch
--        Z ->   123 códigos,  77% Bosch  <- el 20% restante es DENSO
--    Y los Denso y Zexel los lista SIN prefijo, con el número pelado de 10
--    dígitos. Hace falta probar varios prefijos y, si no engancha ninguno,
--    aceptar el código tal cual.
--
-- 2. EL NÚMERO IDENTIFICA LA PIEZA, NO LA MARCA.
--    Dentro de la lista de Maximiliano hay 652 números que aparecen dos
--    veces: una como BOSCH y otra como el reemplazo alternativo.
--        0281002907 -> BOSCH  y  NORK
--        0414799005 -> BOSCH  y  POWER PARTS
--    Son dos productos distintos, con dos precios y dos calidades, bajo el
--    mismo número. El índice único sobre factory_code a secas los fusionaba
--    en un solo artículo. La identidad real es (número de fábrica, marca).

-- ---------------------------------------------------------------------------
-- 1. El prefijo pasa a ser una lista
-- ---------------------------------------------------------------------------
alter table suppliers
  alter column factory_code_prefix drop default;

alter table suppliers
  alter column factory_code_prefix type text[]
  using case
    when factory_code_prefix is null or trim(factory_code_prefix) = '' then null
    else array[upper(trim(factory_code_prefix))]
  end;

comment on column suppliers.factory_code_prefix is
  'Los prefijos que este proveedor le antepone al número de fábrica. Vacío = usa el número tal cual.';

-- Normalizar: mayúsculas, sin repetidos, sin vacíos, y null si no queda nada.
create or replace function public.normalize_factory_code_prefix()
returns trigger
language plpgsql
as $fn$
declare
  v_limpios text[];
begin
  select array_agg(distinct limpio order by limpio)
    into v_limpios
  from (
    select nullif(upper(trim(p)), '') as limpio
    from unnest(coalesce(new.factory_code_prefix, '{}'::text[])) as p
  ) s
  where limpio is not null;

  new.factory_code_prefix := nullif(v_limpios, '{}'::text[]);
  return new;
end;
$fn$;

drop trigger if exists suppliers_normalize_factory_prefix on public.suppliers;
create trigger suppliers_normalize_factory_prefix
before insert or update of factory_code_prefix on public.suppliers
for each row execute function public.normalize_factory_code_prefix();

-- ---------------------------------------------------------------------------
-- 2. Qué tiene forma de número de fábrica
-- ---------------------------------------------------------------------------
/**
 * Sacar un prefijo puede dejar cualquier cosa: si el código era BOMBA y el
 * proveedor declara el prefijo B, queda OMBA, que no es el número de nadie.
 * Este es el filtro que decide si lo que quedó todavía parece una pieza.
 *
 * A propósito no sabe nada de Bosch: seis caracteres y cuatro dígitos deja
 * pasar 0433172037 (Bosch), F00VC01200 (Bosch moderno), 0934008230 (Denso),
 * 7189100DD (Delphi) e IM097090 (Power Parts), y frena a OMBA.
 */
create or replace function public.es_numero_de_fabrica(p_codigo text)
returns boolean
language sql
immutable
as $fn$
  select p_codigo is not null
     and length(p_codigo) >= 6
     and length(regexp_replace(p_codigo, '[^0-9]', '', 'g')) >= 4;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Sacar el prefijo, probando todos
-- ---------------------------------------------------------------------------
/**
 * Se prueban de más largo a más corto: si un proveedor declara BOS y B, el
 * código BOS0445120123 tiene que perder BOS y no solo la B.
 *
 * Si ninguno engancha, el código se toma tal cual —siempre que tenga forma de
 * número de fábrica—. Esto CAMBIA lo que hacía la versión anterior, que
 * devolvía null. El motivo está en la lista de Maximiliano: prefija los Bosch
 * pero lista los Denso y Zexel con el número pelado, y la regla vieja perdía
 * esos 1.084 números de fábrica perfectamente válidos.
 */
create or replace function public.codigo_de_fabrica(p_supplier_id uuid, p_codigo text)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_prefijos text[];
  v_codigo text;
  v_prefijo text;
  v_resto text;
begin
  v_codigo := public.normalizar_codigo(p_codigo);
  if v_codigo is null then
    return null;
  end if;

  select factory_code_prefix into v_prefijos
  from suppliers where id = p_supplier_id;

  for v_prefijo in
    select normalizado
    from (
      select public.normalizar_codigo(p) as normalizado
      from unnest(coalesce(v_prefijos, '{}'::text[])) as p
    ) s
    where normalizado is not null
    order by length(normalizado) desc, normalizado
  loop
    if v_codigo like v_prefijo || '%' then
      v_resto := substr(v_codigo, length(v_prefijo) + 1);
      if public.es_numero_de_fabrica(v_resto) then
        return v_resto;
      end if;
    end if;
  end loop;

  -- Ningún prefijo enganchó: el código es el número, si parece uno.
  if public.es_numero_de_fabrica(v_codigo) then
    return v_codigo;
  end if;

  return null;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. La identidad del artículo: número de fábrica + marca
-- ---------------------------------------------------------------------------
-- La marca se normaliza dentro del índice (mayúsculas, sin espacios al borde)
-- y el nulo se trata como cadena vacía: si no, dos artículos sin marca con el
-- mismo número volverían a pasar, que es justo lo que el índice viene a evitar.
drop index if exists articles_factory_code_key;

create unique index if not exists articles_factory_code_marca_key
  on articles (factory_code, coalesce(upper(trim(brand)), ''))
  where factory_code is not null;

comment on column articles.factory_code is
  'Número del fabricante, normalizado. Junto con la marca identifica la pieza: el mismo número puede venir en Bosch legítimo y en su reemplazo alternativo, y son dos artículos distintos.';

-- ---------------------------------------------------------------------------
-- 5. Resolver, ahora sabiendo la marca
-- ---------------------------------------------------------------------------
/**
 * Se mantiene la versión de dos argumentos como envoltorio. No es prolijidad:
 * PostgREST elige la función por los parámetros que recibe, y si la de tres
 * tuviera un default las dos podrían matchear una llamada de dos, que es el
 * error de sobrecarga ambigua que ya nos mordió antes.
 *
 * Sin marca, y con dos artículos compartiendo el número, no se adivina: se
 * devuelve AMBIGUO para que quien llama lo resuelva o lo muestre.
 */
create or replace function public.resolver_articulo_de_proveedor(
  p_supplier_id uuid,
  p_codigo text,
  p_marca text
)
returns table (article_id uuid, como text, factory_code text)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid;
  v_fabrica text;
  v_marca text := nullif(upper(trim(coalesce(p_marca, ''))), '');
  v_cuantos int;
begin
  select a.article_id into v_id
  from article_suppliers a
  where a.supplier_id = p_supplier_id
    and upper(a.supplier_code) = upper(trim(p_codigo))
  limit 1;

  if v_id is not null then
    return query select v_id, 'CODIGO_PROVEEDOR'::text, null::text;
    return;
  end if;

  v_fabrica := public.codigo_de_fabrica(p_supplier_id, p_codigo);

  if v_fabrica is not null then
    if v_marca is not null then
      select a.id into v_id
      from articles a
      where a.factory_code = v_fabrica
        and coalesce(upper(trim(a.brand)), '') = v_marca;
    else
      select count(*), min(a.id) into v_cuantos, v_id
      from articles a
      where a.factory_code = v_fabrica;

      if v_cuantos > 1 then
        return query select null::uuid, 'AMBIGUO'::text, v_fabrica;
        return;
      end if;
    end if;

    if v_id is not null then
      return query select v_id, 'CODIGO_FABRICA'::text, v_fabrica;
      return;
    end if;
  end if;

  return query select null::uuid, 'NO_ENCONTRADO'::text, v_fabrica;
end;
$fn$;

create or replace function public.resolver_articulo_de_proveedor(
  p_supplier_id uuid,
  p_codigo text
)
returns table (article_id uuid, como text, factory_code text)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  return query
    select r.article_id, r.como, r.factory_code
    from public.resolver_articulo_de_proveedor(p_supplier_id, p_codigo, null::text) r;
end;
$fn$;

grant execute on function public.es_numero_de_fabrica(text) to authenticated;
grant execute on function public.codigo_de_fabrica(uuid, text) to authenticated;
grant execute on function public.resolver_articulo_de_proveedor(uuid, text) to authenticated;
grant execute on function public.resolver_articulo_de_proveedor(uuid, text, text) to authenticated;
