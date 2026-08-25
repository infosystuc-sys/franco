-- DieselPro ERP — informes, fase 1
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de todas las demás.
-- Este archivo queda además como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-25-informes-design.md
--
-- Por qué acá y no en el navegador:
--   PostgREST no sabe agrupar. Traer cinco mil comprobantes al cliente para
--   sumarlos anda con datos de prueba y se cae en producción.
--
-- Por qué SECURITY INVOKER y no DEFINER:
--   El RLS de las tablas ya dice "solo admin", así que estas funciones
--   heredan esa restricción sin abrir un camino privilegiado nuevo. Es la
--   diferencia con las RPC de los módulos operativos: aquéllas son DEFINER
--   porque necesitan escribir donde el RLS no deja; un informe solo lee.


-- ===========================================================================
-- 1) Ventas por período
-- ===========================================================================
create or replace function public.report_sales_by_period(p_from date, p_to date)
returns table (
  issue_date date,
  comprobante text,
  customer_name text,
  customer_tax_id text,
  net_amount numeric,
  vat_amount numeric,
  total_amount numeric,
  paid_amount numeric,
  balance numeric
)
language sql
stable
as $$
  select
    i.issue_date,
    i.invoice_type::text || ' ' || i.full_number,
    i.customer_name,
    i.customer_tax_id,
    i.net_amount,
    i.vat_amount,
    i.total_amount,
    i.paid_amount,
    i.total_amount - i.paid_amount
  from invoices i
  where i.status = 'EMITIDA'
    and i.issue_date between p_from and p_to
  order by i.issue_date, i.number;
$$;


-- ===========================================================================
-- 2) Ranking de clientes
-- ===========================================================================
create or replace function public.report_customer_ranking(p_from date, p_to date)
returns table (
  customer_name text,
  customer_tax_id text,
  comprobantes bigint,
  net_amount numeric,
  total_amount numeric,
  balance numeric
)
language sql
stable
as $$
  select
    i.customer_name,
    max(i.customer_tax_id),
    count(*),
    sum(i.net_amount),
    sum(i.total_amount),
    sum(i.total_amount - i.paid_amount)
  from invoices i
  where i.status = 'EMITIDA'
    and i.issue_date between p_from and p_to
  group by i.customer_name
  order by sum(i.total_amount) desc;
$$;


-- ===========================================================================
-- 3) Artículos y servicios más vendidos
-- ===========================================================================
-- Sale de los renglones de las facturas, no de las órdenes: lo que importa es
-- lo que se facturó, que puede diferir de lo que se cargó en el taller.
create or replace function public.report_top_articles(p_from date, p_to date)
returns table (
  code text,
  description text,
  quantity numeric,
  net_amount numeric,
  comprobantes bigint
)
language sql
stable
as $$
  select
    coalesce(ii.code, '—'),
    ii.description,
    sum(ii.quantity),
    sum(ii.subtotal),
    count(distinct ii.invoice_id)
  from invoice_items ii
  join invoices i on i.id = ii.invoice_id
  where i.status = 'EMITIDA'
    and i.issue_date between p_from and p_to
  group by coalesce(ii.code, '—'), ii.description
  order by sum(ii.subtotal) desc;
$$;


-- ===========================================================================
-- 4) Comparativo mensual
-- ===========================================================================
create or replace function public.report_monthly_sales(p_from date, p_to date)
returns table (
  periodo text,
  comprobantes bigint,
  net_amount numeric,
  vat_amount numeric,
  total_amount numeric
)
language sql
stable
as $$
  select
    to_char(date_trunc('month', i.issue_date), 'MM/YYYY'),
    count(*),
    sum(i.net_amount),
    sum(i.vat_amount),
    sum(i.total_amount)
  from invoices i
  where i.status = 'EMITIDA'
    and i.issue_date between p_from and p_to
  group by date_trunc('month', i.issue_date)
  order by date_trunc('month', i.issue_date);
$$;


-- ===========================================================================
-- 5) Composición de saldos — clientes
-- ===========================================================================
-- Una fila por comprobante con saldo. Es el detalle que respalda el total de
-- la cuenta corriente: sin él, el saldo es un número sin explicación.
create or replace function public.report_customer_balances()
returns table (
  customer_name text,
  comprobante text,
  issue_date date,
  due_date date,
  dias_vencido int,
  total_amount numeric,
  paid_amount numeric,
  balance numeric
)
language sql
stable
as $$
  select
    i.customer_name,
    i.invoice_type::text || ' ' || i.full_number,
    i.issue_date,
    i.due_date,
    greatest(0, current_date - i.due_date)::int,
    i.total_amount,
    i.paid_amount,
    i.total_amount - i.paid_amount
  from invoices i
  where i.status = 'EMITIDA'
    and i.total_amount - i.paid_amount > 0
  order by i.customer_name, i.issue_date;
$$;


