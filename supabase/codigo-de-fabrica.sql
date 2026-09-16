-- ===========================================================================
-- Un artículo, varios proveedores: el código de fábrica
-- ===========================================================================
-- Migración: codigo_de_fabrica
--
-- El artículo se buscaba encerrado dentro del proveedor:
--
--   where supplier_id = X and upper(supplier_code) = upper(Y)
--
-- Entonces la misma tobera Bosch que el proveedor A trae como 0445120123 y el
-- proveedor B como BOS0445120123 entraba dos veces al catálogo, con dos stocks
-- y dos precios de venta. El modelo ya permitía un artículo con varios
-- proveedores: lo que faltaba era cómo decidir que dos códigos distintos son la
-- misma pieza.
--
-- Ahora el artículo lleva su código de fábrica —el número que le pone el
-- fabricante, igual lo venda quien lo venda— y cada proveedor declara qué
-- prefijo le antepone. Al importar se saca el prefijo, se normaliza, y lo que
-- queda es lo que une a los proveedores.
--
-- Se llama "de fábrica" y no "de Bosch" porque es la misma columna y el mismo
-- trabajo: el día que Delphi o Denso tengan el mismo problema no hay que migrar
-- nada. Bosch es el caso principal, no el único.

-- ---------------------------------------------------------------------------
-- 1. El prefijo que usa cada proveedor
-- ---------------------------------------------------------------------------
-- OJO: no confundir con suppliers.code_prefix, que es el prefijo con el que
-- generamos NUESTROS códigos al importar (MD-00000004). Este es lo que el
-- proveedor le antepone al número del fabricante.
alter table suppliers add column if not exists factory_code_prefix text;

comment on column suppliers.factory_code_prefix is
  'Lo que este proveedor le antepone al número de fábrica. Null si usa el número tal cual.';

create or replace function public.normalize_factory_code_prefix()
returns trigger
language plpgsql
as $$
begin
  new.factory_code_prefix := nullif(upper(trim(coalesce(new.factory_code_prefix, ''))), '');
  return new;
end;
$$;

drop trigger if exists suppliers_normalize_factory_prefix on public.suppliers;
create trigger suppliers_normalize_factory_prefix
before insert or update of factory_code_prefix on public.suppliers
for each row execute function public.normalize_factory_code_prefix();

-- ---------------------------------------------------------------------------
-- 2. El código de fábrica del artículo
-- ---------------------------------------------------------------------------
alter table articles add column if not exists factory_code text;

comment on column articles.factory_code is
  'Número del fabricante, normalizado (mayúsculas, sin separadores). Es lo que une a los proveedores que venden la misma pieza.';

-- Único entre los que lo tienen: dos artículos con el mismo número de fábrica
-- son la misma pieza cargada dos veces, que es justo lo que esto viene a
-- evitar. Parcial, porque la enorme mayoría no lo va a tener.
create unique index if not exists articles_factory_code_key
  on articles (factory_code)
  where factory_code is not null;

-- ---------------------------------------------------------------------------
-- 3. Normalizar y sacar el prefijo
-- ---------------------------------------------------------------------------
-- Normalizar deja afuera espacios, puntos y guiones: Bosch escribe sus propios
-- números como "0 445 120 123" y cada lista los copia a su manera.
create or replace function public.normalizar_codigo(p_codigo text)
returns text
language sql
immutable
as $$
  select nullif(upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g')), '');
$$;

/**
 * Qué número de fábrica hay detrás del código que usa este proveedor.
 *
 * Con prefijo configurado: solo los códigos que lo llevan son de fábrica; el
 * resto son códigos internos del proveedor y se dejan como están.
 *
 * Sin prefijo configurado: el código ES el número de fábrica. Sin esto la
 * función no serviría de nada — el proveedor que usa el número pelado nunca se
 * encontraría con el que le antepone algo, que es la mitad del problema.
 */
create or replace function public.codigo_de_fabrica(p_supplier_id uuid, p_codigo text)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_prefijo text;
  v_codigo text;
  v_resto text;
begin
  v_codigo := public.normalizar_codigo(p_codigo);
  if v_codigo is null then
    return null;
  end if;

  select public.normalizar_codigo(factory_code_prefix) into v_prefijo
  from suppliers where id = p_supplier_id;

  if v_prefijo is null then
    return v_codigo;
  end if;

  if v_codigo like v_prefijo || '%' then
    v_resto := substr(v_codigo, length(v_prefijo) + 1);
    return nullif(v_resto, '');
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Resolver: a qué artículo corresponde este código de este proveedor
-- ---------------------------------------------------------------------------
/**
 * Una sola función para la importación de listas y para la lectura de facturas
 * con IA. Que viva acá es lo que garantiza que las dos decidan igual: hasta
 * ahora cada una tenía su propia copia de la misma consulta, y ahí es donde se
 * desincronizan.
 *
 * El orden importa. Primero el vínculo que ya existe, que puede haberse atado a
 * mano y manda sobre cualquier deducción. Recién después el código de fábrica.
 */
create or replace function public.resolver_articulo_de_proveedor(
  p_supplier_id uuid,
  p_codigo text
)
returns table (article_id uuid, como text, factory_code text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_fabrica text;
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
    select a.id into v_id from articles a where a.factory_code = v_fabrica;
    if v_id is not null then
      return query select v_id, 'CODIGO_FABRICA'::text, v_fabrica;
      return;
    end if;
  end if;

  return query select null::uuid, 'NO_ENCONTRADO'::text, v_fabrica;
end;
$$;

grant execute on function public.resolver_articulo_de_proveedor(uuid, text) to authenticated;
grant execute on function public.codigo_de_fabrica(uuid, text) to authenticated;
