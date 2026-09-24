-- ===========================================================================
-- Fusionar artículos duplicados
-- ===========================================================================
-- Migración sugerida: fusionar_articulos_duplicados
--
-- El catálogo tiene la misma pieza cargada más de una vez: mismo número de
-- fábrica, una con marca y otra sin, o con marcas escritas distinto. Salieron
-- de importaciones viejas, cuando todavía no se reconocía la pieza por su
-- número de fábrica.
--
-- Molestan de dos maneras. El stock y el precio quedan repartidos entre dos
-- fichas, y al importar una lista el duplicado hace chocar el índice único
-- —fue lo que abortaba la importación de Núcleo entera—.
--
-- ── Por qué una función y no un borrado a mano ─────────────────────────────
-- Un artículo lo referencian nueve tablas: proveedores, combos, renglones de
-- factura, de nota de crédito, de compra, de cotización, de remito y de orden
-- de trabajo. Borrar el duplicado sin mover eso rompe historia, y con las
-- claves foráneas puestas en RESTRICT ni siquiera deja.

-- ---------------------------------------------------------------------------
-- 1. Qué está duplicado
-- ---------------------------------------------------------------------------
create or replace function public.articulos_duplicados()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select coalesce(jsonb_agg(g order by g->>'factory_code'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'factory_code', a.factory_code,
      'articulos', jsonb_agg(jsonb_build_object(
        'id', a.id,
        'code', a.code,
        'description', a.description,
        'brand', a.brand,
        'active', a.active,
        'tracks_stock', a.tracks_stock,
        'stock_quantity', a.stock_quantity,
        'unit_price', a.unit_price,
        -- Con qué peso viene cada uno: el que tiene historia es el que
        -- conviene conservar, y verlo antes evita elegir al azar.
        'proveedores', (select count(*) from article_suppliers s where s.article_id = a.id),
        'movimientos', (
          (select count(*) from invoice_items x where x.article_id = a.id) +
          (select count(*) from purchase_invoice_items x where x.article_id = a.id) +
          (select count(*) from work_order_items x where x.article_id = a.id) +
          (select count(*) from quotation_items x where x.article_id = a.id) +
          (select count(*) from remito_items x where x.article_id = a.id) +
          (select count(*) from credit_note_items x where x.article_id = a.id)
        )
      ) order by a.code)
    ) as g
    from articles a
    where a.factory_code is not null
      and a.factory_code in (
        select factory_code from articles
         where factory_code is not null
         group by factory_code having count(*) > 1
      )
    group by a.factory_code
  ) t;
$function$;

