-- Autorizar el cambio de precio de una OT desde la app, sin mandarle el link
-- al cliente. Para cuando el cliente ya lo autorizó por otro medio (en el
-- mostrador, por teléfono) y no hace falta que vuelva a responder.
--
-- Queda autorizado el monto actual de la OT, igual que si el cliente hubiera
-- respondido "sí" al pedido, y se anota que lo autorizó el taller y quién.

create or replace function public.autorizar_cambio_de_precio_en_el_taller(p_work_order_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_wo work_orders%rowtype;
  v_quoted_total numeric;
  v_current_total numeric;
  v_quien text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_wo from work_orders where id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;
  if v_wo.quotation_id is null then
    raise exception 'Esta orden no nació de una cotización: no hay precio original con el cual compararla.';
  end if;

  select coalesce(sum(subtotal), 0) into v_quoted_total
    from quotation_items where quotation_id = v_wo.quotation_id;
  select coalesce(sum(subtotal), 0) into v_current_total
    from work_order_items where work_order_id = p_work_order_id;

  if v_current_total = v_quoted_total then
    raise exception 'El monto de la OT no cambió respecto a la cotización original: no hay nada que autorizar.';
  end if;

  select email into v_quien from auth.users where id = auth.uid();

  update work_orders
     set price_auth_status = 'AUTORIZADO',
         price_auth_requested_total = v_current_total,
         price_auth_requested_at = coalesce(price_auth_requested_at, now()),
         price_auth_decided_at = now(),
         price_auth_reason = 'Autorizado desde el taller' || coalesce(' por ' || v_quien, '')
   where id = p_work_order_id;
end;
$$;

revoke all on function public.autorizar_cambio_de_precio_en_el_taller(uuid) from public, anon;
grant execute on function public.autorizar_cambio_de_precio_en_el_taller(uuid) to authenticated;
notify pgrst, 'reload schema';
