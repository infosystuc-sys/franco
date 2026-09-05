-- ===========================================================================
-- Aceptar la cotización llena la OT que ya existe
-- ===========================================================================
-- Migración: apply_quotation_to_work_order
--
-- Antes, aceptar CREABA la orden. Ahora la orden nació en la recepción, así
-- que aceptar copia los renglones adentro de la que ya está y la autoriza.
--
-- Una cotización suelta —el presupuesto por teléfono, sin OT enganchada— solo
-- queda aceptada: no hay dónde copiar los renglones ni contra qué descontar
-- stock. Eso ocurre después, cuando el cliente trae el vehículo, se abre la
-- OT y se le engancha esta cotización.

create or replace function public.apply_quotation_to_work_order(p_quotation_id uuid)
returns table (result_id uuid, result_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quotation quotations%rowtype;
  v_autorizada uuid;
  v_estado_actual text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_quotation from quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_quotation.status <> 'ACEPTADA' then
    raise exception 'Solo se aplican cotizaciones aceptadas (estado actual: %).', v_quotation.status;
  end if;

  -- Sin OT enganchada no hay nada que hacer todavía: es una cotización suelta.
  if v_quotation.work_order_id is null then
    return;
  end if;

  select s.label into v_estado_actual
  from work_orders w join work_order_statuses s on s.id = w.status_id
  where w.id = v_quotation.work_order_id;

  -- Aceptar dos veces no duplica nada: si la OT ya pasó de Autorizada porque
  -- el trabajo arrancó, no se vuelven a copiar renglones ni a descontar stock,
  -- y el estado no retrocede.
  if v_estado_actual not in ('Ingresado', 'Cotizado') then
    return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
    return;
  end if;

  if not exists (select 1 from quotation_items where quotation_id = p_quotation_id) then
    raise exception 'La cotización no tiene renglones cargados.';
  end if;

  select id into v_autorizada from work_order_statuses where label = 'Autorizada';
  if v_autorizada is null then
    raise exception 'Falta el estado "Autorizada" en el ABM de estados de OT.';
  end if;

  -- Al copiar los renglones se dispara el trigger de stock: acá sí se descuenta.
  insert into work_order_items (work_order_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_quotation.work_order_id, qi.article_id, qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi
  where qi.quotation_id = p_quotation_id;

  update work_orders set status_id = v_autorizada where id = v_quotation.work_order_id;

  return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
end;
$$;

grant execute on function public.apply_quotation_to_work_order(uuid) to authenticated;