grant execute on function public.articulos_duplicados() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Fusionar
-- ---------------------------------------------------------------------------
-- Todo lo que apuntaba al absorbido pasa a apuntar al que se conserva, y el
-- absorbido desaparece. No se deshace.
create or replace function public.fusionar_articulos(
  p_conservar uuid,
  p_absorber uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_a articles%rowtype;  -- el que queda
  v_b articles%rowtype;  -- el que se absorbe
  v_codigos_perdidos text[] := '{}';
  v_fila record;
  v_movidos int := 0;
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if p_conservar = p_absorber then
    raise exception 'Son el mismo artículo.';
  end if;

  select * into v_a from articles where id = p_conservar for update;
  if not found then raise exception 'El artículo a conservar no existe.'; end if;

  select * into v_b from articles where id = p_absorber for update;
  if not found then raise exception 'El artículo a absorber no existe.'; end if;

  -- El resguardo que evita fusionar dos piezas distintas por un clic mal dado:
  -- solo se fusiona lo que el catálogo ya dice que es la misma pieza.
  if v_a.factory_code is null or v_a.factory_code is distinct from v_b.factory_code then
    raise exception
      'Solo se fusionan artículos con el mismo número de fábrica. % tiene "%" y % tiene "%".',
      v_a.code, coalesce(v_a.factory_code, '(ninguno)'),
      v_b.code, coalesce(v_b.factory_code, '(ninguno)');
  end if;

  -- ── Proveedores ─────────────────────────────────────────────────────────
  -- Un artículo tiene un solo código por proveedor, así que si los dos están
  -- cargados con el mismo proveedor uno de los códigos se pierde. Se conserva
  -- el del artículo que queda y se informa cuál se descartó, porque ese código
  -- deja de reconocerse al importar.
  for v_fila in
    select s.id, s.supplier_id, s.supplier_code, p.name as proveedor
      from article_suppliers s
      join suppliers p on p.id = s.supplier_id
     where s.article_id = p_absorber
  loop
    if exists (
      select 1 from article_suppliers s2
       where s2.article_id = p_conservar and s2.supplier_id = v_fila.supplier_id
    ) then
      v_codigos_perdidos := v_codigos_perdidos || (v_fila.proveedor || ': ' || v_fila.supplier_code);
      delete from article_suppliers where id = v_fila.id;
    else
      -- is_preferred en false: el que queda ya puede tener su preferido, y hay
      -- un índice único que solo admite uno por artículo.
      update article_suppliers
         set article_id = p_conservar, is_preferred = false
       where id = v_fila.id;
      v_movidos := v_movidos + 1;
    end if;
  end loop;

  -- ── Historia ────────────────────────────────────────────────────────────
  update invoice_items          set article_id = p_conservar where article_id = p_absorber;
  update credit_note_items      set article_id = p_conservar where article_id = p_absorber;
  update purchase_invoice_items set article_id = p_conservar where article_id = p_absorber;
  update quotation_items        set article_id = p_conservar where article_id = p_absorber;
  update remito_items           set article_id = p_conservar where article_id = p_absorber;
  update work_order_items       set article_id = p_conservar where article_id = p_absorber;

  -- ── Combos ──────────────────────────────────────────────────────────────
  -- Primero se sacan los renglones que dejarían al combo conteniéndose a sí
  -- mismo, y los que duplicarían un componente que el combo ya tiene.
  delete from article_components
   where (combo_article_id = p_absorber and component_article_id = p_conservar)
      or (combo_article_id = p_conservar and component_article_id = p_absorber);

  delete from article_components c
   where c.component_article_id = p_absorber
     and exists (
       select 1 from article_components c2
        where c2.combo_article_id = c.combo_article_id
          and c2.component_article_id = p_conservar
     );

  update article_components set combo_article_id = p_conservar where combo_article_id = p_absorber;
  update article_components set component_article_id = p_conservar where component_article_id = p_absorber;

  -- ── La ficha que queda ──────────────────────────────────────────────────
  -- El stock se suma: son la misma pieza, estaba repartida en dos fichas.
  update articles
     set stock_quantity = case
           when v_a.tracks_stock or v_b.tracks_stock
           then coalesce(v_a.stock_quantity, 0) + coalesce(v_b.stock_quantity, 0)
           else v_a.stock_quantity
         end,
         tracks_stock = v_a.tracks_stock or v_b.tracks_stock,
         -- Los datos del que queda mandan; del absorbido solo se toma lo que
         -- al otro le falta.
         brand = coalesce(v_a.brand, v_b.brand),
         rubro = coalesce(v_a.rubro, v_b.rubro),
         familia = coalesce(v_a.familia, v_b.familia)
   where id = p_conservar;

  delete from articles where id = p_absorber;

  return jsonb_build_object(
    'conservado', v_a.code,
    'absorbido', v_b.code,
    'proveedores_movidos', v_movidos,
    'codigos_perdidos', to_jsonb(v_codigos_perdidos),
    'stock_resultante', (select stock_quantity from articles where id = p_conservar)
  );
end;
$function$;

revoke all on function public.fusionar_articulos(uuid, uuid) from public, anon;
grant execute on function public.fusionar_articulos(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select jsonb_array_length(public.articulos_duplicados())) as grupos_duplicados,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('articulos_duplicados','fusionar_articulos')) as funciones;
