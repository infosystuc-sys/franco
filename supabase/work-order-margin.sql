-- ===========================================================================
-- Rentabilidad bruta por orden de trabajo
-- ===========================================================================
-- Migración: work-order-margin
--
-- Cruza lo facturado de una OT con el costo real de los repuestos que se
-- usaron y el costo de las horas trabajadas, para dar un margen bruto real
-- por trabajo (y el total del período).
--
-- Tres piezas nuevas:
--   1) employees.hourly_cost — no existía ningún dato de costo por
--      empleado. Nullable: un empleado sin costo cargado simplemente no
--      aporta costo de mano de obra al margen (no rompe el cálculo).
--   2) work_order_items.unit_cost — costo HISTÓRICO del repuesto, capturado
--      al momento de cargarlo en la OT (el purchase_price del proveedor
--      preferido en ese momento). No se recalcula después: si el costo de
--      compra cambia más adelante, el margen de una OT vieja tiene que
--      seguir reflejando lo que costó en su momento, no lo que cuesta hoy.
--   3) report_work_order_margin — el informe. Ingreso = lo FACTURADO
--      (invoices.net_amount, sin IVA), no work_order_items.subtotal: una OT
--      puede editarse después de facturada y el subtotal cargado ya no
--      coincidir con lo que realmente se cobró. Solo entran OTs con
--      factura emitida — sin factura no hay ingreso real que margenear.
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de work-order-stage-assignments.sql.


-- ===========================================================================
-- 1) Costo por hora del empleado
-- ===========================================================================
alter table employees add column hourly_cost numeric check (hourly_cost >= 0);


-- ===========================================================================
-- 2) Costo histórico del repuesto en la OT
-- ===========================================================================
alter table work_order_items add column unit_cost numeric;

-- Reemplaza replace_work_order_items para completar unit_cost al guardar:
-- toma el purchase_price del proveedor preferido del artículo en ESE
-- momento. Null si el renglón no tiene article_id (cargado a mano, ej. mano
-- de obra) o el artículo no tiene proveedor preferido — el informe lo trata
-- como costo desconocido, no como cero.
create or replace function public.replace_work_order_items(p_work_order_id uuid, p_items jsonb)
returns void
language plpgsql
as $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  delete from work_order_items where work_order_id = p_work_order_id;

  insert into work_order_items (
    work_order_id, article_id, code, description, quantity, unit_price, subtotal, unit_cost
  )
  select
    p_work_order_id,
    nullif(item->>'article_id', '')::uuid,
    item->>'code',
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric,
    (
      select sp.purchase_price
        from article_suppliers sp
       where sp.article_id = nullif(item->>'article_id', '')::uuid
         and sp.is_preferred
       limit 1
    )
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item;
end;
$function$;


-- ===========================================================================
-- 3) Informe de rentabilidad
-- ===========================================================================
-- Mano de obra: horas reales trabajadas por cada empleado en la OT, desde
-- work_order_stage_assignments (ya existe, ver work-order-stage-assignments.sql)
-- × su costo por hora. Cuenta todos los tramos de la OT sin importar cuándo
-- pasaron — el período del informe filtra QUÉ OTs entran (por fecha de
-- factura), no qué tramos de una OT ya elegida cuentan.
--
-- Dos correcciones sobre el tramo crudo:
--
--   1) El tramo del estado FINAL (is_terminal, hoy solo "Terminado") no es
--      trabajo: es la espera entre que se terminó y se facturó. Contarlo
--      como mano de obra cobraría por tener la OT guardada, no por
--      trabajarla — se excluye directo.
--   2) El tramo ABIERTO de una OT que ya llegó a su estado final nunca se
--      cierra solo (el trigger de work-order-stage-assignments.sql solo
--      cierra un tramo cuando la OT vuelve a cambiar de estado o de
--      empleado). Por las dudas de que quede un tramo NO terminal abierto
--      (la OT se facturó sin pasar por el flujo normal), se lo acota a la
--      fecha de facturación en vez de now(): lo que pasó después de
--      facturar no es costo de ESTA factura.
create or replace function public.report_work_order_margin(p_from date, p_to date)
returns table (
  ot_number text,
  cliente text,
  fecha_factura date,
  ingreso numeric,
  costo_repuestos numeric,
  costo_mano_obra numeric,
  costo_total numeric,
  margen numeric,
  margen_pct numeric
)
language sql
stable
as $$
  select
    wo.number,
    inv.customer_name,
    inv.issue_date,
    inv.net_amount,
    coalesce(parts.costo, 0),
    coalesce(labor.costo, 0),
    coalesce(parts.costo, 0) + coalesce(labor.costo, 0),
    inv.net_amount - coalesce(parts.costo, 0) - coalesce(labor.costo, 0),
    case when inv.net_amount > 0
      then round(((inv.net_amount - coalesce(parts.costo, 0) - coalesce(labor.costo, 0)) / inv.net_amount) * 100, 1)
      else 0
    end
  from invoices inv
  join work_orders wo on wo.id = inv.work_order_id
  left join lateral (
    select sum(quantity * coalesce(unit_cost, 0)) as costo
      from work_order_items
     where work_order_id = wo.id
  ) parts on true
  left join lateral (
    select sum(
      extract(epoch from (
        least(coalesce(a.ended_at, now()), inv.issue_date::timestamptz + interval '1 day') - a.started_at
      )) / 3600 * coalesce(e.hourly_cost, 0)
    ) as costo
      from work_order_stage_assignments a
      join work_order_statuses ws on ws.id = a.status_id
      left join employees e on e.id = a.employee_id
     where a.work_order_id = wo.id
       and not ws.is_terminal
       and a.started_at < inv.issue_date::timestamptz + interval '1 day'
  ) labor on true
  where inv.status = 'EMITIDA'
    and inv.issue_date between p_from and p_to
  order by inv.issue_date desc, wo.number desc;
$$;

revoke all on function public.report_work_order_margin(date, date) from public, anon;
grant execute on function public.report_work_order_margin(date, date) to authenticated;


comment on column work_order_items.unit_cost is
  'Costo del repuesto (purchase_price del proveedor preferido) al momento de '
  'cargar el renglón en la OT. Histórico: no se recalcula si el costo de '
  'compra cambia después.';

comment on column employees.hourly_cost is
  'Costo por hora del empleado, para calcular el costo de mano de obra en '
  'el margen bruto por OT (report_work_order_margin). Null = no aporta '
  'costo de mano de obra al cálculo.';