-- ===========================================================================
-- 6) Antigüedad de saldos — clientes
-- ===========================================================================
-- Los tramos son los de cualquier sistema de gestión: a vencer, y después de
-- 30 en 30 hasta más de 90. Es el informe que dice a quién reclamar.
create or replace function public.report_customer_aging()
returns table (
  customer_name text,
  a_vencer numeric,
  d1_30 numeric,
  d31_60 numeric,
  d61_90 numeric,
  d90_mas numeric,
  total numeric
)
language sql
stable
as $$
  with saldos as (
    select
      i.customer_name,
      i.total_amount - i.paid_amount as saldo,
      current_date - i.due_date as dias
    from invoices i
    where i.status = 'EMITIDA'
      and i.total_amount - i.paid_amount > 0
  )
  select
    s.customer_name,
    coalesce(sum(s.saldo) filter (where s.dias <= 0), 0),
    coalesce(sum(s.saldo) filter (where s.dias between 1 and 30), 0),
    coalesce(sum(s.saldo) filter (where s.dias between 31 and 60), 0),
    coalesce(sum(s.saldo) filter (where s.dias between 61 and 90), 0),
    coalesce(sum(s.saldo) filter (where s.dias > 90), 0),
    sum(s.saldo)
  from saldos s
  group by s.customer_name
  order by sum(s.saldo) desc;
$$;


-- ===========================================================================
-- 7) Composición de saldos — proveedores
-- ===========================================================================
-- El importe lleva SIGNO: las notas de crédito restan de lo que se debe. Sin
-- eso, el detalle no sumaría el saldo que muestra la cuenta corriente.
create or replace function public.report_supplier_balances()
returns table (
  supplier_name text,
  comprobante text,
  issue_date date,
  due_date date,
  dias_vencido int,
  total_amount numeric,
  settled_amount numeric,
  balance numeric
)
language sql
stable
as $$
  select
    p.supplier_name,
    case p.doc_type
      when 'FACTURA' then 'FC'
      when 'NOTA_CREDITO' then 'NC'
      else 'ND'
    end || ' ' || p.letter::text || ' ' || p.full_number,
    p.issue_date,
    p.due_date,
    case when p.doc_type = 'NOTA_CREDITO' then 0
         else greatest(0, current_date - p.due_date)::int end,
    p.total_amount,
    p.settled_amount,
    (p.total_amount - p.settled_amount)
      * case when p.doc_type = 'NOTA_CREDITO' then -1 else 1 end
  from purchase_invoices p
  where p.status = 'REGISTRADA'
    and p.total_amount - p.settled_amount > 0
  order by p.supplier_name, p.issue_date;
$$;


-- ===========================================================================
-- 8) Antigüedad de saldos — proveedores
-- ===========================================================================
-- Las notas de crédito no vencen: van enteras a la columna "a vencer" en
-- negativo. Ponerlas en un tramo por antigüedad haría parecer que hay deuda
-- vieja donde en realidad hay crédito.
create or replace function public.report_supplier_aging()
returns table (
  supplier_name text,
  a_vencer numeric,
  d1_30 numeric,
  d31_60 numeric,
  d61_90 numeric,
  d90_mas numeric,
  total numeric
)
language sql
stable
as $$
  with saldos as (
    select
      p.supplier_name,
      (p.total_amount - p.settled_amount)
        * case when p.doc_type = 'NOTA_CREDITO' then -1 else 1 end as saldo,
      case when p.doc_type = 'NOTA_CREDITO' then -1
           else current_date - p.due_date end as dias
    from purchase_invoices p
    where p.status = 'REGISTRADA'
      and p.total_amount - p.settled_amount > 0
  )
  select
    s.supplier_name,
    coalesce(sum(s.saldo) filter (where s.dias <= 0), 0),
    coalesce(sum(s.saldo) filter (where s.dias between 1 and 30), 0),
    coalesce(sum(s.saldo) filter (where s.dias between 31 and 60), 0),
    coalesce(sum(s.saldo) filter (where s.dias between 61 and 90), 0),
    coalesce(sum(s.saldo) filter (where s.dias > 90), 0),
    sum(s.saldo)
  from saldos s
  group by s.supplier_name
  order by sum(s.saldo) desc;
$$;


-- ===========================================================================
-- 9) Permisos
-- ===========================================================================
-- Solo authenticated: el RLS de las tablas hace el resto. Un operario que
-- llame a estas funciones va a recibir cero filas, no un error, porque las
-- políticas de invoices y purchase_invoices ya lo filtran.
revoke all on function public.report_sales_by_period(date, date) from public, anon;
revoke all on function public.report_customer_ranking(date, date) from public, anon;
revoke all on function public.report_top_articles(date, date) from public, anon;
revoke all on function public.report_monthly_sales(date, date) from public, anon;
revoke all on function public.report_customer_balances() from public, anon;
revoke all on function public.report_customer_aging() from public, anon;
revoke all on function public.report_supplier_balances() from public, anon;
revoke all on function public.report_supplier_aging() from public, anon;

grant execute on function public.report_sales_by_period(date, date) to authenticated;
grant execute on function public.report_customer_ranking(date, date) to authenticated;
grant execute on function public.report_top_articles(date, date) to authenticated;
grant execute on function public.report_monthly_sales(date, date) to authenticated;
grant execute on function public.report_customer_balances() to authenticated;
grant execute on function public.report_customer_aging() to authenticated;
grant execute on function public.report_supplier_balances() to authenticated;
grant execute on function public.report_supplier_aging() to authenticated;
