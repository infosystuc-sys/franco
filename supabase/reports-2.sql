-- DieselPro ERP — informes, fase 2: impositivos, stock y tesorería
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de reports.sql.
-- Este archivo queda además como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-25-informes-design.md
--
-- Mismo criterio que la fase 1: funciones SECURITY INVOKER, porque el RLS de
-- las tablas ya restringe a admin y un informe solo lee.
--
-- Los libros de IVA salen como planilla legible. El archivo de importación de
-- ARCA queda pendiente de la especificación: es de ancho fijo con posiciones
-- exactas, y escribirlo de memoria produciría un archivo que el aplicativo
-- rechaza sin explicar, o que acepta con los datos corridos.


-- ===========================================================================
-- 1) Libro IVA Ventas
-- ===========================================================================
-- Las ventas llevan una sola alícuota, así que no hace falta abrir el neto
-- por porcentaje como en compras.
create or replace function public.report_vat_sales(p_from date, p_to date)
returns table (
  issue_date date,
  tipo text,
  comprobante text,
  razon_social text,
  cuit text,
  condicion_iva text,
  neto numeric,
  iva numeric,
  total numeric
)
language sql
stable
as $$
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
  order by i.issue_date, i.invoice_type, i.number;
$$;


-- ===========================================================================
-- 2) Libro IVA Compras
-- ===========================================================================
-- Las notas de crédito van con TODOS sus importes en negativo. Así la fila de
-- totales da el neto del período, que es lo que el contador necesita: si
-- fueran positivas, el libro sumaría de más justamente en los meses en que
-- hubo devoluciones.
create or replace function public.report_vat_purchases(p_from date, p_to date)
returns table (
  issue_date date,
  tipo text,
  comprobante text,
  razon_social text,
  cuit text,
  condicion_iva text,
  neto_gravado numeric,
  iva numeric,
  neto_exento numeric,
  neto_no_gravado numeric,
  percepciones numeric,
  total numeric
)
language sql
stable
as $$
  with signo as (
    select
      p.*,
      case when p.doc_type = 'NOTA_CREDITO' then -1 else 1 end as s
    from purchase_invoices p
    where p.status = 'REGISTRADA'
      and p.issue_date between p_from and p_to
  )
  select
    x.issue_date,
    case x.doc_type
      when 'FACTURA' then 'FACTURA '
      when 'NOTA_CREDITO' then 'NOTA DE CREDITO '
      else 'NOTA DE DEBITO '
    end || x.letter::text,
    x.full_number,
    coalesce(x.supplier_legal_name, x.supplier_name),
    x.supplier_tax_id,
    x.supplier_tax_condition,
    x.net_taxed * x.s,
    x.vat_amount * x.s,
    x.net_exempt * x.s,
    x.net_untaxed * x.s,
    x.other_taxes_amount * x.s,
    x.total_amount * x.s
  from signo x
  order by x.issue_date, x.number;
$$;


-- ===========================================================================
-- 3) Retenciones sufridas
-- ===========================================================================
-- Las que el cliente nos practicó al pagarnos: son crédito fiscal.
create or replace function public.report_retentions_suffered(p_from date, p_to date)
returns table (
  receipt_date date,
  recibo text,
  cliente text,
  impuesto text,
  jurisdiccion text,
  certificado text,
  importe numeric
)
language sql
stable
as $$
  select
    r.receipt_date,
    r.full_number,
    r.customer_name,
    t.name,
    t.jurisdiction,
    coalesce(v.certificate_number, '—'),
    v.amount
  from receipt_values v
  join receipts r on r.id = v.receipt_id
  join tax_rates t on t.id = v.tax_rate_id
  where v.kind = 'RETENCION'
    and r.status = 'REGISTRADO'
    and r.receipt_date between p_from and p_to
  order by r.receipt_date, r.number;
$$;


-- ===========================================================================
-- 4) Retenciones practicadas
-- ===========================================================================
-- Las que el taller le retuvo al proveedor: son deuda con ARCA.
create or replace function public.report_retentions_applied(p_from date, p_to date)
returns table (
  payment_date date,
  orden text,
  proveedor text,
  cuit text,
  impuesto text,
  jurisdiccion text,
  certificado text,
  importe numeric
)
language sql
stable
as $$
  select
    o.payment_date,
    o.full_number,
    o.supplier_name,
    s.tax_id,
    t.name,
    t.jurisdiction,
    coalesce(v.certificate_number, '—'),
    v.amount
  from payment_order_values v
  join payment_orders o on o.id = v.payment_order_id
  join tax_rates t on t.id = v.tax_rate_id
  left join suppliers s on s.id = o.supplier_id
  where v.kind = 'RETENCION'
    and o.status = 'REGISTRADA'
    and o.payment_date between p_from and p_to
  order by o.payment_date, o.number;
$$;


-- ===========================================================================
-- 5) Stock valorizado
-- ===========================================================================
-- Se valoriza al precio de COMPRA del proveedor preferido, no al de venta:
-- el stock es plata inmovilizada, y lo que costó es lo que se inmovilizó.
create or replace function public.report_stock_valued()
returns table (
  code text,
  description text,
  stock numeric,
  precio_compra numeric,
  valorizado numeric,
  precio_venta numeric,
  proveedor text
)
language sql
stable
as $$
  select
    a.code,
    a.description,
    a.stock_quantity,
    coalesce(sp.purchase_price, 0),
    a.stock_quantity * coalesce(sp.purchase_price, 0),
    a.unit_price,
    coalesce(s.name, '—')
  from articles a
  left join article_suppliers sp on sp.article_id = a.id and sp.is_preferred
  left join suppliers s on s.id = sp.supplier_id
  where a.active and a.tracks_stock
  order by a.stock_quantity * coalesce(sp.purchase_price, 0) desc;
