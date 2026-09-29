-- ===========================================================================
-- Textos de los mensajes de WhatsApp y mail, editables desde Configuración
-- ===========================================================================
-- Migración sugerida: plantillas_de_mensajes
--
-- Hasta ahora cada mensaje estaba escrito dentro del código: los WhatsApp que
-- arma la base (seguimiento de la orden, cambio de precio, presupuesto para
-- autorizar, retención pendiente) y los mails y WhatsApp con que se manda cada
-- comprobante. Cambiar una palabra era pedir un cambio de programa.
--
-- Ahora cada texto es una plantilla, con variables entre llaves: {cliente},
-- {numero}, {total}, {link}… Una línea con una variable sin valor se omite
-- entera: una orden sin componente no deja un renglón en blanco, ni queda un
-- "Válido hasta" sin fecha.
--
-- Cada plantilla guarda también su texto original. Si alguien la deja vacía,
-- se usa ese: un mensaje nunca sale vacío, y alta de una orden (que manda el
-- WhatsApp desde un disparador) nunca falla por un texto mal editado.
--
-- Los textos por estado de la orden ya estaban en notification_templates: se
-- editan desde la misma pantalla. Esa tabla solo dejaba actualizar, y un
-- estado sin texto no se podía completar: se agrega la política de alta.

