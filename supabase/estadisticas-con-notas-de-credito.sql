-- ===========================================================================
-- Las notas de crédito restan en las estadísticas
-- ===========================================================================
-- Migración sugerida: estadisticas_con_notas_de_credito
--
-- Hasta ahora los informes de venta miraban solo la tabla invoices, así que
-- una factura revertida por una nota de crédito seguía contando entera. El
-- taller veía ventas que no ocurrieron.
--
-- ── Renglón negativo, no resta invisible ───────────────────────────────────
-- En los informes que listan comprobante por comprobante, la nota de crédito
-- aparece como una fila propia con importes en negativo, en vez de restarse
-- en silencio del renglón de la factura. Es más largo de escribir y es lo que
-- corresponde: un informe donde una factura de $ 100.000 figura como $ 0 no
-- deja ver qué pasó. Con la NC a la vista se entiende que hubo una venta y una
-- reversión, que es lo que un contador necesita reconstruir.
--
-- En los que agregan (ranking, mensual) la NC no puede ser una fila aparte,
-- así que se suma con signo negativo dentro del mismo grupo.
--
-- El Libro IVA Ventas es el caso donde esto no es una preferencia sino una
-- obligación: la nota de crédito es un comprobante fiscal y tiene que estar
-- listada con su número y su fecha.

-- ---------------------------------------------------------------------------
-- 1. Ventas del período: comprobante por comprobante
-- ---------------------------------------------------------------------------
create or replace function public.report_sales_by_period(p_from date, p_to date)
returns table(
  issue_date date, comprobante text, customer_name text, customer_tax_id text,
  net_amount numeric, vat_amount numeric, total_amount numeric,
  paid_amount numeric, balance numeric
)
language sql
stable
as $function$
  select
    i.issue_date,
    i.invoice_type::text || ' ' || i.full_number,
    i.customer_name,
    i.customer_tax_id,
    i.net_amount,
    i.vat_amount,
    i.total_amount,
    i.paid_amount,
    i.total_amount - i.paid_amount - i.credited_amount
  from invoices i
  where i.status = 'EMITIDA'
    and i.issue_date between p_from and p_to

  union all

  select
    nc.issue_date,
    'NC ' || nc.invoice_type::text || ' ' || nc.full_number,
    nc.customer_name,
    nc.customer_tax_id,
    -nc.net_amount,
    -nc.vat_amount,
    -nc.total_amount,
    0,
    0
  from credit_notes nc
  where nc.status = 'EMITIDA'
    and nc.issue_date between p_from and p_to

  -- Por posición: con union no se puede ordenar por columnas de una sola rama.
  order by 1, 2;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Ranking de clientes
-- ---------------------------------------------------------------------------
create or replace function public.report_customer_ranking(p_from date, p_to date)
returns table(
  customer_name text, customer_tax_id text, comprobantes bigint,
  net_amount numeric, total_amount numeric, balance numeric
)
language sql
stable
as $function$
  with movimientos as (
    select
      i.customer_name,
      i.customer_tax_id,
      i.net_amount,
      i.total_amount,
      i.total_amount - i.paid_amount - i.credited_amount as saldo
    from invoices i
    where i.status = 'EMITIDA'
      and i.issue_date between p_from and p_to

    union all

    -- La nota de crédito cuenta como comprobante y resta importe. No suma
    -- saldo: lo que la factura dejó de deber ya está descontado arriba, en
    -- credited_amount. Contarlo de nuevo acá lo restaría dos veces.
    select
      nc.customer_name,
      nc.customer_tax_id,
      -nc.net_amount,
      -nc.total_amount,
      0
    from credit_notes nc
    where nc.status = 'EMITIDA'
      and nc.issue_date between p_from and p_to
  )
  select
    m.customer_name,
    max(m.customer_tax_id),
    count(*),
    sum(m.net_amount),
    sum(m.total_amount),
    sum(m.saldo)
  from movimientos m
  group by m.customer_name
  order by sum(m.total_amount) desc;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Ventas por mes
-- ---------------------------------------------------------------------------
create or replace function public.report_monthly_sales(p_from date, p_to date)
returns table(
  periodo text, comprobantes bigint,
  net_amount numeric, vat_amount numeric, total_amount numeric
)
language sql
stable
as $function$
  with movimientos as (
    select i.issue_date, i.net_amount, i.vat_amount, i.total_amount
    from invoices i
    where i.status = 'EMITIDA' and i.issue_date between p_from and p_to

    union all

    select nc.issue_date, -nc.net_amount, -nc.vat_amount, -nc.total_amount
    from credit_notes nc
    where nc.status = 'EMITIDA' and nc.issue_date between p_from and p_to
  )
  select
    to_char(date_trunc('month', m.issue_date), 'MM/YYYY'),
    count(*),
    sum(m.net_amount),
    sum(m.vat_amount),
    sum(m.total_amount)
  from movimientos m
  group by date_trunc('month', m.issue_date)
  order by date_trunc('month', m.issue_date);
