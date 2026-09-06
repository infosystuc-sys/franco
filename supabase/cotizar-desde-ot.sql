-- ===========================================================================
-- Cotizar desde la OT se lleva los renglones que ya tiene cargados
-- ===========================================================================
-- Migración: cotizar_desde_ot
--
-- El circuito de recepción se diseñó en un solo sentido: los renglones nacen
-- en la cotización y bajan a la orden al aceptarla. Pero el detalle de la OT
-- deja cargar renglones, y el botón Cotizar aparece igual —tenga o no tenga—,
-- así que el camino real del taller es el otro: se abre el vehículo, se carga
-- lo que lleva, y recién ahí se cotiza. Por ese camino la cotización nacía
-- vacía y había que tipear todo de nuevo.
--
-- Las dos mitades del arreglo son inseparables. Copiar los renglones hacia
-- adelante sin tocar la vuelta habría sido peor que el problema original:
-- aplicar_cotizacion_en_ot insertaba sin mirar lo que la orden ya tenía, así
-- que en cuanto la cotización llevara los mismos renglones, aceptarla los
-- duplicaba y descontaba el stock dos veces. Verificado antes de tocar nada:
-- una OT con 2 unidades cargadas terminaba con 4 y el stock bajaba de 40 a 36.


-- ── 1) Cotizar desde la orden, en una sola transacción ─────────────────────
-- Antes eran dos viajes desde el navegador (crear la cotización y engancharla)
-- y ahora habría sido un tercero. Una caída entre medio deja una cotización
-- suelta, ya numerada, que aparece en el listado sin pertenecer a nada.
create or replace function public.cotizar_desde_ot(
  p_work_order_id uuid,
  p_valid_until date default null
)
returns table (quotation_id uuid, quotation_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ot work_orders%rowtype;
  v_cot quotations%rowtype;
  v_cotizado uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_ot from work_orders where id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;

  -- Dos presupuestos sobre la misma orden dejan el control de precios
  -- comparando contra el que no es. Es el mismo resguardo que ya tenía
  -- link_quotation_to_work_order.
  if v_ot.quotation_id is not null then
    raise exception 'Esa orden ya tiene una cotización enganchada.';
  end if;

  -- La cabecera sale entera de la orden: lo observado al recibir es el
  -- contexto que necesita quien arma el precio.
  insert into quotations (customer_id, vehicle_id, component, notes, valid_until, work_order_id)
  values (v_ot.customer_id, v_ot.vehicle_id, v_ot.component, v_ot.observations,
          p_valid_until, p_work_order_id)
  returning * into v_cot;

  insert into quotation_items (quotation_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_cot.id, i.article_id, i.code, i.description, i.quantity, i.unit_price, i.subtotal
  from work_order_items i
  where i.work_order_id = p_work_order_id;

  update work_orders set quotation_id = v_cot.id where id = p_work_order_id;

  select id into v_cotizado from work_order_statuses where system_key = 'COTIZADO';
  if v_cotizado is null then
    raise exception 'Falta el estado cotizado del circuito. Revisá el ABM de estados de OT.';
  end if;

  -- Solo avanza si todavía está en la recepción: una orden que ya arrancó no
  -- retrocede porque alguien pida un presupuesto.
  update work_orders w
     set status_id = v_cotizado
    from work_order_statuses s
   where w.id = p_work_order_id and s.id = w.status_id and s.system_key = 'INGRESADO';

  return query select v_cot.id, v_cot.number;
end;
$$;

grant execute on function public.cotizar_desde_ot(uuid, date) to authenticated;


-- ── 2) Aplicar la cotización REEMPLAZA los renglones, no los suma ──────────
-- Único cambio respecto de la versión anterior: el delete antes del insert.
create or replace function public.aplicar_cotizacion_en_ot(p_quotation_id uuid)
returns table (result_id uuid, result_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quotation quotations%rowtype;
  v_autorizada uuid;
  v_clave_actual text;
begin
  select * into v_quotation from quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_quotation.status <> 'ACEPTADA' then
    raise exception 'Solo se aplican cotizaciones aceptadas (estado actual: %).', v_quotation.status;
  end if;

  if v_quotation.work_order_id is null then
    return;
  end if;

  select s.system_key into v_clave_actual
  from work_orders w join work_order_statuses s on s.id = w.status_id
  where w.id = v_quotation.work_order_id;

  -- Aplicar dos veces no duplica nada: si la orden ya arrancó el trabajo, no
  -- se vuelven a copiar renglones ni a descontar stock.
  if v_clave_actual is distinct from 'INGRESADO' and v_clave_actual is distinct from 'COTIZADO' then
    return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
    return;
  end if;

  if not exists (select 1 from quotation_items where quotation_id = p_quotation_id) then
    raise exception 'La cotización no tiene renglones cargados.';
  end if;

  select id into v_autorizada from work_order_statuses where system_key = 'AUTORIZADA';
  if v_autorizada is null then
    raise exception 'Falta el estado autorizada del circuito. Revisá el ABM de estados de OT.';
  end if;

  -- Reemplaza, no agrega. La orden puede llegar acá con renglones propios —el
  -- taller los carga al revisar el vehículo y de ahí sale el presupuesto— y
  -- sumarle encima los de la cotización los duplicaba. Borrarlos devuelve su
  -- stock; volver a insertarlos lo descuenta: si son los mismos, la cuenta no
  -- se mueve. Lo que queda en la orden es exactamente lo que el cliente aceptó,
  -- que es de lo que se lo va a facturar.
  delete from work_order_items where work_order_id = v_quotation.work_order_id;

  -- unit_cost se completa igual que en replace_work_order_items: es el costo
  -- histórico que alimenta el informe de margen, y la cotización no lo lleva.
  -- Sin esto el reemplazo borraría el costo que la orden ya tenía capturado, y
  -- el margen de esa OT pasaría a figurar como desconocido.
  insert into work_order_items (
    work_order_id, article_id, code, description, quantity, unit_price, subtotal, unit_cost
  )
  select
    v_quotation.work_order_id, qi.article_id, qi.code, qi.description,
    qi.quantity, qi.unit_price, qi.subtotal,
    (
      select sp.purchase_price
        from article_suppliers sp
       where sp.article_id = qi.article_id
         and sp.is_preferred
       limit 1
    )
  from quotation_items qi
  where qi.quotation_id = p_quotation_id;

  update work_orders set status_id = v_autorizada where id = v_quotation.work_order_id;

  return query select w.id, w.number from work_orders w where w.id = v_quotation.work_order_id;
end;
$$;