create table if not exists plantillas_mensaje (
  clave text primary key,
  asunto text,
  cuerpo text not null,
  asunto_original text,
  cuerpo_original text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table plantillas_mensaje enable row level security;

drop policy if exists "plantillas: leer" on plantillas_mensaje;
create policy "plantillas: leer" on plantillas_mensaje for select to authenticated using (true);
drop policy if exists "plantillas: admin modifica" on plantillas_mensaje;
create policy "plantillas: admin modifica" on plantillas_mensaje for update to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists "admin insert" on notification_templates;
create policy "admin insert" on notification_templates for insert to authenticated with check (is_admin());

-- Los textos de hoy, como punto de partida y como respaldo.
insert into plantillas_mensaje (clave, asunto, cuerpo, asunto_original, cuerpo_original)
select clave, asunto, cuerpo, asunto, cuerpo from (values
  ('ot_alta', null, E'Hola, le compartimos el seguimiento de su reparación.\n\nOrden {orden}\n{vehiculo}\n{componente}\n\n{mensaje_estado}\n\nPuede seguir el avance acá:\n{link}'),
  ('ot_estado', null, E'Orden {orden}\n{vehiculo}\n{componente}\n\n{mensaje_estado}\n\nPuede seguir el avance acá:\n{link}'),
  ('ot_cambio_precio', null, E'Hola, el costo de su reparación cambió respecto al presupuesto original.\n\nOrden {orden}\nPresupuesto original: ${presupuesto_original}\nNuevo monto: ${nuevo_monto}\n\nPara poder continuar necesitamos su autorización. Puede verla y responder acá:\n{link}'),
  ('cotizacion_autorizar', null, E'Hola, le enviamos el presupuesto de su reparación.\n\nPresupuesto {numero}\n{componente}\nTotal: $ {total}\nVálido hasta {vencimiento}\n\nPuede verlo en detalle y aceptarlo o rechazarlo acá:\n{link}'),
  ('retencion_pendiente', null, 'Hola {cliente}, en el recibo {numero} del {fecha} quedó pendiente el comprobante de la retención de {impuesto} por $ {importe}. Por favor envíenoslo para nuestros registros. Gracias.'),
  ('factura_mail', '{tipo} {numero}', 'Adjuntamos la {tipo} {numero} por $ {total}.'),
  ('factura_whatsapp', null, '{tipo} {numero} — $ {total}'),
  ('recibo_mail', 'Recibo {numero}', 'Te enviamos el recibo {numero} por $ {total}. Gracias por tu pago.'),
  ('recibo_whatsapp', null, 'Te enviamos el recibo {numero} por $ {total}. Gracias por tu pago.'),
  ('nota_credito_mail', 'Nota de crédito {numero}', 'Adjuntamos la nota de crédito {numero} por $ {total}.'),
  ('nota_credito_whatsapp', null, 'Nota de crédito {numero} — $ {total}'),
  ('remito_mail', 'Remito {numero}', 'Adjuntamos el remito {numero}.'),
  ('remito_whatsapp', null, 'Remito {numero}'),
  ('presupuesto_mail', 'Presupuesto {numero}', 'Adjuntamos el presupuesto {numero} por $ {total}.'),
  ('presupuesto_whatsapp', null, 'Presupuesto {numero} — $ {total}'),
  ('orden_pago_mail', 'Orden de pago {numero}', 'Adjuntamos la orden de pago {numero} por $ {total}.'),
  ('orden_pago_whatsapp', null, 'Orden de pago {numero} — $ {total}')
) as t(clave, asunto, cuerpo)
on conflict (clave) do nothing;

-- Arma el texto: reemplaza las variables y omite las líneas con alguna
-- variable vacía. p_campo: 'cuerpo' o 'asunto'. La app hace lo mismo en
-- src/lib/plantillasMensaje.ts para los mensajes que arma ella.
create or replace function public.aplicar_plantilla(p_clave text, p_vars jsonb, p_campo text default 'cuerpo')
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_texto text;
  v_linea text;
  v_salida text[] := '{}';
  v_var text;
  v_valor text;
  v_vacia boolean;
begin
  select case when p_campo = 'asunto'
              then coalesce(nullif(btrim(asunto), ''), asunto_original)
              else coalesce(nullif(btrim(cuerpo), ''), cuerpo_original) end
    into v_texto
    from plantillas_mensaje where clave = p_clave;
  if v_texto is null then
    raise exception 'No existe el mensaje "%".', p_clave;
  end if;

  foreach v_linea in array string_to_array(replace(v_texto, E'\r', ''), E'\n') loop
    v_vacia := false;
    for v_var in select (regexp_matches(v_linea, '\{([a-z_]+)\}', 'g'))[1] loop
      v_valor := p_vars ->> v_var;
      if v_valor is null or btrim(v_valor) = '' then
        v_vacia := true;
      end if;
      v_linea := replace(v_linea, '{' || v_var || '}', coalesce(v_valor, ''));
    end loop;
    if not v_vacia then
      v_salida := v_salida || v_linea;
    end if;
  end loop;

  return btrim(regexp_replace(array_to_string(v_salida, E'\n'), E'\n{3,}', E'\n\n', 'g'), E'\n ');
end;
$$;

grant execute on function public.aplicar_plantilla(text, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Las funciones que arman los WhatsApp, ahora con plantilla. Se regeneraron
-- desde la definición vigente cambiando solo el armado del texto.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.build_work_order_message(p_work_order_id uuid, p_status_id uuid, p_include_intro boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_base text;
  v_wo record;
  v_plantilla text;
  v_vehiculo text;
begin
  select value into v_base from app_settings where key = 'public_base_url';
  select body into v_plantilla from notification_templates where status_id = p_status_id;

  select wo.number, wo.component, wo.public_token,
         trim(coalesce(v.brand,'') || ' ' || coalesce(v.model,'')) as veh,
         v.license_plate,
         c.name as cliente
    into v_wo
    from work_orders wo
    left join vehicles v on v.id = wo.vehicle_id
    left join customers c on c.id = wo.customer_id
   where wo.id = p_work_order_id;

  v_vehiculo := nullif(v_wo.veh, '');
  if v_wo.license_plate is not null then
    v_vehiculo := coalesce(v_vehiculo, '') || ' (' || v_wo.license_plate || ')';
  end if;

  return aplicar_plantilla(
    case when p_include_intro then 'ot_alta' else 'ot_estado' end,
    jsonb_build_object(
      'cliente', v_wo.cliente,
      'orden', v_wo.number,
      'vehiculo', v_vehiculo,
      'componente', v_wo.component,
      'mensaje_estado', v_plantilla,
      'link', coalesce(v_base, '') || '/seguimiento/' || v_wo.public_token::text
    ));
end;
$function$;

CREATE OR REPLACE FUNCTION public.request_price_authorization(p_work_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wo work_orders%rowtype;
  v_quoted_total numeric;
  v_current_total numeric;
  v_base text;
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

  update work_orders
     set price_auth_status = 'PENDIENTE',
         price_auth_requested_total = v_current_total,
         price_auth_requested_at = now(),
         price_auth_decided_at = null,
         price_auth_reason = null
   where id = p_work_order_id;

  select value into v_base from app_settings where key = 'public_base_url';

  perform enqueue_notification(
    'CAMBIO_PRECIO',
    'ot:' || p_work_order_id::text || ':precio:' || v_current_total::text,
    aplicar_plantilla('ot_cambio_precio', jsonb_build_object(
      'cliente', (select name from customers where id = v_wo.customer_id),
      'orden', v_wo.number,
      'presupuesto_original', to_char(v_quoted_total, 'FM999999999.00'),
      'nuevo_monto', to_char(v_current_total, 'FM999999999.00'),
      'link', coalesce(v_base, '') || '/seguimiento/' || v_wo.public_token::text
    )),
    v_wo.customer_id,
    p_work_order_id
  );

  return 'PENDIENTE';
end;
$function$;

CREATE OR REPLACE FUNCTION public.enviar_cotizacion_para_autorizar(p_quotation_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if q.status not in ('EMITIDA', 'ENVIADA') then
    return 'YA_RESUELTA';
  end if;

  if not exists (select 1 from quotation_items where quotation_id = q.id) then
    return 'SIN_RENGLONES';
  end if;

  select value into v_base from app_settings where key = 'public_base_url';

  select coalesce(sum(subtotal), 0) * 1.21 into v_total
  from quotation_items where quotation_id = q.id;

  v_body := aplicar_plantilla('cotizacion_autorizar', jsonb_build_object(
    'cliente', (select name from customers where id = q.customer_id),
    'numero', q.number,
    'componente', q.component,
    'total', to_char(v_total, 'FM999999990.00'),
    'vencimiento', to_char(q.valid_until, 'DD/MM/YYYY'),
    'link', coalesce(v_base, '') || '/presupuesto/' || q.public_token::text
  ));

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

  if q.status = 'EMITIDA' then
    update quotations set status = 'ENVIADA' where id = q.id;
  end if;

  if v_id is null then
    return 'YA_ENCOLADA';
  end if;

  return 'ENVIADA';
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_pending_retention(p_receipt_value_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_value receipt_values%rowtype;
  v_receipt receipts%rowtype;
  v_tax_name text;
  v_body text;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_value from receipt_values where id = p_receipt_value_id;
  if not found then
    raise exception 'La retención no existe.';
  end if;
  if v_value.kind <> 'RETENCION' then
    raise exception 'Ese valor no es una retención.';
  end if;
  if v_value.certificate_number is not null then
    raise exception 'Esa retención ya tiene comprobante cargado.';
  end if;

  select * into v_receipt from receipts where id = v_value.receipt_id;
  if v_receipt.status <> 'REGISTRADO' then
    raise exception 'El recibo % está anulado.', v_receipt.full_number;
  end if;

  select name into v_tax_name from tax_rates where id = v_value.tax_rate_id;

  v_body := aplicar_plantilla('retencion_pendiente', jsonb_build_object(
    'cliente', v_receipt.customer_name,
    'numero', v_receipt.full_number,
    'fecha', to_char(v_receipt.receipt_date, 'DD/MM/YYYY'),
    'impuesto', coalesce(v_tax_name, 'impuestos'),
    'importe', to_char(v_value.amount, 'FM999999990.00')
  ));

  v_id := public.enqueue_notification(
    'RETENCION_PENDIENTE',
    'retencion:' || p_receipt_value_id::text || ':' || gen_random_uuid()::text,
    v_body,
    v_receipt.customer_id,
    null, null, null,
    p_receipt_value_id
  );

  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Verificación: con los textos de partida, un mensaje sin vehículo no deja
-- renglón en blanco.
-- ---------------------------------------------------------------------------
select aplicar_plantilla('ot_estado', jsonb_build_object(
  'orden', 'OT-1', 'vehiculo', null, 'componente', 'Bomba inyectora',
  'mensaje_estado', 'Su componente está listo para retirar.', 'link', 'https://x/seguimiento/abc'
)) as ejemplo;
