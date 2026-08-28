-- DieselPro ERP — Remito opcional al emitir la factura
--
-- ⚠️ YA APLICADO en el proyecto Supabase "Ludiesel". Queda como registro
-- del esquema.
--
-- Modelo: mismo patrón que invoices/invoice_items (punto de venta,
-- numeración propia con secuencia dedicada, full_number calculado), pero
-- SIN precios — un remito documenta qué salió del taller, no cuánto costó.
--
-- issue_invoice suma el parámetro p_emit_remito (default false): si es
-- true, crea el remito con los mismos renglones en la misma transacción de
-- la factura, así nunca queda una factura con el remito a medio crear.
-- void_invoice anula también el remito vinculado, si tenía uno emitido.
--
-- Mismo criterio de escritura que invoices: sin políticas de INSERT/UPDATE
-- para el cliente — todo pasa por issue_invoice/void_invoice (security
-- definer). Solo hay política de SELECT.

create table remitos (
  id uuid primary key default gen_random_uuid(),
  sales_point int not null,
  number int not null,
  full_number text generated always as (
    lpad(sales_point::text, 4, '0') || '-' || lpad(number::text, 8, '0')
  ) stored,
  status text not null default 'EMITIDO' check (status in ('EMITIDO', 'ANULADO')),
  invoice_id uuid not null references invoices(id),
  customer_id uuid not null references customers(id),
  customer_name text not null,
  customer_legal_name text,
  customer_tax_id text,
  customer_address text,
  issue_date date not null default current_date,
  notes text,
  voided_at timestamptz,
  voided_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (sales_point, number)
);

create table remito_items (
  id uuid primary key default gen_random_uuid(),
  remito_id uuid not null references remitos(id) on delete cascade,
  code text,
  description text not null,
  quantity numeric not null,
  line_number int not null
);

create table remito_sequences (
  sales_point int primary key,
  last_number int not null default 0
);

alter table remitos enable row level security;
alter table remito_items enable row level security;

create policy "solo admin" on remitos for select using (is_admin());
create policy "solo admin" on remito_items for select using (is_admin());

-- ===========================================================================
-- issue_invoice: firma nueva (suma p_emit_remito) y cuerpo completo
-- ===========================================================================
-- La versión anterior (sin remito) queda en supabase/invoicing.sql, sin
-- tocar — este drop+create es necesario porque cambia la firma (un
-- parámetro nuevo) y lo que devuelve (una columna nueva).
drop function if exists public.issue_invoice(uuid, jsonb, text);

