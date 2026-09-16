-- ===========================================================================
-- Reenviar el link de seguimiento de una orden, a pedido
-- ===========================================================================
-- Migración: reenviar_link_seguimiento
--
-- El link sale solo al crear la orden, desde el trigger
-- work_orders_enqueue_created. Con una sola salida automática, cuando ese
-- mensaje no llega no hay nada que hacer desde la app: el teléfono se cargó
-- mal y se corrigió después, el cliente borró el mensaje, o la cola estaba
-- parada cuando se dio el alta. Hasta ahora eso se arreglaba a mano contra la
-- base.
--
-- Es la misma forma que enviar_cotizacion_para_autorizar: una acción
-- explícita y repetible, con la llave de deduplicación numerada por envío. Que
-- la llave lleve el número es lo que hace posible repetir: pedir el reenvío de
-- nuevo arma una llave distinta y el mensaje sale otra vez, que es justamente
-- lo que se espera de un botón de reenvío. La deduplicación solo junta dos
-- pedidos simultáneos —los que leen el mismo número antes de que ninguno haya
-- grabado—; contra el doble clic distraído protege el botón, que se deshabilita
-- mientras el pedido está en vuelo.
--
-- Devuelve qué pasó de verdad, no un "listo" optimista: el motivo más común de
-- que el mensaje no haya salido al ingreso es justamente que el cliente no
-- tenga teléfono cargado o haya pedido no recibir mensajes, y en esos casos
-- reenviar tampoco va a servir. Quien aprieta el botón tiene que enterarse.

create or replace function public.reenviar_link_seguimiento(p_work_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  wo work_orders%rowtype;
  v_envios integer;
  v_id uuid;
  v_status notification_status;
  v_opt_out boolean;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into wo from work_orders where id = p_work_order_id;
  if not found then
    return 'NO_EXISTE';
  end if;

  select count(*) into v_envios
  from notifications
  where work_order_id = wo.id and kind = 'LINK_SEGUIMIENTO';

  v_id := enqueue_notification(
    'LINK_SEGUIMIENTO',
    'ot:' || wo.id::text || ':reenvio:' || (v_envios + 1)::text,
    build_work_order_message(wo.id, wo.status_id, true),
    wo.customer_id,
    wo.id
  );

  if v_id is null then
    -- enqueue_notification descarta por llave repetida: ya hay un envío igual
    -- esperando salir.
    return 'YA_ENCOLADO';
  end if;

  -- Se le pregunta a la fila recién creada, que es la que manda, en vez de
  -- repetir acá las reglas de enqueue_notification.
  select status into v_status from notifications where id = v_id;

  if v_status = 'DESCARTADO' then
    select whatsapp_opt_out into v_opt_out from customers where id = wo.customer_id;
    return case when v_opt_out then 'OPT_OUT' else 'SIN_TELEFONO' end;
  end if;

  return 'ENCOLADO';
end;
$$;

grant execute on function public.reenviar_link_seguimiento(uuid) to authenticated;
