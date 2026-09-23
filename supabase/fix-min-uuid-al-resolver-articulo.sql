-- ===========================================================================
-- Dar de alta un artículo desde una factura fallaba con "min(uuid) no existe"
-- ===========================================================================
-- Migración sugerida: fix_min_uuid_resolver_articulo
--
-- resolver_articulo_de_proveedor() busca, por número de fábrica, cuántos
-- artículos del catálogo coinciden. Si hay más de uno el renglón es ambiguo y
-- hay que pedir la marca; si hay exactamente uno, ese es.
--
-- Para traerse las dos cosas de una sola pasada hacía:
--
--     select count(*), min(a.id) into v_cuantos, v_id
--
-- y Postgres no tiene min() para uuid: no hay un orden definido entre dos
-- identificadores, así que la función no existe. El error no aparece al
-- crearla —plpgsql no resuelve los tipos hasta ejecutar— sino recién cuando
-- alguien pasa por ese camino, que es el de "dar de alta todos los faltantes"
-- en la revisión de una factura de compra con IA.
--
-- Se reemplaza por (array_agg(a.id))[1], que es lo que se quería decir:
-- cualquiera del conjunto. Sirve porque solo se usa cuando v_cuantos es 1, y
-- entonces "cualquiera" es "el único".

create or replace function public.resolver_articulo_de_proveedor(
  p_supplier_id uuid,
  p_codigo text,
  p_marca text
)
returns table(article_id uuid, como text, factory_code text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
      -- Cualquiera del conjunto: solo se usa si resultó ser uno solo.
      select count(*), (array_agg(a.id))[1] into v_cuantos, v_id
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
$function$;

-- ---------------------------------------------------------------------------
-- Verificación: que el camino que fallaba ahora corra
-- ---------------------------------------------------------------------------
select como, factory_code
from public.resolver_articulo_de_proveedor(
  (select id from suppliers limit 1),
  '__codigo_que_no_existe__',
  null
);