create or replace function public.issue_invoice(
  p_work_order_id uuid,
  p_items jsonb,
  p_notes text default null::text,
  p_emit_remito boolean default false
)
returns table(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_wo work_orders%rowtype;
  v_customer customers%rowtype;
  v_company company_settings%rowtype;
  v_type invoice_type;
  v_number int;
  v_net numeric(14,2);
  v_vat numeric(14,2);
  v_terms int := 7;   -- cuenta corriente a 7 días: la regla del taller
  v_new_id uuid;
  v_full_number text;
  v_remito_id uuid;
  v_remito_number int;
  v_remito_full_number text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  -- for update: es lo que impide que un doble clic emita dos facturas.
  select * into v_wo from work_orders where work_orders.id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;
  if v_wo.status <> 'TERMINADO' then
    raise exception 'Solo se facturan órdenes terminadas (estado actual: %).', v_wo.status;
  end if;

  if exists (
    select 1 from invoices
    where invoices.work_order_id = p_work_order_id and invoices.status = 'EMITIDA'
  ) then
    raise exception 'La orden % ya tiene una factura emitida.', v_wo.number;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La factura no tiene renglones cargados.';
  end if;

  select * into v_company from company_settings where company_settings.id = true;
  if not found or coalesce(trim(v_company.legal_name), '') = '' then
    raise exception 'Cargá los datos fiscales del taller en Configuración antes de facturar.';
  end if;

  select * into v_customer from customers where customers.id = v_wo.customer_id;
  if not found then
    raise exception 'El cliente de la orden no existe.';
  end if;

  v_type := public.invoice_type_for(
    v_company.tax_condition,
    v_customer.tax_condition::text
  );

  -- Los renglones son NETOS (articles.unit_price lo es, ver price-lists.sql).
  select round(coalesce(sum(
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  ), 0), 2)
  into v_net
  from jsonb_array_elements(p_items) as item;

  if v_net <= 0 then
    raise exception 'El total de la factura tiene que ser mayor a cero.';
  end if;

  -- En C no hay IVA. En A se discrimina y en B va incluido, pero en ambas se
  -- guarda: ARCA lo pide también en la B, aunque no se imprima.
  v_vat := case when v_type = 'C' then 0 else round(v_net * 0.21, 2) end;

  -- Correlativo. El insert ... on conflict crea la fila la primera vez que se
  -- usa esa combinación de letra y punto de venta, y en ambos caminos deja la
  -- fila bloqueada hasta el commit.
  insert into invoice_sequences (invoice_type, sales_point, last_number)
  values (v_type, v_company.sales_point, 1)
  on conflict (invoice_type, sales_point)
    do update set last_number = invoice_sequences.last_number + 1
  returning invoice_sequences.last_number into v_number;

  insert into invoices (
    invoice_type, sales_point, number, status,
    work_order_id, customer_id,
    customer_name, customer_legal_name, customer_tax_id, customer_tax_condition, customer_address,
    issuer_legal_name, issuer_tax_id, issuer_tax_condition, issuer_address,
    issuer_gross_income, issuer_activity_start_date,
    issue_date, due_date, payment_terms_days,
    net_amount, vat_amount, total_amount,
    notes, created_by
  )
  values (
    v_type, v_company.sales_point, v_number, 'EMITIDA',
    p_work_order_id, v_wo.customer_id,
    v_customer.name, v_customer.legal_name, v_customer.tax_id,
    v_customer.tax_condition::text,
    nullif(concat_ws(', ',
      nullif(trim(coalesce(v_customer.address_street, '')), ''),
      nullif(trim(coalesce(v_customer.address_city, '')), ''),
      nullif(trim(coalesce(v_customer.address_state, '')), '')
    ), ''),
    v_company.legal_name, v_company.tax_id, v_company.tax_condition,
    nullif(concat_ws(', ',
      nullif(trim(coalesce(v_company.address_street, '')), ''),
      nullif(trim(coalesce(v_company.address_city, '')), ''),
      nullif(trim(coalesce(v_company.address_state, '')), '')
    ), ''),
    v_company.gross_income, v_company.activity_start_date,
    current_date, current_date + v_terms, v_terms,
    v_net, v_vat, v_net + v_vat,
    nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
  )
  returning invoices.id, invoices.full_number into v_new_id, v_full_number;

  insert into invoice_items (invoice_id, article_id, code, description, quantity, unit_price, subtotal, line_number)
  select
    v_new_id,
    nullif(item->>'article_id', '')::uuid,
    nullif(trim(coalesce(item->>'code', '')), ''),
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    round((item->>'quantity')::numeric * (item->>'unit_price')::numeric, 2),
    ord
  from jsonb_array_elements(p_items) with ordinality as t(item, ord);

  if p_emit_remito then
    insert into remito_sequences (sales_point, last_number)
    values (v_company.sales_point, 1)
    on conflict (sales_point) do update set last_number = remito_sequences.last_number + 1
    returning last_number into v_remito_number;

    insert into remitos (
      sales_point, number, invoice_id, customer_id,
      customer_name, customer_legal_name, customer_tax_id, customer_address,
      created_by
    )
    values (
      v_company.sales_point, v_remito_number, v_new_id, v_wo.customer_id,
      v_customer.name, v_customer.legal_name, v_customer.tax_id,
      nullif(concat_ws(', ',
        nullif(trim(coalesce(v_customer.address_street, '')), ''),
        nullif(trim(coalesce(v_customer.address_city, '')), ''),
        nullif(trim(coalesce(v_customer.address_state, '')), '')
      ), ''),
      auth.uid()
    )
    returning remitos.id, remitos.full_number into v_remito_id, v_remito_full_number;

    insert into remito_items (remito_id, code, description, quantity, line_number)
    select
      v_remito_id,
      nullif(trim(coalesce(item->>'code', '')), ''),
      item->>'description',
      (item->>'quantity')::numeric,
      ord
    from jsonb_array_elements(p_items) with ordinality as t(item, ord);
  end if;

  return query select v_new_id, v_full_number, v_type, v_remito_full_number;
end;
$function$;

-- ===========================================================================
-- void_invoice: anula también el remito vinculado, si tenía uno emitido
-- ===========================================================================
create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_invoice invoices%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_invoice from invoices where invoices.id = p_invoice_id for update;
  if not found then
    raise exception 'La factura no existe.';
  end if;
  if v_invoice.status = 'ANULADA' then
    raise exception 'La factura % ya está anulada.', v_invoice.full_number;
  end if;
  if v_invoice.paid_amount > 0 then
    raise exception 'La factura % tiene cobros imputados por $ %. Revertí los cobros antes de anularla.',
      v_invoice.full_number, v_invoice.paid_amount;
  end if;

  update invoices
  set status = 'ANULADA',
      voided_at = now(),
      voided_reason = trim(p_reason)
  where invoices.id = p_invoice_id;

  update remitos
  set status = 'ANULADO',
      voided_at = now(),
      voided_reason = 'Se anuló la factura ' || v_invoice.full_number
  where remitos.invoice_id = p_invoice_id and remitos.status = 'EMITIDO';
end;
$function$;
