-- ===========================================================================
-- Enganchar una cotización a la OT que la origina
-- ===========================================================================
-- Migración: link_quotation_to_work_order
--
-- El vínculo vive en dos lados (quotations.work_order_id y
-- work_orders.quotation_id) y mover la OT a "Cotizado" es parte del mismo
-- acto. Hacerlo en tres updates sueltos desde el navegador deja estados a
-- medias si uno falla.

create or replace function public.link_quotation_to_work_order(
  p_quotation_id uuid,
  p_work_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cotizado uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if exists (select 1 from quotations where id = p_quotation_id and work_order_id is not null
             and work_order_id <> p_work_order_id) then
    raise exception 'Esa cotización ya está enganchada a otra orden de trabajo.';
  end if;

  select id into v_cotizado from work_order_statuses where label = 'Cotizado';
  if v_cotizado is null then
    raise exception 'Falta el estado "Cotizado" en el ABM de estados de OT.';
  end if;

  update quotations set work_order_id = p_work_order_id where id = p_quotation_id;
  update work_orders set quotation_id = p_quotation_id where id = p_work_order_id;

  -- Solo avanza la OT si todavía está en la recepción: una orden que ya está
  -- en reparación no vuelve para atrás porque se le adjunte un presupuesto.
  update work_orders w
  set status_id = v_cotizado
  from work_order_statuses s
  where w.id = p_work_order_id and s.id = w.status_id and s.label = 'Ingresado';
end;
$$;

grant execute on function public.link_quotation_to_work_order(uuid, uuid) to authenticated;
