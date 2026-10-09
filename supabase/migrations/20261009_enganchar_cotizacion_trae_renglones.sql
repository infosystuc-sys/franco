-- Al enganchar una cotización ya hecha a una OT, la OT quedaba sin renglones:
-- la cotización los tenía, la orden no, y la pantalla de la orden (y todo lo
-- que se factura desde ella) mostraba vacío. Ahora, si la orden no tiene
-- renglones, se le copian los de la cotización. Si ya tenía los suyos, no se
-- toca nada: lo cargado en la orden manda.
do $$
declare
  v_def text;
  v_nuevo text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'link_quotation_to_work_order';

  v_def := replace(v_def, chr(13), '');
  if position('trae_renglones_de_la_cotizacion' in v_def) > 0 then
    return;
  end if;

  v_nuevo := replace(
    v_def,
    '  update work_orders set quotation_id = p_quotation_id where id = p_work_order_id;',
    '  update work_orders set quotation_id = p_quotation_id where id = p_work_order_id;

  -- trae_renglones_de_la_cotizacion
  if not exists (select 1 from work_order_items where work_order_id = p_work_order_id) then
    insert into work_order_items (
      work_order_id, article_id, code, description, quantity, unit_price, subtotal, unit_cost
    )
    select
      p_work_order_id, qi.article_id, qi.code, qi.description,
      qi.quantity, qi.unit_price, qi.subtotal,
      (
        select sp.purchase_price
          from article_suppliers sp
         where sp.article_id = qi.article_id and sp.is_preferred
         limit 1
      )
    from quotation_items qi
    where qi.quotation_id = p_quotation_id;
  end if;'
  );
  if v_nuevo = v_def then
    raise exception 'No se encontró dónde enganchar la cotización en link_quotation_to_work_order';
  end if;
  execute v_nuevo;
end $$;

-- Las órdenes que ya quedaron enganchadas y sin renglones (OT-18).
insert into work_order_items (work_order_id, article_id, code, description, quantity, unit_price, subtotal, unit_cost)
select
  w.id, qi.article_id, qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal,
  (select sp.purchase_price from article_suppliers sp where sp.article_id = qi.article_id and sp.is_preferred limit 1)
from work_orders w
join quotation_items qi on qi.quotation_id = w.quotation_id
where not exists (select 1 from work_order_items i where i.work_order_id = w.id);
