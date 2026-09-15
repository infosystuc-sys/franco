-- Funciones (112), orden alfabetico por nombre.
-- CREATE OR REPLACE: se pueden volver a correr sin romper nada.

CREATE OR REPLACE FUNCTION public._create_invoice(p_work_order_id uuid, p_customer_id uuid, p_items jsonb, p_notes text, p_emit_remito boolean, p_link_remito_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.adjust_article_stock(p_article_id uuid, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tracks boolean;
  v_stock numeric;
  v_code text;
begin
  if p_article_id is null or p_delta = 0 then
    return;
  end if;

  select tracks_stock, stock_quantity, code
    into v_tracks, v_stock, v_code
    from articles
   where id = p_article_id
     for update;

  if not found or not v_tracks then
    return;
  end if;

  if v_stock + p_delta < 0 then
    raise exception 'Stock insuficiente para el artículo % (disponible: %, solicitado: %)',
      v_code, v_stock, abs(p_delta);
  end if;

  update articles set stock_quantity = stock_quantity + p_delta where id = p_article_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.aplicar_cotizacion_en_ot(p_quotation_id uuid)
 RETURNS TABLE(result_id uuid, result_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quotation quotations%rowtype;
  v_autorizada uuid;
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

  if not public.cotizacion_sigue_decidible(v_quotation.work_order_id) then
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

  delete from work_order_items where work_order_id = v_quotation.work_order_id;

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
$function$
;

CREATE OR REPLACE FUNCTION public.apply_quotation_to_work_order(p_quotation_id uuid)
 RETURNS TABLE(result_id uuid, result_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  return query select * from public.aplicar_cotizacion_en_ot(p_quotation_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.article_components_un_solo_nivel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if exists (select 1 from article_components where combo_article_id = new.component_article_id) then
    raise exception 'Ese artículo ya es un combo: no se puede meter un combo adentro de otro.';
  end if;
  if exists (select 1 from article_components where component_article_id = new.combo_article_id) then
    raise exception 'Ese artículo ya forma parte de otro combo: no puede ser combo a la vez.';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.article_suppliers_recalc()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_article uuid;
  v_price numeric;
  v_markup numeric;
begin
  v_article := coalesce(new.article_id, old.article_id);

  select markup_percent into v_markup from articles where id = v_article;
  if not found then
    return null;
  end if;

  v_price := compute_sale_price(v_article, v_markup);

  if v_price is not null then
    update articles set unit_price = v_price where id = v_article;
  end if;

  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.articles_recalc_on_markup()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_price numeric;
begin
  if new.markup_percent is distinct from old.markup_percent then
    v_price := compute_sale_price(new.id, new.markup_percent);
    if v_price is not null then
      new.unit_price := v_price;
    end if;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.articles_track_price_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.unit_price is distinct from old.unit_price then
    new.price_updated_at := now();
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.block_terminal_while_price_pending()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_is_terminal boolean;
  v_era_terminal boolean;
  v_quoted_total numeric;
  v_current_total numeric;
begin
  if new.status_id is distinct from old.status_id and new.quotation_id is not null then
    select is_terminal into v_is_terminal from work_order_statuses where id = new.status_id;
    select is_terminal into v_era_terminal from work_order_statuses where id = old.status_id;

    if v_is_terminal and not coalesce(v_era_terminal, false) then
      select coalesce(sum(subtotal), 0) into v_quoted_total
        from quotation_items where quotation_id = new.quotation_id;
      select coalesce(sum(subtotal), 0) into v_current_total
        from work_order_items where work_order_id = new.id;

      if v_current_total <> v_quoted_total
         and (new.price_auth_status is distinct from 'AUTORIZADO'
              or new.price_auth_requested_total is distinct from v_current_total)
      then
        raise exception 'No se puede cerrar la OT: el monto cambió respecto al presupuesto original y no está autorizado por el cliente.';
      end if;
    end if;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.borrar_certificado_arca(p_proposito text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  delete from arca_credentials where proposito = p_proposito;
  delete from arca_tickets where servicio is not null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.borrar_clave_ia(p_provider text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  delete from ai_credentials where provider = p_provider;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.build_work_order_message(p_work_order_id uuid, p_status_id uuid, p_include_intro boolean)
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
         v.license_plate
    into v_wo
    from work_orders wo
    left join vehicles v on v.id = wo.vehicle_id
   where wo.id = p_work_order_id;

  v_vehiculo := nullif(v_wo.veh, '');
  if v_wo.license_plate is not null then
    v_vehiculo := coalesce(v_vehiculo, '') || ' (' || v_wo.license_plate || ')';
  end if;

  return
    case when p_include_intro
      then 'Hola, le compartimos el seguimiento de su reparación.' || E'\n\n'
      else '' end ||
    'Orden ' || v_wo.number ||
    coalesce(E'\n' || v_vehiculo, '') ||
    coalesce(E'\n' || v_wo.component, '') || E'\n\n' ||
    coalesce(v_plantilla, '') || E'\n\n' ||
    'Puede seguir el avance acá:' || E'\n' ||
    coalesce(v_base, '') || '/seguimiento/' || v_wo.public_token::text;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.checks_wallet_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from payment_methods where kind = 'CARTERA_CHEQUES' limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_pending_notifications(p_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, to_phone text, body text, media_url text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  with tomadas as (
    select n.id from notifications n
    where n.status = 'PENDIENTE'
      and n.attempts < 5
    order by n.created_at
    limit p_limit
    for update skip locked
  )
  update notifications n
     set attempts = n.attempts + 1
    from tomadas
   where n.id = tomadas.id
  returning n.id, n.to_phone, n.body, n.media_url;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.claim_pending_retention(p_receipt_value_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_value receipt_values%rowtype;
  v_receipt receipts%rowtype;
  v_tax_name text;
  v_body text;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_value from receipt_values where id = p_receipt_value_id;
  if not found then
    raise exception 'La retención no existe.';
  end if;
  if v_value.kind <> 'RETENCION' then
    raise exception 'Ese valor no es una retención.';
  end if;
  if v_value.certificate_number is not null then
    raise exception 'Esa retención ya tiene comprobante cargado.';
  end if;

  select * into v_receipt from receipts where id = v_value.receipt_id;
  if v_receipt.status <> 'REGISTRADO' then
    raise exception 'El recibo % está anulado.', v_receipt.full_number;
  end if;

  select name into v_tax_name from tax_rates where id = v_value.tax_rate_id;

  v_body :=
    'Hola ' || v_receipt.customer_name || ', en el recibo ' || v_receipt.full_number ||
    ' del ' || to_char(v_receipt.receipt_date, 'DD/MM/YYYY') ||
    ' quedó pendiente el comprobante de la retención de ' || coalesce(v_tax_name, 'impuestos') ||
    ' por $ ' || to_char(v_value.amount, 'FM999999990.00') ||
    '. Por favor envíenoslo para nuestros registros. Gracias.';

  v_id := public.enqueue_notification(
    'RETENCION_PENDIENTE',
    'retencion:' || p_receipt_value_id::text || ':' || gen_random_uuid()::text,
    v_body,
    v_receipt.customer_id,
    null, null, null,
    p_receipt_value_id
  );

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.compute_sale_price(p_article_id uuid, p_markup numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_purchase numeric;
begin
  select purchase_price into v_purchase
  from article_suppliers
  where article_id = p_article_id and is_preferred
  limit 1;

  if v_purchase is null then
    return null;
  end if;

  return ceil(v_purchase * (1 + public.effective_markup(p_markup) / 100.0) / 10) * 10;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.cotizacion_sigue_decidible(p_work_order_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when p_work_order_id is null then true
    else not (
      coalesce((select s.is_terminal from work_orders w
                 join work_order_statuses s on s.id = w.status_id
                where w.id = p_work_order_id), false)
      or
      exists (select 1 from invoices i
               where i.work_order_id = p_work_order_id and i.status <> 'ANULADA')
    )
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.cotizar_desde_ot(p_work_order_id uuid, p_valid_until date DEFAULT NULL::date)
 RETURNS TABLE(quotation_id uuid, quotation_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if v_ot.quotation_id is not null then
    raise exception 'Esa orden ya tiene una cotización enganchada.';
  end if;

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

  if not exists (
    select 1 from invoices i
     where i.work_order_id = p_work_order_id and i.status <> 'ANULADA'
  ) then
    update work_orders set status_id = v_cotizado where id = p_work_order_id;
  end if;

  return query select v_cot.id, v_cot.number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_remito(p_customer_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(remito_id uuid, remito_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.credit_check(p_check_id uuid, p_date date DEFAULT CURRENT_DATE)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_check third_party_checks%rowtype;
  v_wallet uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_check from third_party_checks
   where third_party_checks.id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if v_check.status <> 'DEPOSITADO' then
    raise exception 'Solo se acreditan cheques depositados (estado actual: %).', v_check.status;
  end if;

  v_wallet := public.checks_wallet_id();

  perform public.post_treasury_movement(
    'TRANSFERENCIA', coalesce(p_date, current_date), null,
    'Acreditación cheque ' || v_check.number || ' — ' || v_check.bank_name,
    v_check.drawer, v_check.amount,
    jsonb_build_array(
      jsonb_build_object('payment_method_id', v_wallet, 'amount', -v_check.amount),
      jsonb_build_object('payment_method_id', v_check.deposited_to_id, 'amount', v_check.amount)
    )
  );

  update third_party_checks set status = 'ACREDITADO'
   where third_party_checks.id = p_check_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.current_employee_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from employees where profile_id = auth.uid() and active;
$function$
;

CREATE OR REPLACE FUNCTION public.customer_credit(p_customer_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select sum(r.on_account_amount)
      from receipts r
     where r.customer_id = p_customer_id and r.status = 'REGISTRADO'
  ), 0) - coalesce((
    select sum(v.amount)
      from receipt_values v
      join receipts r on r.id = v.receipt_id
     where r.customer_id = p_customer_id
       and r.status = 'REGISTRADO'
       and v.kind = 'SALDO_A_FAVOR'
  ), 0) - coalesce((
    select sum(c.amount)
      from receipt_changes c
      join receipts r on r.id = c.receipt_id
     where r.customer_id = p_customer_id
       and r.status = 'REGISTRADO'
  ), 0);
$function$
;

CREATE OR REPLACE FUNCTION public.decide_price_authorization(p_token uuid, p_accept boolean, p_reason text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  wo work_orders%rowtype;
begin
  select * into wo from work_orders where public_token = p_token for update;

  if not found then
    return 'NO_EXISTE';
  end if;

  if wo.price_auth_status is distinct from 'PENDIENTE' then
    return 'YA_RESUELTA';
  end if;

  if not p_accept and coalesce(trim(p_reason), '') = '' then
    return 'FALTA_MOTIVO';
  end if;

  update work_orders
     set price_auth_status = case when p_accept then 'AUTORIZADO' else 'RECHAZADO' end,
         price_auth_decided_at = now(),
         price_auth_reason = case when p_accept then wo.price_auth_reason else trim(p_reason) end
   where id = wo.id;

  return case when p_accept then 'AUTORIZADO' else 'RECHAZADO' end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.decide_quotation(p_token uuid, p_accept boolean, p_reason text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  q quotations%rowtype;
begin
  select * into q from quotations where public_token = p_token for update;

  if not found then
    return 'NO_EXISTE';
  end if;

  if q.status not in ('EMITIDA', 'ENVIADA') then
    return 'YA_RESUELTA';
  end if;

  if not public.cotizacion_sigue_decidible(q.work_order_id) then
    return 'YA_CONVERTIDA';
  end if;

  if q.valid_until is not null and q.valid_until < current_date then
    return 'VENCIDA';
  end if;

  if not p_accept and coalesce(trim(p_reason), '') = '' then
    return 'FALTA_MOTIVO';
  end if;

  update quotations
     set status = case when p_accept then 'ACEPTADA'::quotation_status
                       else 'RECHAZADA'::quotation_status end,
         decided_at = now(),
         decided_by_client = true,
         rejection_reason = case when p_accept then q.rejection_reason
                                 else trim(p_reason) end
   where id = q.id;

  if p_accept then
    perform public.aplicar_cotizacion_en_ot(q.id);
  else
    perform public.rechazar_cotizacion_en_ot(q.id);
  end if;

  return case when p_accept then 'ACEPTADA' else 'RECHAZADA' end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_work_orders(p_ids uuid[])
 RETURNS TABLE(order_number text, was_deleted boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_numero text;
  v_factura text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  foreach v_id in array coalesce(p_ids, '{}'::uuid[]) loop
    select w.number into v_numero from work_orders w where w.id = v_id for update;

    -- Ya no está. Alguien la borró entre que se armó la lista y se confirmó;
    -- el resultado que se buscaba ya está, así que no es un error.
    if v_numero is null then
      continue;
    end if;

    -- Una factura anulada retiene igual: la fila sigue existiendo y sigue
    -- siendo el respaldo de un número que se emitió.
    select coalesce(i.full_number, 'N° ' || i.number::text) into v_factura
      from invoices i where i.work_order_id = v_id limit 1;

    if v_factura is not null then
      order_number := v_numero;
      was_deleted  := false;
      reason       := 'la factura ' || v_factura || ' la retiene';
      return next;
      continue;
    end if;

    update work_orders set quotation_id = null where id = v_id;
    delete from quotations where work_order_id = v_id;
    delete from work_orders where id = v_id;

    order_number := v_numero;
    was_deleted  := true;
    reason       := null;
    return next;
  end loop;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.deposit_check(p_check_id uuid, p_bank_method_id uuid, p_date date DEFAULT CURRENT_DATE)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_check third_party_checks%rowtype;
  v_kind payment_method_kind;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_check from third_party_checks
   where third_party_checks.id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if v_check.status <> 'EN_CARTERA' then
    raise exception 'Solo se depositan cheques en cartera (estado actual: %).', v_check.status;
  end if;

  select kind into v_kind from payment_methods where id = p_bank_method_id and active;
  if not found then
    raise exception 'La cuenta de destino no existe o está inactiva.';
  end if;
  -- Un cheque se deposita en un banco. Sin esta guarda se podría "depositar"
  -- en la caja chica, que no significa nada.
  if v_kind <> 'BANCO' then
    raise exception 'Un cheque se deposita en una cuenta bancaria, no en un medio de tipo %.', v_kind;
  end if;

  update third_party_checks
     set status = 'DEPOSITADO',
         deposited_to_id = p_bank_method_id,
         deposited_at = coalesce(p_date, current_date)
   where third_party_checks.id = p_check_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.despachar_whatsapp()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'vault'
AS $function$
declare
  v_secreto text;
begin
  select decrypted_secret into v_secreto
  from vault.decrypted_secrets where name = 'cron_secret';

  if v_secreto is null then
    raise warning 'No está cargado el secreto cron_secret en la bóveda.';
    return;
  end if;

  perform net.http_post(
    url := 'https://mnoqdqjhsylohlvuekfh.supabase.co/functions/v1/despachar-whatsapp',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secreto
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.diagnosticar_whatsapp()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'vault'
AS $function$
declare
  v_secreto text;
  v_id bigint;
begin
  select decrypted_secret into v_secreto
  from vault.decrypted_secrets where name = 'cron_secret';

  select net.http_post(
    url := 'https://mnoqdqjhsylohlvuekfh.supabase.co/functions/v1/despachar-whatsapp?diagnostico=1',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', v_secreto),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  ) into v_id;

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.duplicate_quotation(p_quotation_id uuid)
 RETURNS TABLE(id uuid, number text)
 LANGUAGE plpgsql
AS $function$
declare
  v_new_id uuid;
  v_new_number text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  insert into quotations (status, customer_id, vehicle_id, component, notes, valid_until)
  select 'EMITIDA', q.customer_id, q.vehicle_id, q.component, q.notes, current_date + 15
  from quotations q where q.id = p_quotation_id
  returning quotations.id, quotations.number into v_new_id, v_new_number;

  if v_new_id is null then
    raise exception 'La cotización a duplicar no existe.';
  end if;

  insert into quotation_items (quotation_id, article_id, code, description, quantity, unit_price, subtotal)
  select v_new_id, qi.article_id, qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi where qi.quotation_id = p_quotation_id;

  return query select v_new_id, v_new_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.effective_markup(p_markup numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(
    p_markup,
    (select value::numeric from app_settings where key = 'default_markup_percent'),
    0
  );
$function$
;

CREATE OR REPLACE FUNCTION public.endorse_check(p_check_id uuid, p_supplier_id uuid, p_date date DEFAULT CURRENT_DATE)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_check third_party_checks%rowtype;
  v_supplier suppliers%rowtype;
  v_wallet uuid;
  v_movement record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_check from third_party_checks
   where third_party_checks.id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if v_check.status <> 'EN_CARTERA' then
    raise exception 'Solo se endosan cheques en cartera (estado actual: %).', v_check.status;
  end if;

  select * into v_supplier from suppliers where suppliers.id = p_supplier_id;
  if not found then
    raise exception 'El proveedor no existe.';
  end if;

  v_wallet := public.checks_wallet_id();

  select * into v_movement from public.post_treasury_movement(
    'EGRESO', coalesce(p_date, current_date), null,
    'Endoso cheque ' || v_check.number || ' — ' || v_check.bank_name,
    v_supplier.name, v_check.amount,
    jsonb_build_array(
      jsonb_build_object('payment_method_id', v_wallet, 'amount', -v_check.amount)
    )
  );

  update third_party_checks
     set status = 'ENDOSADO', endorsed_to_supplier_id = p_supplier_id
   where third_party_checks.id = p_check_id;

  return v_movement.movement_full_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enqueue_notification(p_kind notification_kind, p_dedupe_key text, p_body text, p_customer_id uuid, p_work_order_id uuid DEFAULT NULL::uuid, p_quotation_id uuid DEFAULT NULL::uuid, p_media_url text DEFAULT NULL::text, p_receipt_value_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone text;
  v_opt_out boolean;
  v_status notification_status;
  v_error text;
  v_id uuid;
begin
  select phone_e164, whatsapp_opt_out into v_phone, v_opt_out
  from customers where id = p_customer_id;

  if v_opt_out then
    v_status := 'DESCARTADO';
    v_error := 'El cliente pidió no recibir mensajes.';
  elsif v_phone is null then
    v_status := 'DESCARTADO';
    v_error := 'El cliente no tiene un teléfono válido cargado.';
  else
    v_status := 'PENDIENTE';
  end if;

  insert into notifications (
    kind, status, work_order_id, quotation_id, customer_id,
    to_phone, body, media_url, dedupe_key, last_error, receipt_value_id
  )
  values (
    p_kind, v_status, p_work_order_id, p_quotation_id, p_customer_id,
    v_phone, p_body, p_media_url, p_dedupe_key, v_error, p_receipt_value_id
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enqueue_work_order_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform enqueue_notification(
    'LINK_SEGUIMIENTO',
    'ot:' || new.id::text || ':alta',
    build_work_order_message(new.id, new.status_id, true),
    new.customer_id,
    new.id
  );
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enqueue_work_order_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_base_key text;
  v_seq int;
  v_notifies boolean;
begin
  if new.status_id = old.status_id then
    return null;
  end if;

  select notifies_client into v_notifies from work_order_statuses where id = new.status_id;
  if not coalesce(v_notifies, false) then
    return null;
  end if;

  v_base_key := 'ot:' || new.id::text || ':estado:' || new.status_id::text;

  select count(*) + 1 into v_seq
  from notifications
  where dedupe_key = v_base_key or dedupe_key like v_base_key || ':%';

  perform enqueue_notification(
    'CAMBIO_ESTADO',
    case when v_seq = 1 then v_base_key else v_base_key || ':' || v_seq::text end,
    build_work_order_message(new.id, new.status_id, false),
    new.customer_id,
    new.id
  );
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enviar_cotizacion_para_autorizar(p_quotation_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  q quotations%rowtype;
  v_base text;
  v_total numeric;
  v_body text;
  v_envios integer;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into q from quotations where id = p_quotation_id;
  if not found then
    return 'NO_EXISTE';
  end if;

  if q.status not in ('EMITIDA', 'ENVIADA') then
    return 'YA_RESUELTA';
  end if;

  if not exists (select 1 from quotation_items where quotation_id = q.id) then
    return 'SIN_RENGLONES';
  end if;

  select value into v_base from app_settings where key = 'public_base_url';

  select coalesce(sum(subtotal), 0) * 1.21 into v_total
  from quotation_items where quotation_id = q.id;

  v_body :=
    'Hola, le enviamos el presupuesto de su reparación.' || E'\n\n' ||
    'Presupuesto ' || q.number ||
    coalesce(' · ' || q.component, '') || E'\n' ||
    'Total: $ ' || to_char(v_total, 'FM999999990.00') ||
    coalesce(E'\n' || 'Válido hasta ' || to_char(q.valid_until, 'DD/MM/YYYY'), '') ||
    E'\n\n' ||
    'Puede verlo en detalle y aceptarlo o rechazarlo acá:' || E'\n' ||
    coalesce(v_base, '') || '/presupuesto/' || q.public_token::text;

  select count(*) into v_envios
  from notifications
  where quotation_id = q.id and kind = 'COTIZACION';

  v_id := public.enqueue_notification(
    'COTIZACION',
    'cot:' || q.id::text || ':enviada:' || (v_envios + 1)::text,
    v_body,
    q.customer_id,
    q.work_order_id,
    q.id
  );

  if q.status = 'EMITIDA' then
    update quotations set status = 'ENVIADA' where id = q.id;
  end if;

  if v_id is null then
    return 'YA_ENCOLADA';
  end if;

  return 'ENVIADA';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.estado_certificados_arca()
 RETURNS TABLE(proposito text, cargado boolean, cuit text, actualizado timestamp with time zone, ticket_vigente_hasta timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  return query
  select p.proposito,
         c.proposito is not null as cargado,
         c.cuit,
         c.updated_at as actualizado,
         (select max(t.expira) from arca_tickets t) as ticket_vigente_hasta
  from (values ('PADRON'), ('FACTURACION')) as p(proposito)
  left join arca_credentials c on c.proposito = p.proposito;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.estado_claves_ia()
 RETURNS TABLE(provider text, configurada boolean, ultimos4 text, actualizada timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  return query
  select p.provider,
         c.provider is not null as configurada,
         right(c.api_key, 4) as ultimos4,
         c.updated_at as actualizada
  from (values ('GEMINI'), ('ANTHROPIC')) as p(provider)
  left join ai_credentials c on c.provider = p.provider;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_public_quotation(p_token uuid)
 RETURNS TABLE(number text, status quotation_status, component text, notes text, valid_until date, created_at timestamp with time zone, customer_name text, vehicle_brand text, vehicle_model text, license_plate text, already_converted boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    q.number, q.status, q.component, q.notes, q.valid_until, q.created_at,
    c.name, v.brand, v.model, v.license_plate,
    not public.cotizacion_sigue_decidible(q.work_order_id)
  from quotations q
  left join customers c on c.id = q.customer_id
  left join vehicles v on v.id = q.vehicle_id
  where q.public_token = p_token;
$function$
;

CREATE OR REPLACE FUNCTION public.get_public_quotation_items(p_token uuid)
 RETURNS TABLE(code text, description text, quantity numeric, unit_price numeric, subtotal numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select qi.code, qi.description, qi.quantity, qi.unit_price, qi.subtotal
  from quotation_items qi
  join quotations q on q.id = qi.quotation_id
  where q.public_token = p_token
  order by qi.code;
$function$
;

CREATE OR REPLACE FUNCTION public.get_public_status_history(p_token uuid)
 RETURNS TABLE(to_status_id uuid, changed_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select h.to_status_id, h.changed_at
  from work_order_status_history h
  join work_orders wo on wo.id = h.work_order_id
  where wo.public_token = p_token
  order by h.changed_at;
$function$
;

CREATE OR REPLACE FUNCTION public.get_public_work_order(p_token uuid)
 RETURNS TABLE(number text, status_id uuid, component text, vehicle_brand text, vehicle_model text, license_plate text, vehicle_type text, vehicle_year integer, engine_brand text, engine_model text, injection_system text, employee_name text, customer_name text, price_auth_status text, price_auth_requested_total numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    wo.number, wo.status_id, wo.component,
    v.brand, v.model, v.license_plate, v.vehicle_type, v.year,
    v.engine_brand, v.engine_model, v.injection_system,
    e.name, c.name,
    wo.price_auth_status, wo.price_auth_requested_total
  from work_orders wo
  left join vehicles v  on v.id = wo.vehicle_id
  left join employees e on e.id = wo.employee_id
  left join customers c on c.id = wo.customer_id
  where wo.public_token = p_token;
$function$
;

CREATE OR REPLACE FUNCTION public.guardar_certificado_arca(p_proposito text, p_cuit text, p_cert text, p_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cuit text := regexp_replace(coalesce(p_cuit, ''), '[^0-9]', '', 'g');
  v_cert text := btrim(coalesce(p_cert, ''));
  v_key text := btrim(coalesce(p_key, ''));
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if p_proposito not in ('PADRON', 'FACTURACION') then
    raise exception 'Propósito desconocido: %', p_proposito;
  end if;

  if v_cuit !~ '^[0-9]{11}$' then
    raise exception 'El CUIT tiene que tener 11 dígitos.';
  end if;

  if v_cert not like '-----BEGIN CERTIFICATE-----%' then
    raise exception 'Eso no parece un certificado. Tiene que empezar con -----BEGIN CERTIFICATE-----';
  end if;

  if v_key not like '-----BEGIN PRIVATE KEY-----%'
     and v_key not like '-----BEGIN RSA PRIVATE KEY-----%' then
    raise exception 'Eso no parece una clave privada. Tiene que empezar con -----BEGIN PRIVATE KEY-----';
  end if;

  insert into arca_credentials (proposito, cuit, cert_pem, key_pem, updated_at, updated_by)
  values (p_proposito, v_cuit, v_cert, v_key, now(), auth.uid())
  on conflict (proposito) do update
    set cuit = excluded.cuit,
        cert_pem = excluded.cert_pem,
        key_pem = excluded.key_pem,
        updated_at = now(),
        updated_by = excluded.updated_by;

  delete from arca_tickets where servicio is not null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guardar_clave_ia(p_provider text, p_api_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_clave text := nullif(trim(p_api_key), '');
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if p_provider not in ('GEMINI', 'ANTHROPIC') then
    raise exception 'Proveedor desconocido: %', p_provider;
  end if;
  if v_clave is null then
    raise exception 'La clave no puede quedar vacía. Para sacarla, usá borrar_clave_ia.';
  end if;

  insert into ai_credentials (provider, api_key, updated_at, updated_by)
  values (p_provider, v_clave, now(), auth.uid())
  on conflict (provider) do update
    set api_key = excluded.api_key,
        updated_at = now(),
        updated_by = excluded.updated_by;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email, role) values (new.id, new.email, 'operario');
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.has_gmail_credential()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
  select exists (select 1 from vault.secrets where name = 'gmail_app_password');
$function$
;

CREATE OR REPLACE FUNCTION public.import_supplier_prices(p_supplier_id uuid, p_file_name text, p_rows jsonb)
 RETURNS TABLE(total_rows integer, matched_rows integer, unmatched_rows integer, import_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_total int := 0;
  v_matched int := 0;
  v_created int := 0;
  v_import_id uuid;
  v_prefix text;
  v_supplier_name text;
  r record;
  v_article_id uuid;
  v_is_preferred boolean;
  v_number int;
  v_code text;
  v_description text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select code_prefix, name into v_prefix, v_supplier_name
  from suppliers where id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no existe.';
  end if;
  if v_prefix is null then
    raise exception 'Este proveedor no tiene prefijo de código configurado. Definilo en Proveedores antes de importar.';
  end if;

  for r in
    select
      trim(item->>'code') as code,
      nullif(trim(coalesce(item->>'description', '')), '') as description,
      nullif(trim(coalesce(item->>'brand', '')), '') as brand,
      (item->>'price')::numeric as price
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as item
    where trim(coalesce(item->>'code', '')) <> ''
  loop
    v_total := v_total + 1;

    update article_suppliers
       set purchase_price = r.price,
           supplier_description = coalesce(r.description, supplier_description)
     where supplier_id = p_supplier_id
       and upper(supplier_code) = upper(r.code)
    returning article_id, is_preferred into v_article_id, v_is_preferred;

    if found then
      v_matched := v_matched + 1;

      if v_is_preferred and (r.description is not null or r.brand is not null) then
        update articles
           set description = coalesce(r.description, description),
               brand = coalesce(r.brand, brand)
         where id = v_article_id;
      end if;
    else
      insert into article_code_sequences (code_prefix, last_number)
      values (v_prefix, 1)
      on conflict (code_prefix) do update
        set last_number = article_code_sequences.last_number + 1
      returning last_number into v_number;

      v_code := v_prefix || '-' || lpad(v_number::text, 8, '0');
      v_description := coalesce(r.description, 'Sin descripción — importado de ' || v_supplier_name);

      insert into articles (code, description, brand, unit_price, tracks_stock, stock_quantity, active)
      values (v_code, v_description, r.brand, 0, false, 0, true)
      returning id into v_article_id;

      insert into article_suppliers (article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred)
      values (v_article_id, p_supplier_id, r.code, r.description, r.price, true);

      v_created := v_created + 1;
    end if;
  end loop;

  insert into price_imports (supplier_id, file_name, total_rows, matched_rows, unmatched_rows)
  values (p_supplier_id, p_file_name, v_total, v_matched, v_created)
  returning id into v_import_id;

  return query select v_total, v_matched, v_created, v_import_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.invoice_type_for(p_issuer_condition text, p_customer_condition text)
 RETURNS invoice_type
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    -- Un monotributista o exento emite siempre C, sin IVA.
    when p_issuer_condition in ('MONOTRIBUTO', 'EXENTO') then 'C'::invoice_type
    -- Responsable inscripto: A solo contra otro inscripto (IVA discriminado).
    when p_customer_condition = 'RESPONSABLE_INSCRIPTO' then 'A'::invoice_type
    -- Contra consumidor final, monotributo o exento: B, con IVA incluido.
    else 'B'::invoice_type
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_contador()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'contador'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.issue_free_invoice(p_customer_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text, p_emit_remito boolean DEFAULT false, p_remito_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  return query
  select * from public._create_invoice(null::uuid, p_customer_id, p_items, p_notes, p_emit_remito, p_remito_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.issue_invoice(p_work_order_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text, p_emit_remito boolean DEFAULT false)
 RETURNS TABLE(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if exists (
    select 1 from invoices
    where invoices.work_order_id = p_work_order_id and invoices.status = 'EMITIDA'
  ) then
    raise exception 'La orden % ya tiene una factura emitida.', v_wo.number;
  end if;

  return query
  select * from public._create_invoice(p_work_order_id, v_wo.customer_id, p_items, p_notes, p_emit_remito);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.link_or_create_supplier_article(p_supplier_id uuid, p_supplier_code text, p_description text, p_purchase_price numeric, p_article_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(result_article_id uuid, result_code text, result_description text, result_created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_code text := trim(coalesce(p_supplier_code, ''));
  v_desc text := nullif(trim(coalesce(p_description, '')), '');
  v_price numeric := greatest(coalesce(p_purchase_price, 0), 0);
  v_prefix text;
  v_supplier_name text;
  v_number int;
  v_new_code text;
  v_article uuid;
  v_owner uuid;
  v_created boolean := false;
  v_has_preferred boolean;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if v_code = '' then
    raise exception 'El renglón no tiene código de proveedor, así que no se puede vincular ni dar de alta desde acá.';
  end if;

  select code_prefix, name into v_prefix, v_supplier_name
  from suppliers where id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no existe.';
  end if;

  select a.article_id into v_owner
  from article_suppliers a
  where a.supplier_id = p_supplier_id
    and upper(a.supplier_code) = upper(v_code);

  if v_owner is not null and p_article_id is null then
    p_article_id := v_owner;
  end if;

  if v_owner is not null and v_owner <> p_article_id then
    raise exception 'El código % ya está asignado a otro artículo de este proveedor.', v_code;
  end if;

  if p_article_id is not null then
    if not exists (select 1 from articles where id = p_article_id) then
      raise exception 'El artículo indicado no existe.';
    end if;
    v_article := p_article_id;
  else
    if v_prefix is null then
      raise exception 'El proveedor % no tiene prefijo de código configurado. Definilo en Proveedores para poder dar de alta artículos desde una factura.', v_supplier_name;
    end if;

    insert into article_code_sequences (code_prefix, last_number)
    values (v_prefix, 1)
    on conflict (code_prefix) do update
      set last_number = article_code_sequences.last_number + 1
    returning last_number into v_number;

    v_new_code := v_prefix || '-' || lpad(v_number::text, 8, '0');

    insert into articles (code, description, unit_price, tracks_stock, stock_quantity, active)
    values (
      v_new_code,
      coalesce(v_desc, 'Sin descripción — alta desde factura de ' || v_supplier_name),
      0, false, 0, true
    )
    returning id into v_article;

    v_created := true;
  end if;

  select exists (
    select 1 from article_suppliers s where s.article_id = v_article and s.is_preferred
  ) into v_has_preferred;

  insert into article_suppliers (
    article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred
  )
  values (v_article, p_supplier_id, v_code, v_desc, v_price, not v_has_preferred)
  on conflict (article_id, supplier_id) do update
    set supplier_code = excluded.supplier_code,
        supplier_description = coalesce(excluded.supplier_description, article_suppliers.supplier_description),
        purchase_price = case
          when excluded.purchase_price > 0 then excluded.purchase_price
          else article_suppliers.purchase_price
        end;

  return query
    select a.id, a.code, a.description, v_created
    from articles a
    where a.id = v_article;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.link_quotation_to_work_order(p_quotation_id uuid, p_work_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cotizado uuid;
  v_otra uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if exists (select 1 from quotations where id = p_quotation_id and work_order_id is not null
             and work_order_id <> p_work_order_id) then
    raise exception 'Esa cotización ya está enganchada a otra orden de trabajo.';
  end if;

  select quotation_id into v_otra from work_orders where id = p_work_order_id;
  if v_otra is not null and v_otra <> p_quotation_id then
    raise exception 'Esa orden ya tiene una cotización enganchada.';
  end if;

  select id into v_cotizado from work_order_statuses where system_key = 'COTIZADO';
  if v_cotizado is null then
    raise exception 'Falta el estado cotizado del circuito. Revisá el ABM de estados de OT.';
  end if;

  update quotations set work_order_id = p_work_order_id where id = p_quotation_id;
  update work_orders set quotation_id = p_quotation_id where id = p_work_order_id;

  update work_orders w
  set status_id = v_cotizado
  from work_order_statuses s
  where w.id = p_work_order_id and s.id = w.status_id and s.system_key = 'INGRESADO';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.log_work_order_stage_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update work_order_stage_assignments
     set ended_at = now()
   where work_order_id = new.id and ended_at is null;

  insert into work_order_stage_assignments (work_order_id, employee_id, status_id)
  values (new.id, new.employee_id, new.status_id);

  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.log_work_order_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' or new.status_id is distinct from old.status_id then
    insert into work_order_status_history (
      work_order_id, from_status_id, to_status_id, changed_by, changed_by_email
    )
    values (
      new.id,
      case when tg_op = 'INSERT' then null else old.status_id end,
      new.status_id,
      auth.uid(),
      (select email from profiles where id = auth.uid())
    );
  end if;
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_notification_failed(p_id uuid, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update notifications
     set last_error = p_error,
         status = case when attempts >= 5 then 'FALLIDO'::notification_status
                       else 'PENDIENTE'::notification_status end
   where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_notification_sent(p_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update notifications
     set status = 'ENVIADO', sent_at = now(), last_error = null
   where id = p_id;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_password_changed()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update profiles set must_change_password = false where id = auth.uid();
$function$
;

CREATE OR REPLACE FUNCTION public.match_provisional_credit_note(p_provisional_id uuid, p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prov provisional_credit_notes%rowtype;
  v_inv purchase_invoices%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_prov from provisional_credit_notes
   where provisional_credit_notes.id = p_provisional_id for update;
  if not found then
    raise exception 'La NC provisoria no existe.';
  end if;
  if v_prov.status <> 'PENDIENTE' then
    raise exception 'La NC provisoria % ya está formalizada.', v_prov.full_number;
  end if;

  select * into v_inv from purchase_invoices
   where purchase_invoices.id = p_invoice_id for update;
  if not found then
    raise exception 'El comprobante no existe.';
  end if;
  if v_inv.doc_type <> 'NOTA_CREDITO' then
    raise exception '% no es una nota de crédito.', v_inv.full_number;
  end if;
  if v_inv.status <> 'REGISTRADA' then
    raise exception 'El comprobante % está anulado.', v_inv.full_number;
  end if;
  if v_inv.supplier_id <> v_prov.supplier_id then
    raise exception 'El comprobante % es de otro proveedor.', v_inv.full_number;
  end if;
  if v_inv.settled_amount > 0 then
    raise exception 'El comprobante % ya tiene aplicaciones propias; no se puede vincular como formalización.', v_inv.full_number;
  end if;

  update purchase_invoices
     set settled_amount = total_amount
   where purchase_invoices.id = p_invoice_id;

  update provisional_credit_notes
     set status = 'FORMALIZADA', matched_invoice_id = p_invoice_id, matched_at = now()
   where provisional_credit_notes.id = p_provisional_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mover_stock_de_renglon(p_article_id uuid, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_es_combo boolean;
begin
  if p_article_id is null then
    return;
  end if;

  select exists (select 1 from article_components where combo_article_id = p_article_id)
    into v_es_combo;

  if v_es_combo then
    perform public.adjust_article_stock(c.component_article_id, p_delta * c.quantity)
    from article_components c
    where c.combo_article_id = p_article_id;
  else
    perform public.adjust_article_stock(p_article_id, p_delta);
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.normalize_ar_phone(p_raw text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  d text;
begin
  if p_raw is null then return null; end if;

  -- Solo dígitos
  d := regexp_replace(p_raw, '\D', '', 'g');
  if d = '' then return null; end if;

  -- Prefijo de salida internacional
  if left(d, 2) = '00' then d := substr(d, 3); end if;

  -- Código de país
  if left(d, 2) = '54' then d := substr(d, 3); end if;

  -- Cero inicial del código de área (011 -> 11)
  d := regexp_replace(d, '^0+', '');

  -- El 9 de celular se saca acá y se vuelve a poner al final, así da igual
  -- que venga o no en el original.
  if left(d, 1) = '9' and length(d) = 11 then d := substr(d, 2); end if;

  -- El 15 local va después del código de área, que mide de 2 a 4 dígitos.
  -- Se prueba cada largo posible y se acepta el que deje 10 dígitos.
  if length(d) = 12 then
    if substr(d, 3, 2) = '15' then d := substr(d, 1, 2) || substr(d, 5);
    elsif substr(d, 4, 2) = '15' then d := substr(d, 1, 3) || substr(d, 6);
    elsif substr(d, 5, 2) = '15' then d := substr(d, 1, 4) || substr(d, 7);
    end if;
  end if;

  -- Un celular argentino son 10 dígitos: área + abonado.
  if length(d) <> 10 then return null; end if;

  return '549' || d;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.normalize_supplier_code_prefix()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.code_prefix := nullif(upper(trim(new.code_prefix)), '');
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.ordenar_estados_ot(p_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_total integer;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select count(*) into v_total from work_order_statuses;

  if array_length(p_ids, 1) is distinct from v_total then
    raise exception 'La secuencia tiene % estados y existen %.', coalesce(array_length(p_ids, 1), 0), v_total;
  end if;

  if exists (
    select 1 from unnest(p_ids) as id group by id having count(*) > 1
  ) then
    raise exception 'La secuencia trae estados repetidos.';
  end if;

  if exists (
    select 1 from work_order_statuses s
    where not (s.id = any(p_ids))
  ) then
    raise exception 'La secuencia no incluye todos los estados.';
  end if;

  update work_order_statuses s
  set sort_order = nuevo.posicion
  from (
    select id, row_number() over () as posicion
    from unnest(p_ids) as id
  ) as nuevo
  where s.id = nuevo.id
    and s.sort_order is distinct from nuevo.posicion;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.post_treasury_movement(p_type treasury_movement_type, p_date date, p_concept_id uuid, p_description text, p_payee text, p_amount numeric, p_legs jsonb, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(movement_id uuid, movement_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_number int;
  v_new_id uuid;
  v_full_number text;
begin
  insert into treasury_sequences (movement_type, last_number)
  values (p_type, 1)
  on conflict (movement_type)
    do update set last_number = treasury_sequences.last_number + 1
  returning treasury_sequences.last_number into v_number;

  insert into treasury_movements (
    movement_type, number, full_number, status, movement_date,
    concept_id, description, payee, amount, notes, created_by
  )
  values (
    p_type, v_number,
    case p_type
      when 'EGRESO' then 'EG-'
      when 'INGRESO' then 'IN-'
      else 'TR-'
    end || lpad(v_number::text, 8, '0'),
    'REGISTRADO', coalesce(p_date, current_date),
    p_concept_id, p_description,
    nullif(trim(coalesce(p_payee, '')), ''),
    round(p_amount, 2),
    nullif(trim(coalesce(p_notes, '')), ''),
    auth.uid()
  )
  returning treasury_movements.id, treasury_movements.full_number
       into v_new_id, v_full_number;

  insert into treasury_movement_legs (movement_id, payment_method_id, amount)
  select v_new_id, (leg->>'payment_method_id')::uuid, round((leg->>'amount')::numeric, 2)
  from jsonb_array_elements(p_legs) as leg;

  return query select v_new_id, v_full_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.read_gmail_credential()
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
  select decrypted_secret from vault.decrypted_secrets where name = 'gmail_app_password';
$function$
;

CREATE OR REPLACE FUNCTION public.reasignar_cliente_de_orden(p_work_order_id uuid, p_customer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_facturada integer;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if not exists (select 1 from customers where id = p_customer_id and active) then
    raise exception 'El cliente elegido no existe o está inactivo.';
  end if;

  select count(*) into v_facturada
  from invoices
  where work_order_id = p_work_order_id and status <> 'ANULADA';

  if v_facturada > 0 then
    raise exception 'La orden ya tiene una factura emitida. Para cambiarle el cliente hay que anularla primero.';
  end if;

  update work_orders set customer_id = p_customer_id where id = p_work_order_id;

  update quotations set customer_id = p_customer_id where work_order_id = p_work_order_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.recalculate_all_sale_prices()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_count integer := 0;
  r record;
  v_price numeric;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  for r in select id, markup_percent, unit_price from articles loop
    v_price := compute_sale_price(r.id, r.markup_percent);
    if v_price is not null and v_price <> r.unit_price then
      update articles set unit_price = v_price where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.receive_check(p_check jsonb)
 RETURNS TABLE(check_id uuid, check_movement_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wallet uuid;
  v_amount numeric(14,2);
  v_date date;
  v_new_id uuid;
  v_movement record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  v_wallet := public.checks_wallet_id();
  if v_wallet is null then
    raise exception 'No hay una cartera de cheques cargada. Creala en Medios de pago con el tipo Cartera de cheques.';
  end if;

  v_amount := round((p_check->>'amount')::numeric, 2);
  if v_amount is null or v_amount <= 0 then
    raise exception 'El importe del cheque tiene que ser mayor a cero.';
  end if;
  if coalesce(trim(p_check->>'number'), '') = '' then
    raise exception 'Indicá el número del cheque.';
  end if;
  if coalesce(trim(p_check->>'bank_name'), '') = '' then
    raise exception 'Indicá el banco del cheque.';
  end if;
  if (p_check->>'due_date') is null then
    raise exception 'Indicá la fecha de cobro del cheque.';
  end if;

  v_date := coalesce((p_check->>'received_date')::date, current_date);

  select * into v_movement from public.post_treasury_movement(
    'INGRESO', v_date,
    nullif(p_check->>'concept_id', '')::uuid,
    'Cheque ' || (p_check->>'number') || ' — ' || (p_check->>'bank_name'),
    nullif(trim(coalesce(p_check->>'drawer', '')), ''),
    v_amount,
    jsonb_build_array(jsonb_build_object('payment_method_id', v_wallet, 'amount', v_amount)),
    nullif(trim(coalesce(p_check->>'notes', '')), '')
  );

  insert into third_party_checks (
    number, bank_name, drawer, issue_date, due_date, amount,
    status, received_movement_id, notes, created_by
  )
  values (
    trim(p_check->>'number'), trim(p_check->>'bank_name'),
    nullif(trim(coalesce(p_check->>'drawer', '')), ''),
    (p_check->>'issue_date')::date,
    (p_check->>'due_date')::date,
    v_amount, 'EN_CARTERA', v_movement.movement_id,
    nullif(trim(coalesce(p_check->>'notes', '')), ''), auth.uid()
  )
  returning third_party_checks.id into v_new_id;

  return query select v_new_id, v_movement.movement_full_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.rechazar_cotizacion_en_ot(p_quotation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wo uuid;
  v_rechazada uuid;
begin
  select work_order_id into v_wo from quotations where id = p_quotation_id;
  if v_wo is null then
    return;
  end if;

  if not public.cotizacion_sigue_decidible(v_wo) then
    return;
  end if;

  select id into v_rechazada from work_order_statuses where system_key = 'RECHAZADA';
  if v_rechazada is null then
    raise exception 'Falta el estado rechazada del circuito. Revisá el ABM de estados de OT.';
  end if;

  update work_orders set status_id = v_rechazada where id = v_wo;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_marca_modelo(p_marca text, p_modelo text, p_tamano text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_marca text := nullif(trim(p_marca), '');
  v_modelo text := nullif(trim(p_modelo), '');
  -- Cualquier valor que no sea uno de los dos tamaños válidos se ignora en
  -- vez de rechazar el llamado entero: esto corre después de guardar el
  -- vehículo, y una pieza (sin tamaño real) manda null sin problema.
  v_tamano text := nullif(p_tamano, '');
  v_brand_id uuid;
  v_model_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if v_marca is null then
    return;
  end if;
  if v_tamano is not null and v_tamano not in ('MEDIANO', 'GRANDE') then
    v_tamano := null;
  end if;

  select id into v_brand_id from vehicle_brands where lower(name) = lower(v_marca);
  if v_brand_id is null then
    insert into vehicle_brands (name) values (v_marca) returning id into v_brand_id;
  end if;

  if v_modelo is null then
    return;
  end if;

  select id into v_model_id
  from vehicle_models
  where brand_id = v_brand_id and lower(name) = lower(v_modelo);

  if v_model_id is null then
    insert into vehicle_models (brand_id, name, size_class)
    values (v_brand_id, v_modelo, v_tamano)
    on conflict do nothing;
  elsif v_tamano is not null then
    -- Solo si todavía no tiene uno registrado: es la primera vez que se
    -- graba para este modelo, no una corrección de lo que ya había.
    update vehicle_models
    set size_class = v_tamano
    where id = v_model_id and size_class is null;
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_tipo_de_pieza(p_tipo text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tipo text := nullif(trim(p_tipo), '');
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if v_tipo is null then
    return;
  end if;

  insert into vehicle_part_types (name) values (v_tipo) on conflict do nothing;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_check(p_check_id uuid, p_reason text, p_date date DEFAULT CURRENT_DATE)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_check third_party_checks%rowtype;
  v_wallet uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo del rechazo.';
  end if;

  select * into v_check from third_party_checks
   where third_party_checks.id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if v_check.status not in ('DEPOSITADO', 'ACREDITADO') then
    raise exception 'Solo rebotan los cheques depositados o acreditados (estado actual: %).', v_check.status;
  end if;

  -- Solo hay que devolver plata si había salido de la cartera, y eso pasó
  -- únicamente si el cheque llegó a acreditarse.
  if v_check.status = 'ACREDITADO' then
    v_wallet := public.checks_wallet_id();
    perform public.post_treasury_movement(
      'TRANSFERENCIA', coalesce(p_date, current_date), null,
      'Rechazo cheque ' || v_check.number || ' — ' || v_check.bank_name,
      v_check.drawer, v_check.amount,
      jsonb_build_array(
        jsonb_build_object('payment_method_id', v_check.deposited_to_id, 'amount', -v_check.amount),
        jsonb_build_object('payment_method_id', v_wallet, 'amount', v_check.amount)
      ),
      trim(p_reason)
    );
  end if;

  update third_party_checks
     set status = 'RECHAZADO', rejected_reason = trim(p_reason)
   where third_party_checks.id = p_check_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.replace_quotation_items(p_quotation_id uuid, p_items jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_status quotation_status;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select status into v_status from quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_status in ('ACEPTADA', 'RECHAZADA') then
    raise exception 'La cotización está % y no puede modificarse.', lower(v_status::text);
  end if;

  delete from quotation_items where quotation_id = p_quotation_id;

  insert into quotation_items (quotation_id, article_id, code, description, quantity, unit_price, subtotal)
  select
    p_quotation_id,
    nullif(item->>'article_id', '')::uuid,
    item->>'code',
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.replace_work_order_items(p_work_order_id uuid, p_items jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_cash_book(p_from date, p_to date)
 RETURNS TABLE(movement_date date, comprobante text, tipo text, detalle text, concepto text, beneficiario text, medio text, ingreso numeric, egreso numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_cash_count()
 RETURNS TABLE(medio text, tipo text, saldo_inicial numeric, movimientos numeric, saldo numeric)
 LANGUAGE sql
 STABLE
AS $function$
  select
    b.name,
    b.kind::text,
    b.opening_balance,
    b.balance - b.opening_balance,
    b.balance
  from payment_method_balances b
  where b.active
  order by b.kind, b.name;
$function$
;

CREATE OR REPLACE FUNCTION public.report_checks_portfolio()
 RETURNS TABLE(due_date date, dias integer, numero text, banco text, librador text, estado text, depositado_en text, importe numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_customer_aging()
 RETURNS TABLE(customer_name text, a_vencer numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_mas numeric, total numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_customer_balances()
 RETURNS TABLE(customer_name text, comprobante text, issue_date date, due_date date, dias_vencido integer, total_amount numeric, paid_amount numeric, balance numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_customer_ranking(p_from date, p_to date)
 RETURNS TABLE(customer_name text, customer_tax_id text, comprobantes bigint, net_amount numeric, total_amount numeric, balance numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_idle_stock(p_from date, p_to date)
 RETURNS TABLE(code text, description text, stock numeric, precio_compra numeric, valorizado numeric, ultima_venta date)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_monthly_sales(p_from date, p_to date)
 RETURNS TABLE(periodo text, comprobantes bigint, net_amount numeric, vat_amount numeric, total_amount numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_retentions_applied(p_from date, p_to date)
 RETURNS TABLE(payment_date date, orden text, proveedor text, cuit text, impuesto text, jurisdiccion text, certificado text, importe numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_retentions_suffered(p_from date, p_to date)
 RETURNS TABLE(receipt_date date, recibo text, cliente text, impuesto text, jurisdiccion text, certificado text, importe numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_sales_by_period(p_from date, p_to date)
 RETURNS TABLE(issue_date date, comprobante text, customer_name text, customer_tax_id text, net_amount numeric, vat_amount numeric, total_amount numeric, paid_amount numeric, balance numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_stage_times(p_from date, p_to date)
 RETURNS TABLE(status_label text, sector text, employee_name text, assignments integer, avg_hours numeric, total_hours numeric)
 LANGUAGE sql
 STABLE
AS $function$
  select
    ws.label,
    coalesce(e.workplace, 'Sin sector'),
    coalesce(e.name, 'Sin asignar'),
    count(*)::integer,
    round((avg(extract(epoch from (coalesce(a.ended_at, now()) - a.started_at))) / 3600)::numeric, 1),
    round((sum(extract(epoch from (coalesce(a.ended_at, now()) - a.started_at))) / 3600)::numeric, 1)
  from work_order_stage_assignments a
  join work_order_statuses ws on ws.id = a.status_id
  left join employees e on e.id = a.employee_id
  where a.started_at::date between p_from and p_to
  group by ws.label, ws.sort_order, coalesce(e.workplace, 'Sin sector'), coalesce(e.name, 'Sin asignar')
  order by ws.sort_order, coalesce(e.workplace, 'Sin sector'), coalesce(e.name, 'Sin asignar');
$function$
;

CREATE OR REPLACE FUNCTION public.report_stale_prices()
 RETURNS TABLE(code text, description text, proveedor text, precio_compra numeric, precio_venta numeric, actualizado date, dias_sin_cambiar integer)
 LANGUAGE sql
 STABLE
AS $function$
  select
    a.code,
    a.description,
    coalesce(s.name, '— sin proveedor preferido —'),
    sp.purchase_price,
    a.unit_price,
    coalesce(sp.updated_at, a.price_updated_at)::date,
    (current_date - coalesce(sp.updated_at, a.price_updated_at)::date)::int
  from articles a
  left join article_suppliers sp on sp.article_id = a.id and sp.is_preferred
  left join suppliers s on s.id = sp.supplier_id
  where a.active
  order by 7 desc;
$function$
;

CREATE OR REPLACE FUNCTION public.report_stock_valued()
 RETURNS TABLE(code text, description text, stock numeric, precio_compra numeric, valorizado numeric, precio_venta numeric, proveedor text)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_supplier_aging()
 RETURNS TABLE(supplier_name text, a_vencer numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_mas numeric, total numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_supplier_balances()
 RETURNS TABLE(supplier_name text, comprobante text, issue_date date, due_date date, dias_vencido integer, total_amount numeric, settled_amount numeric, balance numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_top_articles(p_from date, p_to date)
 RETURNS TABLE(code text, description text, quantity numeric, net_amount numeric, comprobantes bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_vat_purchases(p_from date, p_to date)
 RETURNS TABLE(issue_date date, tipo text, comprobante text, razon_social text, cuit text, condicion_iva text, neto_gravado numeric, iva numeric, neto_exento numeric, neto_no_gravado numeric, percepciones numeric, total numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_vat_sales(p_from date, p_to date)
 RETURNS TABLE(issue_date date, tipo text, comprobante text, razon_social text, cuit text, condicion_iva text, neto numeric, iva numeric, total numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_work_order_margin(p_from date, p_to date)
 RETURNS TABLE(ot_number text, cliente text, fecha_factura date, ingreso numeric, costo_repuestos numeric, costo_mano_obra numeric, costo_total numeric, margen numeric, margen_pct numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.request_price_authorization(p_work_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wo work_orders%rowtype;
  v_quoted_total numeric;
  v_current_total numeric;
  v_base text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_wo from work_orders where id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;
  if v_wo.quotation_id is null then
    raise exception 'Esta orden no nació de una cotización: no hay precio original con el cual compararla.';
  end if;

  select coalesce(sum(subtotal), 0) into v_quoted_total
    from quotation_items where quotation_id = v_wo.quotation_id;
  select coalesce(sum(subtotal), 0) into v_current_total
    from work_order_items where work_order_id = p_work_order_id;

  if v_current_total = v_quoted_total then
    raise exception 'El monto de la OT no cambió respecto a la cotización original: no hay nada que autorizar.';
  end if;

  update work_orders
     set price_auth_status = 'PENDIENTE',
         price_auth_requested_total = v_current_total,
         price_auth_requested_at = now(),
         price_auth_decided_at = null,
         price_auth_reason = null
   where id = p_work_order_id;

  select value into v_base from app_settings where key = 'public_base_url';

  perform enqueue_notification(
    'CAMBIO_PRECIO',
    'ot:' || p_work_order_id::text || ':precio:' || v_current_total::text,
    'Hola, el costo de su reparación cambió respecto al presupuesto original.' || E'\n\n' ||
      'Orden ' || v_wo.number || E'\n' ||
      'Presupuesto original: $' || to_char(v_quoted_total, 'FM999999999.00') || E'\n' ||
      'Nuevo monto: $' || to_char(v_current_total, 'FM999999999.00') || E'\n\n' ||
      'Para poder continuar necesitamos su autorización. Puede verla y responder acá:' || E'\n' ||
      coalesce(v_base, '') || '/seguimiento/' || v_wo.public_token::text,
    v_wo.customer_id,
    p_work_order_id
  );

  return 'PENDIENTE';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.save_payment_order(p_header jsonb, p_allocations jsonb, p_values jsonb, p_new_provisional_credit_notes jsonb DEFAULT '[]'::jsonb)
 RETURNS TABLE(order_id uuid, order_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_supplier suppliers%rowtype;
  v_number int;
  v_new_id uuid;
  v_full_number text;
  v_total numeric(14,2);
  v_applied numeric(14,2);
  v_credit_used numeric(14,2);
  v_cash numeric(14,2);
  v_wallet uuid;
  v_value jsonb;
  v_alloc jsonb;
  v_legs jsonb := '[]'::jsonb;
  v_movement record;
  v_new_prov jsonb;
  v_temp_map jsonb := '{}'::jsonb;
  v_prov_number int;
  v_prov_id uuid;
  v_prov_amount numeric(14,2);
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_supplier from suppliers
   where suppliers.id = (p_header->>'supplier_id')::uuid;
  if not found then
    raise exception 'El proveedor no existe.';
  end if;

  select round(coalesce(sum((v->>'amount')::numeric), 0), 2)
    into v_total from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) as v;
  select round(coalesce(sum((a->>'amount')::numeric), 0), 2)
    into v_applied from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as a;

  if jsonb_array_length(coalesce(p_values, '[]'::jsonb)) = 0
     and jsonb_array_length(coalesce(p_allocations, '[]'::jsonb)) = 0 then
    raise exception 'La orden de pago no tiene ni comprobantes ni valores.';
  end if;

  if v_applied < 0 then
    raise exception 'Las notas de crédito superan a las facturas: no hay nada que pagar.';
  end if;

  if v_applied > v_total then
    raise exception 'Estás imputando $ % y la orden paga $ %.', v_applied, v_total;
  end if;

  for v_new_prov in select * from jsonb_array_elements(coalesce(p_new_provisional_credit_notes, '[]'::jsonb)) loop
    v_prov_amount := round((v_new_prov->>'amount')::numeric, 2);
    if v_prov_amount <= 0 then
      raise exception 'El importe de la NC provisoria tiene que ser mayor a cero.';
    end if;
    if coalesce(trim(v_new_prov->>'description'), '') = '' then
      raise exception 'Indicá el motivo de la NC provisoria.';
    end if;

    update provisional_credit_note_sequence set last_number = last_number + 1
     where provisional_credit_note_sequence.id = true
    returning provisional_credit_note_sequence.last_number into v_prov_number;

    insert into provisional_credit_notes (
      number, supplier_id, supplier_name, description, amount, created_by
    )
    values (
      v_prov_number, v_supplier.id, v_supplier.name,
      trim(v_new_prov->>'description'), v_prov_amount, auth.uid()
    )
    returning provisional_credit_notes.id into v_prov_id;

    v_temp_map := v_temp_map || jsonb_build_object(v_new_prov->>'temp_key', v_prov_id::text);
  end loop;

  if p_allocations is not null and jsonb_array_length(p_allocations) > 0 then
    for v_alloc in select * from jsonb_array_elements(p_allocations) loop
      declare
        v_doc purchase_invoices%rowtype;
        v_prov provisional_credit_notes%rowtype;
        v_amount numeric(14,2) := round((v_alloc->>'amount')::numeric, 2);
        v_prov_ref_id uuid := coalesce(
          nullif(v_alloc->>'provisional_credit_note_id', '')::uuid,
          nullif(v_temp_map->>(v_alloc->>'provisional_credit_note_temp_key'), '')::uuid
        );
      begin
        if v_prov_ref_id is not null then
          select * into v_prov from provisional_credit_notes
           where provisional_credit_notes.id = v_prov_ref_id for update;
          if not found then
            raise exception 'Una de las NC provisorias no existe.';
          end if;
          if v_prov.supplier_id <> v_supplier.id then
            raise exception 'La NC provisoria % es de otro proveedor.', v_prov.full_number;
          end if;
          if v_amount > 0 then
            raise exception 'La NC provisoria % resta: cargala en negativo.', v_prov.full_number;
          end if;
          if abs(v_amount) > v_prov.amount - v_prov.settled_amount then
            raise exception 'La NC provisoria % tiene $ % disponibles y estás imputando $ %.',
              v_prov.full_number, v_prov.amount - v_prov.settled_amount, abs(v_amount);
          end if;
        else
          select * into v_doc from purchase_invoices
           where purchase_invoices.id = (v_alloc->>'purchase_invoice_id')::uuid for update;
          if not found then
            raise exception 'Uno de los comprobantes no existe.';
          end if;
          if v_doc.status <> 'REGISTRADA' then
            raise exception 'El comprobante % está anulado.', v_doc.full_number;
          end if;
          if v_doc.supplier_id <> v_supplier.id then
            raise exception 'El comprobante % es de otro proveedor.', v_doc.full_number;
          end if;

          if v_doc.doc_type = 'NOTA_CREDITO' and v_amount > 0 then
            raise exception 'La nota de crédito % resta: cargala en negativo.', v_doc.full_number;
          end if;
          if v_doc.doc_type <> 'NOTA_CREDITO' and v_amount < 0 then
            raise exception 'El comprobante % suma: cargalo en positivo.', v_doc.full_number;
          end if;

          if abs(v_amount) > v_doc.total_amount - v_doc.settled_amount then
            raise exception 'El comprobante % tiene $ % pendientes y estás imputando $ %.',
              v_doc.full_number,
              v_doc.total_amount - v_doc.settled_amount, abs(v_amount);
          end if;
        end if;
      end;
    end loop;
  end if;

  select round(coalesce(sum((v->>'amount')::numeric), 0), 2)
    into v_credit_used
    from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) as v
   where v->>'kind' = 'SALDO_A_FAVOR';

  if v_credit_used > 0 and v_credit_used > public.supplier_credit(v_supplier.id) then
    raise exception 'Tenés $ % a favor con % y estás usando $ %.',
      public.supplier_credit(v_supplier.id), v_supplier.name, v_credit_used;
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) as v
     where v->>'kind' = 'RETENCION'
       and not exists (
         select 1 from tax_rates r
          where r.id = nullif(v->>'tax_rate_id', '')::uuid and r.kind = 'RETENCION'
       )
  ) then
    raise exception 'Alguna retención no apunta a una alícuota de tipo retención.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) as v
     where v->>'kind' = 'MEDIO_PAGO'
       and not exists (
         select 1 from payment_methods pm
          where pm.id = nullif(v->>'payment_method_id', '')::uuid
            and pm.active and pm.kind <> 'CARTERA_CHEQUES'
       )
  ) then
    raise exception 'Algún medio de pago no existe, está inactivo, o es la cartera (para eso endosá un cheque).';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) as v
     join third_party_checks c on c.id = nullif(v->>'check_id', '')::uuid
    where v->>'kind' = 'CHEQUE_ENDOSADO' and c.status <> 'EN_CARTERA'
  ) then
    raise exception 'Algún cheque ya no está en cartera: solo se endosan los que siguen en mano.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) as v
     where v->>'kind' = 'CHEQUE_ENDOSADO'
       and not exists (
         select 1 from third_party_checks c
          where c.id = nullif(v->>'check_id', '')::uuid
            and c.amount = round((v->>'amount')::numeric, 2)
       )
  ) then
    raise exception 'Un cheque se endosa por su importe completo, no por una parte.';
  end if;

  update payment_order_sequence set last_number = last_number + 1
   where payment_order_sequence.id = true
  returning payment_order_sequence.last_number into v_number;

  insert into payment_orders (
    number, full_number, status, supplier_id, supplier_name,
    payment_date, total_amount, applied_amount, notes, created_by
  )
  values (
    v_number, 'OP-' || lpad(v_number::text, 8, '0'), 'REGISTRADA',
    v_supplier.id, v_supplier.name,
    coalesce((p_header->>'payment_date')::date, current_date),
    v_total, v_applied,
    nullif(trim(coalesce(p_header->>'notes', '')), ''), auth.uid()
  )
  returning payment_orders.id, payment_orders.full_number into v_new_id, v_full_number;

  insert into payment_order_allocations (
    payment_order_id, purchase_invoice_id, provisional_credit_note_id, amount
  )
  select
    v_new_id,
    nullif(a->>'purchase_invoice_id', '')::uuid,
    coalesce(
      nullif(a->>'provisional_credit_note_id', '')::uuid,
      nullif(v_temp_map->>(a->>'provisional_credit_note_temp_key'), '')::uuid
    ),
    round((a->>'amount')::numeric, 2)
  from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as a;

  update purchase_invoices
     set settled_amount = purchase_invoices.settled_amount + abs(al.amount)
    from payment_order_allocations al
   where al.payment_order_id = v_new_id and al.purchase_invoice_id = purchase_invoices.id;

  update provisional_credit_notes
     set settled_amount = provisional_credit_notes.settled_amount + abs(al.amount)
    from payment_order_allocations al
   where al.payment_order_id = v_new_id
     and al.provisional_credit_note_id = provisional_credit_notes.id;

  v_wallet := public.checks_wallet_id();

  for v_value in select * from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) loop
    if v_value->>'kind' = 'CHEQUE_ENDOSADO' then
      insert into payment_order_values (payment_order_id, kind, amount, check_id)
      values (
        v_new_id, 'CHEQUE_ENDOSADO', round((v_value->>'amount')::numeric, 2),
        (v_value->>'check_id')::uuid
      );

      update third_party_checks
         set status = 'ENDOSADO', endorsed_to_supplier_id = v_supplier.id
       where third_party_checks.id = (v_value->>'check_id')::uuid;

      v_legs := v_legs || jsonb_build_object(
        'payment_method_id', v_wallet,
        'amount', -round((v_value->>'amount')::numeric, 2)
      );

    elsif v_value->>'kind' = 'MEDIO_PAGO' then
      insert into payment_order_values (payment_order_id, kind, amount, payment_method_id)
      values (
        v_new_id, 'MEDIO_PAGO', round((v_value->>'amount')::numeric, 2),
        (v_value->>'payment_method_id')::uuid
      );

      v_legs := v_legs || jsonb_build_object(
        'payment_method_id', (v_value->>'payment_method_id')::uuid,
        'amount', -round((v_value->>'amount')::numeric, 2)
      );

    elsif v_value->>'kind' = 'RETENCION' then
      insert into payment_order_values (
        payment_order_id, kind, amount, tax_rate_id, certificate_number
      )
      values (
        v_new_id, 'RETENCION', round((v_value->>'amount')::numeric, 2),
        (v_value->>'tax_rate_id')::uuid,
        nullif(trim(coalesce(v_value->>'certificate_number', '')), '')
      );

    else
      insert into payment_order_values (payment_order_id, kind, amount)
      values (v_new_id, 'SALDO_A_FAVOR', round((v_value->>'amount')::numeric, 2));
    end if;
  end loop;

  select round(coalesce(sum(abs((leg->>'amount')::numeric)), 0), 2)
    into v_cash from jsonb_array_elements(v_legs) as leg;

  if v_cash > 0 then
    select * into v_movement from public.post_treasury_movement(
      'EGRESO',
      coalesce((p_header->>'payment_date')::date, current_date),
      null,
      'Pago ' || v_full_number || ' — ' || v_supplier.name,
      v_supplier.name,
      v_cash,
      v_legs,
      nullif(trim(coalesce(p_header->>'notes', '')), '')
    );

    update payment_orders set treasury_movement_id = v_movement.movement_id
     where payment_orders.id = v_new_id;
  end if;

  return query select v_new_id, v_full_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.save_purchase_invoice(p_header jsonb, p_items jsonb, p_taxes jsonb DEFAULT '[]'::jsonb)
 RETURNS TABLE(purchase_id uuid, purchase_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_supplier suppliers%rowtype;
  v_kind purchase_kind;
  v_doc_type purchase_doc_type;
  v_moves_stock boolean;
  v_stock_sign int;
  v_general_discount numeric(5,2);
  v_gross numeric(14,2);
  v_line_discount numeric(14,2);
  v_general_discount_amount numeric(14,2);
  v_net_taxed numeric(14,2);
  v_net_exempt numeric(14,2);
  v_net_untaxed numeric(14,2);
  v_vat numeric(14,2);
  v_other numeric(14,2);
  v_net_total numeric(14,2);
  v_new_id uuid;
  v_full_number text;
  v_item jsonb;
  v_article_code text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  v_kind := (p_header->>'kind')::purchase_kind;
  v_doc_type := (p_header->>'doc_type')::purchase_doc_type;
  v_general_discount := coalesce((p_header->>'general_discount_percent')::numeric, 0);

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'El comprobante no tiene renglones cargados.';
  end if;

  -- Un comprobante es de artículos o de conceptos, nunca de los dos. Sin
  -- esta guarda, un renglón de artículo colado en una factura de conceptos
  -- se guardaría sin mover stock y nadie se enteraría.
  if v_kind = 'ARTICULOS' and exists (
    select 1 from jsonb_array_elements(p_items) as item
     where nullif(item->>'article_id', '') is null
  ) then
    raise exception 'En una compra de artículos, todos los renglones tienen que salir del catálogo.';
  end if;

  if v_kind = 'CONCEPTOS' and exists (
    select 1 from jsonb_array_elements(p_items) as item
     where nullif(item->>'article_id', '') is not null
  ) then
    raise exception 'Una compra de conceptos no puede llevar artículos del catálogo.';
  end if;

  -- Los renglones y el pie se insertan con un join contra tax_rates. Si una
  -- alícuota no existe, el join DESCARTA la fila en silencio y el comprobante
  -- se guarda incompleto y cuadrando mal. Se valida antes de llegar ahí.
  if exists (
    select 1 from jsonb_array_elements(p_items) as item
     where not exists (
       select 1 from tax_rates r
        where r.id = nullif(item->>'vat_rate_id', '')::uuid and r.kind = 'IVA'
     )
  ) then
    raise exception 'Algún renglón no tiene una alícuota de IVA válida.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_taxes, '[]'::jsonb)) as tax
     where not exists (
       select 1 from tax_rates r where r.id = nullif(tax->>'tax_rate_id', '')::uuid
     )
  ) then
    raise exception 'Algún impuesto del pie no existe en el padrón de alícuotas.';
  end if;

  -- Una retención no se practica al comprar sino al pagar: no puede sumar en
  -- el comprobante. El IVA va por renglón, no al pie.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_taxes, '[]'::jsonb)) as tax
     join tax_rates r on r.id = (tax->>'tax_rate_id')::uuid
    where r.kind in ('RETENCION', 'IVA')
  ) then
    raise exception 'En el pie solo van percepciones e impuestos internos. El IVA se carga por renglón y las retenciones las aplica el módulo de pagos.';
  end if;

  select * into v_supplier from suppliers where suppliers.id = (p_header->>'supplier_id')::uuid;
  if not found then
    raise exception 'El proveedor no existe.';
  end if;

  -- Quién decide si mueve stock, y no el cliente:
  --   conceptos            → nunca
  --   factura de artículos → siempre, porque la mercadería entró
  --   NC / ND de artículos → lo marca el usuario, porque en el papel no se
  --                          distingue una devolución de un ajuste de precio
  v_moves_stock := case
    when v_kind <> 'ARTICULOS' then false
    when v_doc_type = 'FACTURA' then true
    else coalesce((p_header->>'moves_stock')::boolean, false)
  end;

  -- La dirección sale del tipo de comprobante, no del tilde.
  v_stock_sign := case when v_doc_type = 'NOTA_CREDITO' then -1 else 1 end;

  -- ── Renglones.
  with lines as (
    select
      (item->>'quantity')::numeric                       as quantity,
      (item->>'unit_price')::numeric                     as unit_price,
      coalesce((item->>'discount_percent')::numeric, 0)  as discount_percent,
      (item->>'vat_rate_id')::uuid                       as vat_rate_id
    from jsonb_array_elements(p_items) as item
  ),
  priced as (
    select
      round(l.quantity * l.unit_price, 2)                                    as gross,
      round(l.quantity * l.unit_price * l.discount_percent / 100, 2)         as line_disc,
      -- El descuento general se reparte proporcionalmente sobre cada renglón,
      -- así la suma de los netos sigue siendo el neto del comprobante.
      round((l.quantity * l.unit_price) * (1 - l.discount_percent / 100)
        * (1 - v_general_discount / 100), 2)                                 as net,
      r.rate                                                                 as rate,
      r.vat_treatment                                                        as treatment
    from lines l
    join tax_rates r on r.id = l.vat_rate_id
  )
  -- Se redondea POR RENGLÓN y después se suma, no al revés. Los renglones se
  -- guardan redondeados; si el pie sumara los valores sin redondear, la
  -- columna de netos podría no dar el neto del pie por uno o dos centavos, y
  -- un comprobante donde las partes no suman el total no sirve.
  select
    coalesce(sum(gross), 0),
    coalesce(sum(line_disc), 0),
    coalesce(sum(net) filter (where treatment = 'GRAVADO'), 0),
    coalesce(sum(net) filter (where treatment = 'EXENTO'), 0),
    coalesce(sum(net) filter (where treatment = 'NO_GRAVADO'), 0),
    coalesce(sum(round(net * rate / 100, 2)) filter (where treatment = 'GRAVADO'), 0)
  into v_gross, v_line_discount, v_net_taxed, v_net_exempt, v_net_untaxed, v_vat
  from priced;

  if v_gross <= 0 then
    raise exception 'El total del comprobante tiene que ser mayor a cero.';
  end if;

  v_net_total := v_net_taxed + v_net_exempt + v_net_untaxed;
  v_general_discount_amount := round((v_gross - v_line_discount) * v_general_discount / 100, 2);

  select round(coalesce(sum((tax->>'amount')::numeric), 0), 2)
  into v_other
  from jsonb_array_elements(coalesce(p_taxes, '[]'::jsonb)) as tax;

  insert into purchase_invoices (
    kind, doc_type, letter, sales_point, number, status,
    supplier_id, supplier_name, supplier_legal_name, supplier_tax_id, supplier_tax_condition,
    issue_date, received_date, due_date, payment_terms_days, moves_stock,
    gross_amount, line_discount_amount, general_discount_percent, general_discount_amount,
    net_taxed, net_exempt, net_untaxed, vat_amount, other_taxes_amount, total_amount,
    notes, created_by
  )
  values (
    v_kind, v_doc_type, (p_header->>'letter')::purchase_letter,
    (p_header->>'sales_point')::int, (p_header->>'number')::int, 'REGISTRADA',
    v_supplier.id, v_supplier.name, v_supplier.legal_name, v_supplier.tax_id,
    v_supplier.tax_condition::text,
    (p_header->>'issue_date')::date,
    coalesce((p_header->>'received_date')::date, current_date),
    (p_header->>'due_date')::date,
    coalesce((p_header->>'payment_terms_days')::int, v_supplier.payment_terms_days),
    v_moves_stock,
    v_gross, v_line_discount, v_general_discount, v_general_discount_amount,
    v_net_taxed, v_net_exempt, v_net_untaxed, v_vat, v_other,
    v_net_total + v_vat + v_other,
    nullif(trim(coalesce(p_header->>'notes', '')), ''), auth.uid()
  )
  returning purchase_invoices.id, purchase_invoices.full_number into v_new_id, v_full_number;

  insert into purchase_invoice_items (
    purchase_invoice_id, line_number, article_id, concept_id, code, description,
    quantity, unit_price, discount_percent, net_amount,
    vat_rate_id, vat_rate, vat_treatment, vat_amount
  )
  select
    v_new_id,
    ord,
    nullif(item->>'article_id', '')::uuid,
    nullif(item->>'concept_id', '')::uuid,
    nullif(trim(coalesce(item->>'code', '')), ''),
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    coalesce((item->>'discount_percent')::numeric, 0),
    round((item->>'quantity')::numeric * (item->>'unit_price')::numeric
      * (1 - coalesce((item->>'discount_percent')::numeric, 0) / 100)
      * (1 - v_general_discount / 100), 2),
    r.id, r.rate, r.vat_treatment,
    case when r.vat_treatment = 'GRAVADO' then
      round((item->>'quantity')::numeric * (item->>'unit_price')::numeric
        * (1 - coalesce((item->>'discount_percent')::numeric, 0) / 100)
        * (1 - v_general_discount / 100) * r.rate / 100, 2)
    else 0 end
  from jsonb_array_elements(p_items) with ordinality as t(item, ord)
  join tax_rates r on r.id = (item->>'vat_rate_id')::uuid;

  insert into purchase_invoice_taxes (
    purchase_invoice_id, tax_rate_id, name, kind, rate, base_amount, amount
  )
  select
    v_new_id, r.id, r.name, r.kind, r.rate,
    case when r.base = 'TOTAL' then v_net_total + v_vat else v_net_total end,
    (tax->>'amount')::numeric
  from jsonb_array_elements(coalesce(p_taxes, '[]'::jsonb)) as tax
  join tax_rates r on r.id = (tax->>'tax_rate_id')::uuid;

  -- ── Inventario.
  -- Se recorre renglón por renglón en vez de agrupar: si el mismo artículo
  -- aparece dos veces en la factura, los dos movimientos tienen que contar.
  -- adjust_article_stock bloquea la fila, ignora los artículos que no llevan
  -- stock y rechaza dejar el saldo en negativo, que es justo lo que tiene que
  -- pasar si una nota de crédito devuelve más de lo que queda.
  if v_moves_stock then
    for v_item in select * from jsonb_array_elements(p_items) loop
      perform public.adjust_article_stock(
        (v_item->>'article_id')::uuid,
        v_stock_sign * (v_item->>'quantity')::numeric
      );
    end loop;
  end if;

  -- ── Precio de compra.
  -- Solo la FACTURA lo actualiza: una nota de crédito o de débito es un
  -- ajuste puntual y no debería mover la lista de venta.
  if v_kind = 'ARTICULOS' and v_doc_type = 'FACTURA' then
    for v_item in select * from jsonb_array_elements(p_items) loop
      select a.code into v_article_code
        from articles a where a.id = (v_item->>'article_id')::uuid;

      insert into article_suppliers (
        article_id, supplier_id, supplier_code, purchase_price, is_preferred
      )
      values (
        (v_item->>'article_id')::uuid,
        v_supplier.id,
        -- El código propio del proveedor se corrige al importar su lista;
        -- mientras tanto se usa el nuestro, que es único por artículo y por
        -- lo tanto no choca con el índice (supplier_id, upper(supplier_code)).
        v_article_code,
        -- El neto unitario ya bonificado: es lo que realmente costó.
        round((v_item->>'unit_price')::numeric
          * (1 - coalesce((v_item->>'discount_percent')::numeric, 0) / 100)
          * (1 - v_general_discount / 100), 4),
        -- Preferido solo si el artículo no tenía NINGÚN proveedor. Si ya
        -- tenía uno, este entra como alternativo y el precio de venta no se
        -- mueve: una compra suelta a un proveedor nuevo no puede recalcular
        -- la lista sin que nadie lo decida.
        not exists (
          select 1 from article_suppliers existing
           where existing.article_id = (v_item->>'article_id')::uuid
        )
      )
      on conflict (article_id, supplier_id) do update
        set purchase_price = excluded.purchase_price;
      -- El trigger article_suppliers_recalc_price recalcula solo el precio de
      -- venta cuando el proveedor tocado es el preferido.
    end loop;
  end if;

  return query select v_new_id, v_full_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.save_receipt(p_header jsonb, p_allocations jsonb, p_values jsonb, p_changes jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(receipt_id uuid, receipt_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer customers%rowtype;
  v_number int;
  v_new_id uuid;
  v_full_number text;
  v_total numeric(14,2);
  v_applied numeric(14,2);
  v_credit_used numeric(14,2);
  v_cash numeric(14,2);
  v_wallet uuid;
  v_value jsonb;
  v_check_id uuid;
  v_legs jsonb := '[]'::jsonb;
  v_movement record;
  v_alloc jsonb;
  v_change jsonb;
  v_change_amount numeric(14,2);
  v_change_kind text;
  v_changes_cash numeric(14,2);
  v_change_legs jsonb := '[]'::jsonb;
  v_change_movement record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_customer from customers
   where customers.id = (p_header->>'customer_id')::uuid;
  if not found then
    raise exception 'El cliente no existe.';
  end if;

  if p_values is null or jsonb_array_length(p_values) = 0 then
    raise exception 'El recibo no tiene valores cargados.';
  end if;

  select round(coalesce(sum((v->>'amount')::numeric), 0), 2)
    into v_total from jsonb_array_elements(p_values) as v;
  select round(coalesce(sum((a->>'amount')::numeric), 0), 2)
    into v_applied from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as a;

  if v_total <= 0 then
    raise exception 'El total del recibo tiene que ser mayor a cero.';
  end if;

  if v_applied > v_total then
    raise exception 'Estás imputando $ % pero el recibo cobra $ %.', v_applied, v_total;
  end if;

  if p_changes is not null and jsonb_array_length(p_changes) > 0 then
    select round(coalesce(sum((c->>'amount')::numeric), 0), 2)
      into v_changes_cash from jsonb_array_elements(p_changes) as c;

    if v_changes_cash > (v_total - v_applied) then
      raise exception 'El vuelto ($ %) no puede ser mayor a lo que queda a cuenta ($ %).',
        v_changes_cash, v_total - v_applied;
    end if;

    if exists (
      select 1 from jsonb_array_elements(p_changes) as c
       where round((c->>'amount')::numeric, 2) <= 0
    ) then
      raise exception 'Hay un tramo del vuelto con importe en cero.';
    end if;

    if exists (
      select 1 from jsonb_array_elements(p_changes) as c
       where c->>'kind' not in ('MEDIO_PAGO', 'CHEQUE_PROPIO', 'CHEQUE_ENDOSADO')
    ) then
      raise exception 'Tipo de vuelto desconocido.';
    end if;

    if exists (
      select 1 from jsonb_array_elements(p_changes) as c
       where c->>'kind' = 'MEDIO_PAGO'
         and not exists (
           select 1 from payment_methods pm
            where pm.id = nullif(c->>'payment_method_id', '')::uuid
              and pm.active and pm.kind <> 'CARTERA_CHEQUES'
         )
    ) then
      raise exception 'El medio de un tramo del vuelto no existe, está inactivo, o es la cartera de cheques.';
    end if;

    if exists (
      select 1 from jsonb_array_elements(p_changes) as c
       where c->>'kind' = 'CHEQUE_PROPIO' and coalesce(trim(c->>'note'), '') = ''
    ) then
      raise exception 'Indicá una referencia para el cheque propio del vuelto.';
    end if;

    if exists (
      select 1 from jsonb_array_elements(p_changes) as c
       where c->>'kind' = 'CHEQUE_ENDOSADO'
         and not exists (
           select 1 from third_party_checks ch
            where ch.id = nullif(c->>'check_id', '')::uuid and ch.status = 'EN_CARTERA'
         )
    ) then
      raise exception 'Algún cheque del vuelto ya no está en cartera.';
    end if;

    if exists (
      select 1 from jsonb_array_elements(p_changes) as c
       where c->>'kind' = 'CHEQUE_ENDOSADO'
         and not exists (
           select 1 from third_party_checks ch
            where ch.id = nullif(c->>'check_id', '')::uuid
              and ch.amount = round((c->>'amount')::numeric, 2)
         )
    ) then
      raise exception 'Un cheque se entrega de vuelto por su importe completo, no por una parte.';
    end if;
  end if;

  if p_allocations is not null and jsonb_array_length(p_allocations) > 0 then
    for v_alloc in select * from jsonb_array_elements(p_allocations) loop
      declare
        v_invoice invoices%rowtype;
        v_amount numeric(14,2) := round((v_alloc->>'amount')::numeric, 2);
      begin
        select * into v_invoice from invoices
         where invoices.id = (v_alloc->>'invoice_id')::uuid for update;
        if not found then
          raise exception 'Una de las facturas no existe.';
        end if;
        if v_invoice.status <> 'EMITIDA' then
          raise exception 'La factura % está anulada y no se puede cobrar.', v_invoice.full_number;
        end if;
        if v_invoice.customer_id <> v_customer.id then
          raise exception 'La factura % es de otro cliente.', v_invoice.full_number;
        end if;
        if v_amount > v_invoice.total_amount - v_invoice.paid_amount then
          raise exception 'La factura % debe $ % y estás imputando $ %.',
            v_invoice.full_number,
            v_invoice.total_amount - v_invoice.paid_amount, v_amount;
        end if;
      end;
    end loop;
  end if;

  select round(coalesce(sum((v->>'amount')::numeric), 0), 2)
    into v_credit_used
    from jsonb_array_elements(p_values) as v
   where v->>'kind' = 'SALDO_A_FAVOR';

  if v_credit_used > 0 and v_credit_used > public.customer_credit(v_customer.id) then
    raise exception '% tiene $ % a favor y estás usando $ %.',
      v_customer.name, public.customer_credit(v_customer.id), v_credit_used;
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_values) as v
     where v->>'kind' = 'RETENCION'
       and not exists (
         select 1 from tax_rates r
          where r.id = nullif(v->>'tax_rate_id', '')::uuid and r.kind = 'RETENCION'
       )
  ) then
    raise exception 'Alguna retención no apunta a una alícuota de tipo retención.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_values) as v
     where v->>'kind' = 'MEDIO_PAGO'
       and not exists (
         select 1 from payment_methods pm
          where pm.id = nullif(v->>'payment_method_id', '')::uuid
            and pm.active and pm.kind <> 'CARTERA_CHEQUES'
       )
  ) then
    raise exception 'Algún medio de pago no existe, está inactivo, o es la cartera de cheques (para eso cargá el cheque).';
  end if;

  update receipt_sequence set last_number = last_number + 1
   where receipt_sequence.id = true
  returning receipt_sequence.last_number into v_number;

  insert into receipts (
    number, full_number, status, customer_id, customer_name,
    receipt_date, total_amount, applied_amount, notes, created_by
  )
  values (
    v_number, 'REC-' || lpad(v_number::text, 8, '0'), 'REGISTRADO',
    v_customer.id, v_customer.name,
    coalesce((p_header->>'receipt_date')::date, current_date),
    v_total, v_applied,
    nullif(trim(coalesce(p_header->>'notes', '')), ''), auth.uid()
  )
  returning receipts.id, receipts.full_number into v_new_id, v_full_number;

  insert into receipt_allocations (receipt_id, invoice_id, amount)
  select v_new_id, (a->>'invoice_id')::uuid, round((a->>'amount')::numeric, 2)
  from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as a;

  update invoices
     set paid_amount = invoices.paid_amount + al.amount
    from receipt_allocations al
   where al.receipt_id = v_new_id and al.invoice_id = invoices.id;

  v_wallet := public.checks_wallet_id();

  for v_value in select * from jsonb_array_elements(p_values) loop
    if v_value->>'kind' = 'CHEQUE' then
      if v_wallet is null then
        raise exception 'No hay una cartera de cheques cargada. Creala en Medios de pago.';
      end if;

      insert into third_party_checks (
        number, bank_name, drawer, issue_date, due_date, amount, status, created_by
      )
      values (
        trim(v_value->>'check_number'), trim(v_value->>'check_bank'),
        nullif(trim(coalesce(v_value->>'check_drawer', '')), ''),
        (v_value->>'check_issue_date')::date,
        (v_value->>'check_due_date')::date,
        round((v_value->>'amount')::numeric, 2),
        'EN_CARTERA', auth.uid()
      )
      returning third_party_checks.id into v_check_id;

      insert into receipt_values (receipt_id, kind, amount, check_id)
      values (v_new_id, 'CHEQUE', round((v_value->>'amount')::numeric, 2), v_check_id);

      v_legs := v_legs || jsonb_build_object(
        'payment_method_id', v_wallet,
        'amount', round((v_value->>'amount')::numeric, 2)
      );

    elsif v_value->>'kind' = 'MEDIO_PAGO' then
      insert into receipt_values (receipt_id, kind, amount, payment_method_id)
      values (
        v_new_id, 'MEDIO_PAGO', round((v_value->>'amount')::numeric, 2),
        (v_value->>'payment_method_id')::uuid
      );

      v_legs := v_legs || jsonb_build_object(
        'payment_method_id', (v_value->>'payment_method_id')::uuid,
        'amount', round((v_value->>'amount')::numeric, 2)
      );

    elsif v_value->>'kind' = 'RETENCION' then
      insert into receipt_values (receipt_id, kind, amount, tax_rate_id, certificate_number)
      values (
        v_new_id, 'RETENCION', round((v_value->>'amount')::numeric, 2),
        (v_value->>'tax_rate_id')::uuid,
        nullif(trim(coalesce(v_value->>'certificate_number', '')), '')
      );

    else
      insert into receipt_values (receipt_id, kind, amount)
      values (v_new_id, 'SALDO_A_FAVOR', round((v_value->>'amount')::numeric, 2));
    end if;
  end loop;

  select round(coalesce(sum((leg->>'amount')::numeric), 0), 2)
    into v_cash from jsonb_array_elements(v_legs) as leg;

  if v_cash > 0 then
    select * into v_movement from public.post_treasury_movement(
      'INGRESO',
      coalesce((p_header->>'receipt_date')::date, current_date),
      null,
      'Cobranza ' || v_full_number || ' — ' || v_customer.name,
      v_customer.name,
      v_cash,
      v_legs,
      nullif(trim(coalesce(p_header->>'notes', '')), '')
    );

    update receipts set treasury_movement_id = v_movement.movement_id
     where receipts.id = v_new_id;

    update third_party_checks set received_movement_id = v_movement.movement_id
     where third_party_checks.id in (
       select v.check_id from receipt_values v
        where v.receipt_id = v_new_id and v.check_id is not null
     );
  end if;

  -- ── Vuelto, primera pasada: arma las partidas del egreso compartido y
  -- entrega los cheques. Todavía no se inserta nada en receipt_changes —
  -- la restricción de la tabla exige el treasury_movement_id puesto, y ese
  -- movimiento recién se postea después de saber el total de esta pasada.
  if p_changes is not null and jsonb_array_length(p_changes) > 0 then
    for v_change in select * from jsonb_array_elements(p_changes) loop
      v_change_amount := round((v_change->>'amount')::numeric, 2);
      v_change_kind := v_change->>'kind';

      if v_change_kind = 'MEDIO_PAGO' then
        -- EGRESO: la partida va en negativo (ver buildLegs/endorse_check).
        v_change_legs := v_change_legs || jsonb_build_object(
          'payment_method_id', (v_change->>'payment_method_id')::uuid,
          'amount', -v_change_amount
        );

      elsif v_change_kind = 'CHEQUE_ENDOSADO' then
        update third_party_checks
           set status = 'ENDOSADO', endorsed_to_customer_id = v_customer.id
         where third_party_checks.id = (v_change->>'check_id')::uuid;

        v_change_legs := v_change_legs || jsonb_build_object(
          'payment_method_id', v_wallet,
          'amount', -v_change_amount
        );
      end if;
      -- CHEQUE_PROPIO: sin objeto financiero, no genera partida.
    end loop;

    if jsonb_array_length(v_change_legs) > 0 then
      select round(coalesce(sum(-(leg->>'amount')::numeric), 0), 2)
        into v_changes_cash
        from jsonb_array_elements(v_change_legs) as leg;

      select * into v_change_movement from public.post_treasury_movement(
        'EGRESO',
        coalesce((p_header->>'receipt_date')::date, current_date),
        null,
        'Vuelto cobranza ' || v_full_number || ' — ' || v_customer.name,
        v_customer.name,
        v_changes_cash,
        v_change_legs,
        null
      );
    end if;

    -- ── Vuelto, segunda pasada: un renglón por tramo, ya con el movimiento
    -- compartido (si lo hay) resuelto.
    for v_change in select * from jsonb_array_elements(p_changes) loop
      v_change_amount := round((v_change->>'amount')::numeric, 2);
      v_change_kind := v_change->>'kind';

      if v_change_kind = 'MEDIO_PAGO' then
        insert into receipt_changes (receipt_id, kind, amount, payment_method_id, treasury_movement_id, created_by)
        values (v_new_id, 'MEDIO_PAGO', v_change_amount, (v_change->>'payment_method_id')::uuid, v_change_movement.movement_id, auth.uid());

      elsif v_change_kind = 'CHEQUE_ENDOSADO' then
        insert into receipt_changes (receipt_id, kind, amount, check_id, treasury_movement_id, created_by)
        values (v_new_id, 'CHEQUE_ENDOSADO', v_change_amount, (v_change->>'check_id')::uuid, v_change_movement.movement_id, auth.uid());

      else -- CHEQUE_PROPIO
        insert into receipt_changes (receipt_id, kind, amount, note, created_by)
        values (v_new_id, 'CHEQUE_PROPIO', v_change_amount, trim(v_change->>'note'), auth.uid());
      end if;
    end loop;
  end if;

  return query select v_new_id, v_full_number;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.save_treasury_movement(p_header jsonb, p_legs jsonb)
 RETURNS TABLE(movement_id uuid, movement_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_type treasury_movement_type;
  v_amount numeric(14,2);
  v_sum numeric(14,2);
  v_positives numeric(14,2);
  v_negatives numeric(14,2);
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  v_type := (p_header->>'movement_type')::treasury_movement_type;
  v_amount := (p_header->>'amount')::numeric;

  if v_amount is null or v_amount <= 0 then
    raise exception 'El importe del movimiento tiene que ser mayor a cero.';
  end if;

  if p_legs is null or jsonb_array_length(p_legs) = 0 then
    raise exception 'El movimiento no tiene medios de pago cargados.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_legs) as leg
     where not exists (
       select 1 from payment_methods pm
        where pm.id = nullif(leg->>'payment_method_id', '')::uuid and pm.active
     )
  ) then
    raise exception 'Alguna partida apunta a un medio de pago que no existe o está inactivo.';
  end if;

  -- La cartera no se mueve a mano: sus partidas las generan las operaciones
  -- de cheques, que además mantienen el estado de cada valor. Una partida
  -- suelta acá dejaría el saldo sin ningún cheque que lo respalde.
  if exists (
    select 1 from jsonb_array_elements(p_legs) as leg
     join payment_methods pm on pm.id = (leg->>'payment_method_id')::uuid
    where pm.kind = 'CARTERA_CHEQUES'
  ) then
    raise exception 'La cartera de cheques se mueve desde la pantalla de Cheques: recibir, depositar, acreditar o endosar.';
  end if;

  select
    coalesce(sum(round((leg->>'amount')::numeric, 2)), 0),
    coalesce(sum(round((leg->>'amount')::numeric, 2))
             filter (where round((leg->>'amount')::numeric, 2) > 0), 0),
    coalesce(sum(round((leg->>'amount')::numeric, 2))
             filter (where round((leg->>'amount')::numeric, 2) < 0), 0)
  into v_sum, v_positives, v_negatives
  from jsonb_array_elements(p_legs) as leg;

  if v_type = 'EGRESO' then
    if v_positives <> 0 then
      raise exception 'Un egreso no puede tener partidas que sumen a un medio de pago.';
    end if;
    if v_sum <> -v_amount then
      raise exception 'Las partidas suman $ % y el egreso dice $ %.', abs(v_sum), v_amount;
    end if;

  elsif v_type = 'INGRESO' then
    if v_negatives <> 0 then
      raise exception 'Un ingreso no puede tener partidas que resten de un medio de pago.';
    end if;
    if v_sum <> v_amount then
      raise exception 'Las partidas suman $ % y el ingreso dice $ %.', v_sum, v_amount;
    end if;

  else -- TRANSFERENCIA
    if jsonb_array_length(p_legs) < 2 then
      raise exception 'Una transferencia necesita al menos un origen y un destino.';
    end if;
    if v_sum <> 0 then
      raise exception 'Una transferencia tiene que sumar cero: lo que sale de un medio entra en otro.';
    end if;
    if v_positives <> v_amount then
      raise exception 'La transferencia mueve $ % pero dice $ %.', v_positives, v_amount;
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_legs) as leg
      group by leg->>'payment_method_id'
      having count(*) > 1
    ) then
      raise exception 'Una transferencia no puede repetir el mismo medio de pago en dos partidas.';
    end if;
  end if;

  return query
  select m.movement_id, m.movement_full_number
    from public.post_treasury_movement(
      v_type,
      coalesce((p_header->>'movement_date')::date, current_date),
      nullif(p_header->>'concept_id', '')::uuid,
      p_header->>'description',
      p_header->>'payee',
      v_amount,
      p_legs,
      p_header->>'notes'
    ) as m;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_gmail_credential(p_password text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
begin
  if not is_admin() then
    raise exception 'Solo un administrador puede cargar la credencial de Gmail.';
  end if;

  if p_password is null or trim(p_password) = '' then
    raise exception 'La credencial no puede estar vacía.';
  end if;

  if exists (select 1 from vault.secrets where name = 'gmail_app_password') then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'gmail_app_password'),
      trim(p_password)
    );
  else
    perform vault.create_secret(trim(p_password), 'gmail_app_password', 'Clave de aplicación de Gmail para enviar facturas.');
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_preferred_supplier(p_article_id uuid, p_supplier_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  update article_suppliers set is_preferred = false
  where article_id = p_article_id and is_preferred and supplier_id <> p_supplier_id;

  update article_suppliers set is_preferred = true
  where article_id = p_article_id and supplier_id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no esta vinculado a este articulo.';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_retention_certificate(p_receipt_value_id uuid, p_certificate_number text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_value receipt_values%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_certificate_number), '') = '' then
    raise exception 'Indicá el número de comprobante.';
  end if;

  select * into v_value from receipt_values where id = p_receipt_value_id;
  if not found then
    raise exception 'La retención no existe.';
  end if;
  if v_value.kind <> 'RETENCION' then
    raise exception 'Ese valor no es una retención.';
  end if;

  update receipt_values
     set certificate_number = trim(p_certificate_number)
   where id = p_receipt_value_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.supplier_credit(p_supplier_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select sum(o.on_account_amount)
      from payment_orders o
     where o.supplier_id = p_supplier_id and o.status = 'REGISTRADA'
  ), 0) - coalesce((
    select sum(v.amount)
      from payment_order_values v
      join payment_orders o on o.id = v.payment_order_id
     where o.supplier_id = p_supplier_id
       and o.status = 'REGISTRADA'
       and v.kind = 'SALDO_A_FAVOR'
  ), 0);
$function$
;

CREATE OR REPLACE FUNCTION public.sync_customer_phone()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.phone_e164 := public.normalize_ar_phone(new.phone);
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.void_payment_order(p_order_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order payment_orders%rowtype;
  v_bad record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_order from payment_orders
   where payment_orders.id = p_order_id for update;
  if not found then
    raise exception 'La orden de pago no existe.';
  end if;
  if v_order.status = 'ANULADA' then
    raise exception 'La orden % ya está anulada.', v_order.full_number;
  end if;

  select pcn.full_number into v_bad
    from payment_order_allocations al
    join provisional_credit_notes pcn on pcn.id = al.provisional_credit_note_id
   where al.payment_order_id = p_order_id and pcn.status = 'FORMALIZADA'
   limit 1;

  if found then
    raise exception 'La NC provisoria % ya fue formalizada y no se puede dar de baja la orden.', v_bad.full_number;
  end if;

  update purchase_invoices
     set settled_amount = purchase_invoices.settled_amount - abs(al.amount)
    from payment_order_allocations al
   where al.payment_order_id = p_order_id and al.purchase_invoice_id = purchase_invoices.id;

  update provisional_credit_notes
     set settled_amount = provisional_credit_notes.settled_amount - abs(al.amount)
    from payment_order_allocations al
   where al.payment_order_id = p_order_id
     and al.provisional_credit_note_id = provisional_credit_notes.id;

  update third_party_checks
     set status = 'EN_CARTERA', endorsed_to_supplier_id = null
   where third_party_checks.id in (
     select v.check_id from payment_order_values v
      where v.payment_order_id = p_order_id and v.check_id is not null
   );

  if v_order.treasury_movement_id is not null then
    perform public.void_treasury_movement(
      v_order.treasury_movement_id,
      'Anulación de la orden ' || v_order.full_number || ': ' || trim(p_reason)
    );
  end if;

  update payment_orders
     set status = 'ANULADA', voided_at = now(), voided_reason = trim(p_reason)
   where payment_orders.id = p_order_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.void_purchase_invoice(p_purchase_invoice_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_doc purchase_invoices%rowtype;
  v_stock_sign int;
  v_row record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_doc from purchase_invoices
   where purchase_invoices.id = p_purchase_invoice_id for update;
  if not found then
    raise exception 'El comprobante no existe.';
  end if;
  if v_doc.status = 'ANULADA' then
    raise exception 'El comprobante % ya está anulado.', v_doc.full_number;
  end if;
  if v_doc.settled_amount > 0 then
    raise exception 'El comprobante % tiene pagos imputados por $ %. Revertí los pagos antes de anularlo.',
      v_doc.full_number, v_doc.settled_amount;
  end if;

  -- Signo INVERSO al que se aplicó al registrarlo.
  v_stock_sign := case when v_doc.doc_type = 'NOTA_CREDITO' then 1 else -1 end;

  if v_doc.moves_stock then
    for v_row in
      select article_id, quantity from purchase_invoice_items
       where purchase_invoice_id = p_purchase_invoice_id and article_id is not null
    loop
      perform public.adjust_article_stock(v_row.article_id, v_stock_sign * v_row.quantity);
    end loop;
  end if;

  update purchase_invoices
     set status = 'ANULADA',
         voided_at = now(),
         voided_reason = trim(p_reason)
   where purchase_invoices.id = p_purchase_invoice_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.void_receipt(p_receipt_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_receipt receipts%rowtype;
  v_bad record;
  v_change_movement_id uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_receipt from receipts where receipts.id = p_receipt_id for update;
  if not found then
    raise exception 'El recibo no existe.';
  end if;
  if v_receipt.status = 'ANULADO' then
    raise exception 'El recibo % ya está anulado.', v_receipt.full_number;
  end if;

  select c.number, c.bank_name, c.status into v_bad
    from receipt_values v
    join third_party_checks c on c.id = v.check_id
   where v.receipt_id = p_receipt_id and c.status <> 'EN_CARTERA'
   limit 1;

  if found then
    raise exception 'El cheque % de % ya está % y no se puede dar de baja. Resolvé el cheque antes de anular el recibo.',
      v_bad.number, v_bad.bank_name, lower(v_bad.status::text);
  end if;

  update invoices
     set paid_amount = invoices.paid_amount - al.amount
    from receipt_allocations al
   where al.receipt_id = p_receipt_id and al.invoice_id = invoices.id;

  update third_party_checks set status = 'ANULADO'
   where third_party_checks.id in (
     select v.check_id from receipt_values v
      where v.receipt_id = p_receipt_id and v.check_id is not null
   );

  update third_party_checks
     set status = 'EN_CARTERA', endorsed_to_customer_id = null
   where third_party_checks.id in (
     select rc.check_id from receipt_changes rc
      where rc.receipt_id = p_receipt_id and rc.check_id is not null
   );

  if v_receipt.treasury_movement_id is not null then
    perform public.void_treasury_movement(
      v_receipt.treasury_movement_id,
      'Anulación del recibo ' || v_receipt.full_number || ': ' || trim(p_reason)
    );
  end if;

  for v_change_movement_id in
    select distinct rc.treasury_movement_id from receipt_changes rc
     where rc.receipt_id = p_receipt_id and rc.treasury_movement_id is not null
  loop
    perform public.void_treasury_movement(
      v_change_movement_id,
      'Anulación del recibo ' || v_receipt.full_number || ': ' || trim(p_reason)
    );
  end loop;

  update receipts
     set status = 'ANULADO', voided_at = now(), voided_reason = trim(p_reason)
   where receipts.id = p_receipt_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.void_remito(p_remito_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.void_treasury_movement(p_movement_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_movement treasury_movements%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_movement from treasury_movements
   where treasury_movements.id = p_movement_id for update;
  if not found then
    raise exception 'El movimiento no existe.';
  end if;
  if v_movement.status = 'ANULADO' then
    raise exception 'El movimiento % ya está anulado.', v_movement.full_number;
  end if;

  update treasury_movements
     set status = 'ANULADO',
         voided_at = now(),
         voided_reason = trim(p_reason)
   where treasury_movements.id = p_movement_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.work_order_items_stock_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    perform public.mover_stock_de_renglon(new.article_id, -new.quantity);
    return new;

  elsif tg_op = 'DELETE' then
    perform public.mover_stock_de_renglon(old.article_id, old.quantity);
    return old;

  else
    if old.article_id is distinct from new.article_id then
      perform public.mover_stock_de_renglon(old.article_id, old.quantity);
      perform public.mover_stock_de_renglon(new.article_id, -new.quantity);
    elsif old.quantity is distinct from new.quantity then
      perform public.mover_stock_de_renglon(new.article_id, old.quantity - new.quantity);
    end if;
    return new;
  end if;
end;
$function$
;