$$;


-- ===========================================================================
-- 6) Artículos sin movimiento
-- ===========================================================================
-- Tienen stock pero no se facturaron en el período: es capital inmovilizado.
-- Se mira contra lo FACTURADO y no contra las órdenes, porque una orden
-- abierta todavía no consumió nada desde el punto de vista comercial.
create or replace function public.report_idle_stock(p_from date, p_to date)
returns table (
  code text,
  description text,
  stock numeric,
  precio_compra numeric,
  valorizado numeric,
  ultima_venta date
)
language sql
stable
as $$
  select
    a.code,
    a.description,
    a.stock_quantity,
    coalesce(sp.purchase_price, 0),
    a.stock_quantity * coalesce(sp.purchase_price, 0),
    (select max(i.issue_date)
       from invoice_items ii
       join invoices i on i.id = ii.invoice_id
      where ii.article_id = a.id and i.status = 'EMITIDA')
  from articles a
  left join article_suppliers sp on sp.article_id = a.id and sp.is_preferred
  where a.active
    and a.tracks_stock
    and a.stock_quantity > 0
    and not exists (
      select 1
        from invoice_items ii
        join invoices i on i.id = ii.invoice_id
       where ii.article_id = a.id
         and i.status = 'EMITIDA'
         and i.issue_date between p_from and p_to
    )
  order by a.stock_quantity * coalesce(sp.purchase_price, 0) desc;
$$;


-- ===========================================================================
-- 7) Libro de caja
-- ===========================================================================
-- Una fila por PARTIDA, no por movimiento: una transferencia tiene que
-- aparecer dos veces, saliendo de un medio y entrando en otro, o el libro no
-- explicaría el saldo de ninguno de los dos.
create or replace function public.report_cash_book(p_from date, p_to date)
returns table (
  movement_date date,
  comprobante text,
  tipo text,
  detalle text,
  concepto text,
  beneficiario text,
  medio text,
  ingreso numeric,
  egreso numeric
)
language sql
stable
as $$
  select
    m.movement_date,
    m.full_number,
    m.movement_type::text,
    m.description,
    coalesce(c.name, '—'),
    coalesce(m.payee, '—'),
    pm.name,
    case when l.amount > 0 then l.amount else 0 end,
    case when l.amount < 0 then -l.amount else 0 end
  from treasury_movement_legs l
  join treasury_movements m on m.id = l.movement_id
  join payment_methods pm on pm.id = l.payment_method_id
  left join expense_concepts c on c.id = m.concept_id
  where m.status = 'REGISTRADO'
    and m.movement_date between p_from and p_to
  order by m.movement_date, m.full_number, pm.name;
$$;


-- ===========================================================================
-- 8) Arqueo por medio de pago
-- ===========================================================================
create or replace function public.report_cash_count()
returns table (
  medio text,
  tipo text,
  saldo_inicial numeric,
  movimientos numeric,
  saldo numeric
)
language sql
stable
as $$
  select
    b.name,
    b.kind::text,
    b.opening_balance,
    b.balance - b.opening_balance,
    b.balance
  from payment_method_balances b
  where b.active
  order by b.kind, b.name;
$$;


-- ===========================================================================
-- 9) Cheques en cartera
-- ===========================================================================
-- Los depositados siguen contando: la plata no entró hasta que el banco
-- acredita, así que el riesgo sigue siendo del taller.
create or replace function public.report_checks_portfolio()
returns table (
  due_date date,
  dias int,
  numero text,
  banco text,
  librador text,
  estado text,
  depositado_en text,
  importe numeric
)
language sql
stable
as $$
  select
    c.due_date,
    (c.due_date - current_date)::int,
    c.number,
    c.bank_name,
    coalesce(c.drawer, '—'),
    c.status::text,
    coalesce(pm.name, '—'),
    c.amount
  from third_party_checks c
  left join payment_methods pm on pm.id = c.deposited_to_id
  where c.status in ('EN_CARTERA', 'DEPOSITADO')
  order by c.due_date;
$$;


-- ===========================================================================
-- 10) Permisos
-- ===========================================================================
revoke all on function public.report_vat_sales(date, date) from public, anon;
revoke all on function public.report_vat_purchases(date, date) from public, anon;
revoke all on function public.report_retentions_suffered(date, date) from public, anon;
revoke all on function public.report_retentions_applied(date, date) from public, anon;
revoke all on function public.report_stock_valued() from public, anon;
revoke all on function public.report_idle_stock(date, date) from public, anon;
revoke all on function public.report_cash_book(date, date) from public, anon;
revoke all on function public.report_cash_count() from public, anon;
revoke all on function public.report_checks_portfolio() from public, anon;

grant execute on function public.report_vat_sales(date, date) to authenticated;
grant execute on function public.report_vat_purchases(date, date) to authenticated;
grant execute on function public.report_retentions_suffered(date, date) to authenticated;
grant execute on function public.report_retentions_applied(date, date) to authenticated;
grant execute on function public.report_stock_valued() to authenticated;
grant execute on function public.report_idle_stock(date, date) to authenticated;
grant execute on function public.report_cash_book(date, date) to authenticated;
grant execute on function public.report_cash_count() to authenticated;
grant execute on function public.report_checks_portfolio() to authenticated;
