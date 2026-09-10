-- ===========================================================================
-- Cambiar a qué cliente se le factura una orden
-- ===========================================================================
-- Migración: reasignar_cliente_orden
--
-- El vehículo entra a nombre de quien lo trae, pero la factura muchas veces va
-- a otro: la empresa del titular, el seguro, la contratista. Hasta ahora el
-- cliente de la orden se decidía en la recepción y no se podía mover, así que
-- el circuito terminaba con una factura a nombre equivocado.
--
-- Se cambia ANTES de emitir. La factura toma el cliente de la orden, así que
-- reasignar la orden alcanza para que nazca bien, y de paso quedan alineados
-- el presupuesto y el remito que salieron de ella. Una vez emitida, no: mover
-- una factura entregada arrastra el saldo de cuenta corriente y los recibos ya
-- aplicados, y deja al cliente con un papel que no coincide con el sistema.
--
-- El vehículo NO cambia de dueño. La camioneta sigue siendo de quien es
-- aunque la pague otro, y moverla rompería su historial de reparaciones.

create or replace function public.reasignar_cliente_de_orden(
  p_work_order_id uuid,
  p_customer_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_facturada integer;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if not exists (select 1 from customers where id = p_customer_id and active) then
    raise exception 'El cliente elegido no existe o está inactivo.';
  end if;

  select count(*) into v_facturada
  from invoices
  where work_order_id = p_work_order_id and status <> 'ANULADA';

  if v_facturada > 0 then
    raise exception 'La orden ya tiene una factura emitida. Para cambiarle el cliente hay que anularla primero.';
  end if;

  update work_orders set customer_id = p_customer_id where id = p_work_order_id;

  -- El presupuesto que salió de esta orden queda a nombre del mismo cliente:
  -- apuntando al viejo, aparecería como pendiente de autorizar en la cuenta de
  -- alguien que no tiene nada que autorizar.
  update quotations set customer_id = p_customer_id where work_order_id = p_work_order_id;

  -- Los remitos no se tocan: cuelgan de la factura (remitos.invoice_id), no de
  -- la orden, y acá se sale antes si hay alguna factura viva. Los que queden
  -- son de facturas anuladas, o sea historia que no se reescribe.
end;
$$;

grant execute on function public.reasignar_cliente_de_orden(uuid, uuid) to authenticated;
