-- Recordatorios automáticos por WhatsApp.
--
-- Tres insistencias que hoy se hacen a mano, ahora solas, una vez por día
-- (lunes a sábado, 10 de la mañana):
--
--   1. Presupuestos sin respuesta: la cotización está ENVIADA, no venció y el
--      cliente no la aceptó ni la rechazó.
--   2. Trabajos terminados sin retirar: la orden sigue en el estado TERMINADO.
--   3. Saldos vencidos: el cliente debe y tiene alguna factura vencida.
--
-- Cada uno se prende y se configura en Configuración → Mensajes: cada cuántos
-- días y, en los dos primeros, cuántas veces como máximo. Arrancan apagados.
-- Los textos son plantillas, editables como las demás.
--
-- Los mensajes van a la misma cola que el resto (notifications) y salen por el
-- mismo despachador. Solo se encola a clientes con teléfono válido y que no
-- pidieron dejar de recibir mensajes: si no, cada día quedaría un descartado.

-- Va en su propia sentencia y solo se usa dentro de cuerpos de función, que se
-- resuelven al ejecutarse (un valor nuevo de enum no se puede usar en la misma
-- transacción en que se agrega).
alter type notification_kind add value if not exists 'RECORDATORIO';

-- ---------------------------------------------------------------------------
-- Configuración (apagado hasta que se prenda desde la pantalla)
-- ---------------------------------------------------------------------------
insert into app_settings (key, value) values (
  'recordatorios',
  '{"cotizaciones":{"activo":false,"cada":3,"maximo":3},'
  '"terminados":{"activo":false,"cada":2,"maximo":3},'
  '"saldos":{"activo":false,"cada":7,"minimo":1000}}'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Textos
-- ---------------------------------------------------------------------------
insert into plantillas_mensaje (clave, asunto, cuerpo, asunto_original, cuerpo_original)
select clave, null, cuerpo, null, cuerpo from (values
  ('recordatorio_cotizacion', E'Hola {cliente}, le recordamos que el presupuesto {numero} sigue esperando su respuesta.\n{componente}\nTotal: $ {total}\nVálido hasta {vencimiento}\n\nPuede verlo y aceptarlo o rechazarlo acá:\n{link}'),
  ('recordatorio_terminado', E'Hola {cliente}, le recordamos que el trabajo de la orden {orden} está terminado y listo para retirar.\n{vehiculo}\n{componente}\n\nLo esperamos.'),
  ('recordatorio_saldo', E'Hola {cliente}, le recordamos que tiene un saldo pendiente de $ {saldo} en su cuenta corriente, de los cuales $ {vencido} están vencidos.\n\nSi ya lo abonó, por favor desestime este mensaje.')
) as t(clave, cuerpo)
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- La función que encola. La corre el cron; desde la app se puede correr a
-- mano ("Enviar ahora"). Devuelve cuántos encoló de cada uno.
-- ---------------------------------------------------------------------------
create or replace function public.enviar_recordatorios()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conf jsonb;
  v_base text;
  v_cada int;
  v_maximo int;
  v_minimo numeric;
  v_cot int := 0;
  v_ot int := 0;
  v_saldo int := 0;
  v_ultimo timestamptz;
  v_enviados int;
  v_total numeric;
  v_vencido numeric;
  r record;
begin
  -- Desde la app, solo un admin. El cron corre sin usuario.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select value::jsonb into v_conf from app_settings where key = 'recordatorios';
  if v_conf is null then
    return jsonb_build_object('cotizaciones', 0, 'terminados', 0, 'saldos', 0);
  end if;
  select value into v_base from app_settings where key = 'public_base_url';

  -- 1. Presupuestos sin respuesta ------------------------------------------
  if coalesce((v_conf #>> '{cotizaciones,activo}')::boolean, false) then
    v_cada := greatest(1, coalesce((v_conf #>> '{cotizaciones,cada}')::int, 3));
    v_maximo := greatest(1, coalesce((v_conf #>> '{cotizaciones,maximo}')::int, 3));

    for r in
      select q.*, c.name as cliente
        from quotations q
        join customers c on c.id = q.customer_id
       where q.status = 'ENVIADA'
         and (q.valid_until is null or q.valid_until >= current_date)
         and c.phone_e164 is not null
         and not c.whatsapp_opt_out
    loop
      -- Desde el último mensaje por este presupuesto (el envío o un recordatorio).
      select max(n.created_at) filter (where n.status <> 'DESCARTADO'),
             count(*) filter (where n.kind = 'RECORDATORIO')
        into v_ultimo, v_enviados
        from notifications n
       where n.quotation_id = r.id;
      continue when v_ultimo is null;            -- se envió por otro lado (mail): no se insiste por WhatsApp
      continue when v_enviados >= v_maximo;
      continue when v_ultimo > now() - make_interval(days => v_cada);

      select coalesce(sum(subtotal), 0) * 1.21 into v_total from quotation_items where quotation_id = r.id;

      if public.enqueue_notification(
        'RECORDATORIO',
        'recordatorio:cot:' || r.id::text || ':' || (v_enviados + 1)::text,
        aplicar_plantilla('recordatorio_cotizacion', jsonb_build_object(
          'cliente', r.cliente,
          'numero', r.number,
          'componente', r.component,
          'total', replace(replace(replace(to_char(v_total, 'FM999,999,999,990.00'), ',', '#'), '.', ','), '#', '.'),
          'vencimiento', to_char(r.valid_until, 'DD/MM/YYYY'),
          'link', coalesce(v_base, '') || '/presupuesto/' || r.public_token::text
        )),
        r.customer_id,
        r.work_order_id,
        r.id
      ) is not null then
        v_cot := v_cot + 1;
      end if;
    end loop;
  end if;

  -- 2. Trabajos terminados sin retirar -------------------------------------
  if coalesce((v_conf #>> '{terminados,activo}')::boolean, false) then
    v_cada := greatest(1, coalesce((v_conf #>> '{terminados,cada}')::int, 2));
    v_maximo := greatest(1, coalesce((v_conf #>> '{terminados,maximo}')::int, 3));

    for r in
      select wo.id, wo.number, wo.component, wo.customer_id, wo.updated_at,
             c.name as cliente,
             trim(coalesce(v.brand, '') || ' ' || coalesce(v.model, '')) as veh,
             v.license_plate,
             (select max(h.changed_at) from work_order_status_history h
               where h.work_order_id = wo.id and h.to_status_id = wo.status_id) as terminada
        from work_orders wo
        join work_order_statuses s on s.id = wo.status_id
        join customers c on c.id = wo.customer_id
        left join vehicles v on v.id = wo.vehicle_id
       where s.system_key = 'TERMINADO'
         and c.phone_e164 is not null
         and not c.whatsapp_opt_out
    loop
      r.terminada := coalesce(r.terminada, r.updated_at);

      -- Lo que se le mandó desde que quedó terminada: el aviso del estado y los recordatorios.
      select max(n.created_at) filter (where n.status <> 'DESCARTADO'),
             count(*) filter (where n.kind = 'RECORDATORIO')
        into v_ultimo, v_enviados
        from notifications n
       where n.work_order_id = r.id
         and n.quotation_id is null
         and n.created_at >= r.terminada;
      continue when v_enviados >= v_maximo;
      continue when greatest(r.terminada, coalesce(v_ultimo, r.terminada)) > now() - make_interval(days => v_cada);

      if public.enqueue_notification(
        'RECORDATORIO',
        'recordatorio:ot:' || r.id::text || ':' || extract(epoch from r.terminada)::bigint::text || ':' || (v_enviados + 1)::text,
        aplicar_plantilla('recordatorio_terminado', jsonb_build_object(
          'cliente', r.cliente,
          'orden', r.number,
          'vehiculo', nullif(r.veh, '') || coalesce(' (' || r.license_plate || ')', ''),
          'componente', r.component
        )),
        r.customer_id,
        r.id
      ) is not null then
        v_ot := v_ot + 1;
      end if;
    end loop;
  end if;

  -- 3. Saldos vencidos -------------------------------------------------------
  if coalesce((v_conf #>> '{saldos,activo}')::boolean, false) then
    v_cada := greatest(1, coalesce((v_conf #>> '{saldos,cada}')::int, 7));
    v_minimo := greatest(0, coalesce((v_conf #>> '{saldos,minimo}')::numeric, 0));

    for r in
      select s.customer_id, s.saldo, c.name as cliente
        from saldos_de_clientes() s
        join customers c on c.id = s.customer_id
       where s.saldo > 0
         and s.saldo >= v_minimo
         and c.phone_e164 is not null
         and not c.whatsapp_opt_out
    loop
      select coalesce(sum(i.total_amount - i.paid_amount - i.credited_amount), 0) into v_vencido
        from invoices i
       where i.customer_id = r.customer_id
         and i.status = 'EMITIDA'
         and i.due_date < current_date
         and i.total_amount - i.paid_amount - i.credited_amount > 0;
      continue when v_vencido <= 0;

      select max(n.created_at) into v_ultimo
        from notifications n
       where n.customer_id = r.customer_id
         and n.kind = 'RECORDATORIO'
         and n.dedupe_key like 'recordatorio:saldo:%';
      continue when v_ultimo is not null and v_ultimo > now() - make_interval(days => v_cada);

      if public.enqueue_notification(
        'RECORDATORIO',
        'recordatorio:saldo:' || r.customer_id::text || ':' || to_char(current_date, 'YYYY-MM-DD'),
        aplicar_plantilla('recordatorio_saldo', jsonb_build_object(
          'cliente', r.cliente,
          'saldo', replace(replace(replace(to_char(r.saldo, 'FM999,999,999,990.00'), ',', '#'), '.', ','), '#', '.'),
          'vencido', replace(replace(replace(to_char(least(v_vencido, r.saldo), 'FM999,999,999,990.00'), ',', '#'), '.', ','), '#', '.')
        )),
        r.customer_id
      ) is not null then
        v_saldo := v_saldo + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('cotizaciones', v_cot, 'terminados', v_ot, 'saldos', v_saldo);
end;
$$;

revoke all on function public.enviar_recordatorios() from public, anon;
grant execute on function public.enviar_recordatorios() to authenticated;

-- ---------------------------------------------------------------------------
-- Una vez por día, de lunes a sábado a las 10 (13 UTC).
-- ---------------------------------------------------------------------------
select cron.unschedule('recordatorios')
 where exists (select 1 from cron.job where jobname = 'recordatorios');
select cron.schedule('recordatorios', '0 13 * * 1-6', 'select public.enviar_recordatorios()');

notify pgrst, 'reload schema';
