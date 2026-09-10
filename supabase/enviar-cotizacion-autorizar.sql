-- ===========================================================================
-- Enviar la cotización a autorizar, a pedido y las veces que haga falta
-- ===========================================================================
-- Migración: enviar_cotizacion_autorizar
--
-- El aviso al cliente salía de un trigger: al pasar la cotización a ENVIADA se
-- encolaba el WhatsApp con el link para aceptar o rechazar. Eso tenía dos
-- problemas.
--
-- Uno: mandaba solo, como efecto de un cambio de estado. Guardar la cotización
-- y que le llegue un mensaje al cliente no son la misma decisión.
--
-- Dos: no se podía reenviar. El trigger filtraba `old.status = 'ENVIADA'`, así
-- que una vez enviada no volvía a disparar nunca — y el caso más común es
-- justamente ese: el cliente dice que no le llegó, o pasó una semana y hay que
-- insistir.
--
-- Ahora es una acción explícita, disponible desde la cotización y desde la
-- orden, que se puede repetir. La llave de deduplicación lleva el número de
-- envío: dos clics seguidos antes de que salga el primero se unifican, pero un
-- reenvío pedido después sí sale.

create or replace function public.enviar_cotizacion_para_autorizar(p_quotation_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  q quotations%rowtype;
  v_base text;
  v_total numeric;
  v_body text;
  v_envios integer;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into q from quotations where id = p_quotation_id;
  if not found then
    return 'NO_EXISTE';
  end if;

  -- Una cotización ya resuelta no se manda a autorizar de nuevo: el cliente ya
  -- respondió, y volver a pedirle que decida contradice lo que él mismo hizo.
  if q.status not in ('EMITIDA', 'ENVIADA') then
    return 'YA_RESUELTA';
  end if;

  if not exists (select 1 from quotation_items where quotation_id = q.id) then
    return 'SIN_RENGLONES';
  end if;

  select value into v_base from app_settings where key = 'public_base_url';

  select coalesce(sum(subtotal), 0) * 1.21 into v_total
  from quotation_items where quotation_id = q.id;

  v_body :=
    'Hola, le enviamos el presupuesto de su reparación.' || E'\n\n' ||
    'Presupuesto ' || q.number ||
    coalesce(' · ' || q.component, '') || E'\n' ||
    'Total: $ ' || to_char(v_total, 'FM999999990.00') ||
    coalesce(E'\n' || 'Válido hasta ' || to_char(q.valid_until, 'DD/MM/YYYY'), '') ||
    E'\n\n' ||
    'Puede verlo en detalle y aceptarlo o rechazarlo acá:' || E'\n' ||
    coalesce(v_base, '') || '/presupuesto/' || q.public_token::text;

  select count(*) into v_envios
  from notifications
  where quotation_id = q.id and kind = 'COTIZACION';

  v_id := public.enqueue_notification(
    'COTIZACION',
    'cot:' || q.id::text || ':enviada:' || (v_envios + 1)::text,
    v_body,
    q.customer_id,
    q.work_order_id,
    q.id
  );

  -- El estado acompaña al envío: una cotización que salió está enviada. Se
  -- actualiza después de encolar para que un fallo al encolar no deje la
  -- cotización diciendo que se mandó algo que no se mandó.
  if q.status = 'EMITIDA' then
    update quotations set status = 'ENVIADA' where id = q.id;
  end if;

  if v_id is null then
    -- enqueue_notification descarta por llave repetida: ya hay un envío igual
    -- esperando salir.
    return 'YA_ENCOLADA';
  end if;

  return 'ENVIADA';
end;
$$;

grant execute on function public.enviar_cotizacion_para_autorizar(uuid) to authenticated;

-- El trigger deja de existir: ahora el envío es explícito. Si quedara, pasar a
-- ENVIADA desde la función mandaría un segundo mensaje por el mismo
-- presupuesto.
drop trigger if exists quotations_enqueue_sent on public.quotations;
drop function if exists public.enqueue_quotation_sent();
