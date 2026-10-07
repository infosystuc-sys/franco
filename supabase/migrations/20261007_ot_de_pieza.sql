-- Una OT puede ser de un vehículo o de una pieza suelta. El link público y
-- los mensajes de WhatsApp la mostraban siempre como vehículo: con patente (que
-- una pieza no tiene) y tipo de vehículo. Ahora dicen qué es y, si es una
-- pieza, su número.

drop function if exists public.get_public_work_order(uuid);

create function public.get_public_work_order(p_token uuid)
 RETURNS TABLE(number text, status_id uuid, component text, vehicle_brand text, vehicle_model text,
   license_plate text, vehicle_type text, vehicle_year integer, engine_brand text, engine_model text,
   injection_system text, employee_name text, customer_name text, price_auth_status text,
   price_auth_requested_total numeric, vehicle_kind text, reference_number text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    wo.number, wo.status_id, wo.component,
    v.brand, v.model, v.license_plate, v.vehicle_type, v.year,
    v.engine_brand, v.engine_model, v.injection_system,
    e.name, c.name,
    wo.price_auth_status, wo.price_auth_requested_total,
    v.kind::text, v.reference_number
  from work_orders wo
  left join vehicles v  on v.id = wo.vehicle_id
  left join employees e on e.id = wo.employee_id
  left join customers c on c.id = wo.customer_id
  where wo.public_token = p_token;
$function$;

grant execute on function public.get_public_work_order(uuid) to anon, authenticated;

create or replace function public.build_work_order_message(p_work_order_id uuid, p_status_id uuid, p_include_intro boolean)
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
         v.license_plate, v.reference_number, v.kind::text as kind,
         c.name as cliente
    into v_wo
    from work_orders wo
    left join vehicles v on v.id = wo.vehicle_id
    left join customers c on c.id = wo.customer_id
   where wo.id = p_work_order_id;

  v_vehiculo := nullif(v_wo.veh, '');
  if v_wo.kind = 'PIEZA' then
    -- Una pieza se identifica por su número, no por patente.
    v_vehiculo := 'Pieza: ' || coalesce(v_vehiculo, '') ||
      case when v_wo.reference_number is not null then ' (N° ' || v_wo.reference_number || ')' else '' end;
  elsif v_wo.license_plate is not null then
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

notify pgrst, 'reload schema';
