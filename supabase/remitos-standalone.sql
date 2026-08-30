-- ===========================================================================
-- Remitos sin factura: entrega de mercadería pendiente de facturar
-- ===========================================================================
-- Migración: remitos_standalone
--
-- Hasta acá un remito solo podía nacer junto con una factura (issue_invoice /
-- issue_free_invoice con p_emit_remito). Esto agrega el camino inverso: crear
-- un remito solo (sin factura todavía) y facturarlo después.
--
-- remitos.invoice_id pasa a admitir null — un remito "pendiente" es el que
-- todavía no tiene factura. No se agrega un estado nuevo para esto: el
-- status EMITIDO/ANULADO sigue siendo si el documento en sí es válido: si
-- está pendiente o facturado se lee directo de si invoice_id es null.
--
-- remito_items suma article_id (las filas existentes quedan null: no hay
-- forma de reconstruirlo con certeza para lo ya emitido, y no hace falta —
-- solo se usa para sugerir precio al facturar un remito nuevo).

alter table public.remitos alter column invoice_id drop not null;
alter table public.remito_items add column article_id uuid references public.articles(id);

-- ── Crear un remito suelto ──────────────────────────────────────────────

create or replace function public.create_remito(
  p_customer_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns table(remito_id uuid, remito_full_number text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_customer customers%rowtype;
  v_company company_settings%rowtype;
  v_remito_id uuid;
  v_remito_number int;
  v_remito_full_number text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'El remito no tiene renglones cargados.';
  end if;

  select * into v_company from company_settings where company_settings.id = true;
  if not found then
    raise exception 'Cargá los datos del taller en Configuración antes de emitir un remito.';
  end if;

  select * into v_customer from customers where customers.id = p_customer_id;
  if not found then
    raise exception 'El cliente no existe.';
  end if;

  insert into remito_sequences (sales_point, last_number)
  values (v_company.sales_point, 1)
  on conflict (sales_point) do update set last_number = remito_sequences.last_number + 1
  returning last_number into v_remito_number;

  insert into remitos (
    sales_point, number, invoice_id, customer_id,
    customer_name, customer_legal_name, customer_tax_id, customer_address,
    notes, created_by
  )
  values (
    v_company.sales_point, v_remito_number, null, p_customer_id,
    v_customer.name, v_customer.legal_name, v_customer.tax_id,
    nullif(concat_ws(', ',
      nullif(trim(coalesce(v_customer.address_street, '')), ''),
      nullif(trim(coalesce(v_customer.address_city, '')), ''),
      nullif(trim(coalesce(v_customer.address_state, '')), '')
    ), ''),
    nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
  )
  returning remitos.id, remitos.full_number into v_remito_id, v_remito_full_number;

  insert into remito_items (remito_id, article_id, code, description, quantity, line_number)
  select
    v_remito_id,
    nullif(item->>'article_id', '')::uuid,
    nullif(trim(coalesce(item->>'code', '')), ''),
    item->>'description',
    (item->>'quantity')::numeric,
    ord
  from jsonb_array_elements(p_items) with ordinality as t(item, ord);

  return query select v_remito_id, v_remito_full_number;
end;
$$;

-- ── Anular un remito pendiente (todavía sin factura) ────────────────────

create or replace function public.void_remito(p_remito_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_remito remitos%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_remito from remitos where remitos.id = p_remito_id for update;
  if not found then
    raise exception 'El remito no existe.';
  end if;
  if v_remito.status = 'ANULADO' then
    raise exception 'El remito % ya está anulado.', v_remito.full_number;
  end if;
  if v_remito.invoice_id is not null then
    raise exception 'El remito % ya está facturado: para anularlo hay que anular la factura.', v_remito.full_number;
  end if;

  update remitos
     set status = 'ANULADO', voided_at = now(), voided_reason = trim(p_reason)
   where remitos.id = p_remito_id;
end;
$$;

-- ── _create_invoice: puede vincular un remito pendiente en vez de crear uno ──
--
-- Parámetro nuevo al final, con default: no cambia la firma para quien ya
-- la llama sin este argumento (issue_invoice, y issue_free_invoice hasta que
-- se actualice más abajo).

create or replace function public._create_invoice(
  p_work_order_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_notes text,
  p_emit_remito boolean,
  p_link_remito_id uuid default null
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
  v_link_remito remitos%rowtype;
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

  -- Si viene de un remito pendiente, se valida ANTES de tocar nada: mejor
  -- fallar temprano que dejar la factura ya creada y el vínculo roto.
  if p_link_remito_id is not null then
    select * into v_link_remito from remitos where remitos.id = p_link_remito_id for update;
    if not found then
      raise exception 'El remito no existe.';
    end if;
    if v_link_remito.status = 'ANULADO' then
      raise exception 'El remito % está anulado.', v_link_remito.full_number;
    end if;
    if v_link_remito.invoice_id is not null then
      raise exception 'El remito % ya está facturado.', v_link_remito.full_number;
    end if;
    if v_link_remito.customer_id <> p_customer_id then
      raise exception 'El remito % es de otro cliente.', v_link_remito.full_number;
    end if;
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

  if p_link_remito_id is not null then
    update remitos set invoice_id = v_new_id where remitos.id = p_link_remito_id;
    v_remito_full_number := v_link_remito.full_number;

  elsif p_emit_remito then
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

-- ── issue_free_invoice: puede facturar un remito pendiente ──────────────
--
-- Mismo motivo que _create_invoice: parámetro nuevo al final con default,
-- no rompe las llamadas existentes.

create or replace function public.issue_free_invoice(
  p_customer_id uuid,
  p_items jsonb,
  p_notes text default null::text,
  p_emit_remito boolean default false,
  p_remito_id uuid default null
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
  select * from public._create_invoice(null::uuid, p_customer_id, p_items, p_notes, p_emit_remito, p_remito_id);
end;
$function$;