$function$;

-- ---------------------------------------------------------------------------
-- 4. Artículos vendidos
-- ---------------------------------------------------------------------------
-- Acá el signo importa doble: si una bomba se facturó y se devolvió, no se
-- vendió, y dejarla contada la pone arriba del ranking de lo más vendido.
create or replace function public.report_top_articles(p_from date, p_to date)
returns table(
  code text, description text, quantity numeric,
  net_amount numeric, comprobantes bigint
)
language sql
stable
as $function$
  with renglones as (
    select
      coalesce(ii.code, '—') as code,
      ii.description,
      ii.quantity,
      ii.subtotal,
      ii.invoice_id as comprobante_id
    from invoice_items ii
    join invoices i on i.id = ii.invoice_id
    where i.status = 'EMITIDA'
      and i.issue_date between p_from and p_to

    union all

    select
      coalesce(ni.code, '—'),
      ni.description,
      -ni.quantity,
      -ni.subtotal,
      ni.credit_note_id
    from credit_note_items ni
    join credit_notes nc on nc.id = ni.credit_note_id
    where nc.status = 'EMITIDA'
      and nc.issue_date between p_from and p_to
  )
  select
    r.code,
    r.description,
    sum(r.quantity),
    sum(r.subtotal),
    count(distinct r.comprobante_id)
  from renglones r
  group by r.code, r.description
  order by sum(r.subtotal) desc;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Libro IVA Ventas
-- ---------------------------------------------------------------------------
-- La nota de crédito va listada con su número y su fecha. No es una decisión
-- de presentación: es un comprobante fiscal y el libro lo tiene que contener.
create or replace function public.report_vat_sales(p_from date, p_to date)
returns table(
  issue_date date, tipo text, comprobante text, razon_social text,
  cuit text, condicion_iva text, neto numeric, iva numeric, total numeric
)
language sql
stable
as $function$
  select
    i.issue_date,
    'FACTURA ' || i.invoice_type::text,
    i.full_number,
    coalesce(i.customer_legal_name, i.customer_name),
    i.customer_tax_id,
    i.customer_tax_condition,
    i.net_amount,
    i.vat_amount,
    i.total_amount
  from invoices i
  where i.status = 'EMITIDA'
    and i.issue_date between p_from and p_to

  union all

  select
    nc.issue_date,
    'NOTA DE CREDITO ' || nc.invoice_type::text,
    nc.full_number,
    coalesce(nc.customer_legal_name, nc.customer_name),
    nc.customer_tax_id,
    nc.customer_tax_condition,
    -nc.net_amount,
    -nc.vat_amount,
    -nc.total_amount
  from credit_notes nc
  where nc.status = 'EMITIDA'
    and nc.issue_date between p_from and p_to

  order by 1, 2, 3;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Rentabilidad por orden de trabajo
-- ---------------------------------------------------------------------------
-- El ingreso baja, el costo no: el trabajo se hizo igual. Una orden revertida
-- por completo queda con margen negativo, que es exactamente lo que pasó.
create or replace function public.report_work_order_margin(p_from date, p_to date)
returns table(
  ot_number text, cliente text, fecha_factura date, ingreso numeric,
  costo_repuestos numeric, costo_mano_obra numeric, costo_total numeric,
  margen numeric, margen_pct numeric
)
language sql
stable
as $function$
  select
    wo.number,
    inv.customer_name,
    inv.issue_date,
    inv.net_amount - coalesce(acred.neto, 0),
    coalesce(parts.costo, 0),
    coalesce(labor.costo, 0),
    coalesce(parts.costo, 0) + coalesce(labor.costo, 0),
    (inv.net_amount - coalesce(acred.neto, 0)) - coalesce(parts.costo, 0) - coalesce(labor.costo, 0),
    case when inv.net_amount - coalesce(acred.neto, 0) > 0
      then round(
        (((inv.net_amount - coalesce(acred.neto, 0)) - coalesce(parts.costo, 0) - coalesce(labor.costo, 0))
          / (inv.net_amount - coalesce(acred.neto, 0))) * 100, 1)
      else 0
    end
  from invoices inv
  join work_orders wo on wo.id = inv.work_order_id
  left join lateral (
    select sum(nc.net_amount) as neto
      from credit_notes nc
     where nc.invoice_id = inv.id and nc.status = 'EMITIDA'
  ) acred on true
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
$function$;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select count(*) as reportes_que_miran_notas_de_credito
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'report_sales_by_period', 'report_customer_ranking', 'report_monthly_sales',
    'report_top_articles', 'report_vat_sales', 'report_work_order_margin'
  )
  and p.prosrc like '%credit_note%';
