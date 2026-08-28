-- DieselPro ERP — Facturar sin OT ni cotización
--
-- ⚠️ YA APLICADO en el proyecto Supabase "Ludiesel". Queda como registro
-- del esquema.
--
-- work_order_id pasa a ser opcional en invoices. Se factoriza el núcleo
-- común de issue_invoice en _create_invoice (security definer, no
-- ejecutable directo — revocada de public/anon/authenticated) para no
-- duplicar ~90 líneas entre el camino con OT y el libre.
--
--   issue_invoice       — camino con OT: valida que exista, esté Terminada
--                          y no tenga ya una factura, y delega el resto.
--   issue_free_invoice  — camino libre: sin esa validación porque no
--                          aplica, solo pide un cliente.
--
-- Los dos comparten formato de comprobante, numeración, cálculo de IVA,
-- cuenta corriente a 7 días y el remito opcional.

alter table invoices alter column work_order_id drop not null;

create or replace function public._create_invoice(
  p_work_order_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_notes text,
  p_emit_remito boolean
)
returns table(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_customer customers%rowtype;
  v_company company_settings%rowtype;
  v_type invoice_type;
  v_number int;
  v_net numeric(14,2);
  v_vat numeric(14,2);
  v_terms int := 7;   -- cuenta corriente a 7 días: la regla del taller, con o sin OT
  v_new_id uuid;
  v_full_number text;
  v_remito_id uuid;
  v_remito_number int;
  v_remito_full_number text;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La factura no tiene renglones cargados.';
  end if;

  select * into v_company from company_settings where company_settings.id = true;
  if not found or coalesce(trim(v_company.legal_name), '') = '' then
    raise exception 'Cargá los datos fiscales del taller en Configuración antes de facturar.';
  end if;

  select * into v_customer from customers where customers.id = p_customer_id;
  if not found then
    raise exception 'El cliente no existe.';
  end if;

  v_type := public.invoice_type_for(
    v_company.tax_condition,
    v_customer.tax_condition::text
  );

  select round(coalesce(sum(
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  ), 0), 2)
  into v_net
  from jsonb_array_elements(p_items) as item;

  if v_net <= 0 then
    raise exception 'El total de la factura tiene que ser mayor a cero.';
  end if;

  v_vat := case when v_type = 'C' then 0 else round(v_net * 0.21, 2) end;

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
    p_work_order_id, p_customer_id,
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
      v_company.sales_point, v_remito_number, v_new_id, p_customer_id,
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

revoke all on function public._create_invoice(uuid, uuid, jsonb, text, boolean) from public, anon, authenticated;

drop function if exists public.issue_invoice(uuid, jsonb, text, boolean);

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
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

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

  return query
  select * from public._create_invoice(p_work_order_id, v_wo.customer_id, p_items, p_notes, p_emit_remito);
end;
$function$;

create or replace function public.issue_free_invoice(
  p_customer_id uuid,
  p_items jsonb,
  p_notes text default null::text,
  p_emit_remito boolean default false
)
returns table(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  return query
  select * from public._create_invoice(null::uuid, p_customer_id, p_items, p_notes, p_emit_remito);
end;
$function$;
