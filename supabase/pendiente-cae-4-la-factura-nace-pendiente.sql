-- ===========================================================================
-- La factura electrónica nace PENDIENTE_CAE, y la app pasa al punto de venta 3
-- ===========================================================================
-- Migración sugerida: la_factura_nace_pendiente
--
-- Cierra la fase 2 del plan de ARCA. Tres cambios, y nada más:
--
--   1. _create_invoice(): la serie electrónica nace en PENDIENTE_CAE y sin
--      CAE. Se va el CAE simulado.
--   2. issue_invoice(): "esta OT ya tiene factura" pasa a contar también las
--      pendientes.
--   3. company_settings.sales_point: del 1 al 3.
--
-- El cuerpo de _create_invoice() está copiado de lo que está corriendo hoy
-- (pg_get_functiondef, 22/09) con esos cambios y ningún otro: las dos series,
-- p_condicion, el vínculo con el remito y el cálculo de IVA quedan iguales.
--
-- Sobre el punto 3: hasta hoy la app numeraba sobre el PV 1, el mismo que usa
-- el sistema viejo, que allá va por la factura A 2122. Si una factura naciera
-- pendiente sobre el PV 1, le pediría a ARCA el número 1, que ARCA ya otorgó
-- hace años, y el rechazo sería inevitable. El PV 3 está habilitado y en 0/0.
--
-- Se puede hacer ahora sin arrastrar nada: en toda su historia la app emitió
-- una sola factura y es de la serie interna X. Las secuencias A y B están en
-- cero, así que el primer número del PV 3 va a ser el 1, que es exactamente
-- lo que ARCA espera.
--
-- Después de esto la app NO puede terminar una factura electrónica: nace
-- pendiente y nada la pasa a emitida todavía. Eso llega con la acción `emitir`
-- de la Edge Function (fase 3). La serie interna X sigue funcionando igual.

-- ---------------------------------------------------------------------------
-- 1. _create_invoice(): nacer pendiente, sin CAE inventado
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._create_invoice(
  p_work_order_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_notes text,
  p_emit_remito boolean,
  p_link_remito_id uuid DEFAULT NULL::uuid,
  p_invoice_type invoice_type DEFAULT 'X'::invoice_type,
  p_condicion text DEFAULT NULL::text,
  p_due_date date DEFAULT NULL::date
)
 RETURNS TABLE(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer customers%rowtype;
  v_company company_settings%rowtype;
  v_type invoice_type;
  v_sales_point int;
  v_number int;
  v_net numeric(14,2);
  v_vat numeric(14,2);
  v_vence date;
  v_terms int;
  v_status invoice_status;
  v_new_id uuid;
  v_full_number text;
  v_remito_id uuid;
  v_remito_number int;
  v_remito_full_number text;
  v_link_remito remitos%rowtype;
begin
  if p_condicion is null or p_condicion not in ('CONTADO', 'CUENTA_CORRIENTE') then
    raise exception 'Elegí la condición de venta: contado o cuenta corriente.';
  end if;

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

  v_type := p_invoice_type;

  if v_company.tax_condition in ('MONOTRIBUTO', 'EXENTO') and v_type in ('A', 'B') then
    raise exception 'El taller es % y no puede emitir factura %: corresponde C.',
      v_company.tax_condition, v_type;
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

  v_sales_point := case when v_type = 'X'
    then v_company.sales_point_internal
    else v_company.sales_point end;

  select round(coalesce(sum(
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  ), 0), 2)
  into v_net
  from jsonb_array_elements(p_items) as item;

  if v_net <= 0 then
    raise exception 'El total de la factura tiene que ser mayor a cero.';
  end if;

  v_vat := case when v_type = 'C' then 0 else round(v_net * 0.21, 2) end;

  -- Contado vence el mismo día, sin importar qué venga por parámetro.
  if p_condicion = 'CONTADO' then
    v_vence := current_date;
  else
    v_vence := coalesce(p_due_date, current_date + 7);
    if v_vence < current_date then
      raise exception 'El vencimiento no puede ser anterior a la fecha de emisión.';
    end if;
  end if;

  v_terms := v_vence - current_date;

  -- Acá estaba el CAE simulado. La electrónica ahora nace esperando el de
  -- ARCA; la interna no espera nada porque no es fiscal.
  v_status := case when v_type = 'X' then 'EMITIDA' else 'PENDIENTE_CAE' end;

  insert into invoice_sequences (invoice_type, sales_point, last_number)
  values (v_type, v_sales_point, 1)
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
    cae, cae_due_date, cae_simulated,
    notes, created_by
  )
  values (
    v_type, v_sales_point, v_number, v_status,
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
    current_date, v_vence, v_terms,
    v_net, v_vat, v_net + v_vat,
    null, null, false,
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

-- ---------------------------------------------------------------------------
-- 2. issue_invoice(): una OT con factura pendiente tampoco se vuelve a facturar
-- ---------------------------------------------------------------------------
-- El índice invoices_una_activa_por_ot ya lo impide desde la base, pero ahí el
-- error sale como violación de índice único, ilegible. Esta es la que da el
-- mensaje en castellano, y tiene que mirar lo mismo que el índice.
CREATE OR REPLACE FUNCTION public.issue_invoice(
  p_work_order_id uuid,
  p_items jsonb,
  p_notes text DEFAULT NULL::text,
  p_emit_remito boolean DEFAULT false,
  p_invoice_type invoice_type DEFAULT 'X'::invoice_type,
  p_condicion text DEFAULT NULL::text,
  p_due_date date DEFAULT NULL::date
)
 RETURNS TABLE(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_wo work_orders%rowtype;
  v_existente invoices%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_wo from work_orders where work_orders.id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;

  select * into v_existente from invoices
  where invoices.work_order_id = p_work_order_id and invoices.status <> 'ANULADA'
  limit 1;

  if found then
    if v_existente.status = 'PENDIENTE_CAE' then
      raise exception 'La orden % ya tiene la factura % esperando el CAE de ARCA.',
        v_wo.number, v_existente.full_number;
    else
      raise exception 'La orden % ya tiene una factura emitida.', v_wo.number;
    end if;
  end if;

  return query
  select * from public._create_invoice(
    p_work_order_id, v_wo.customer_id, p_items, p_notes, p_emit_remito,
    null::uuid, p_invoice_type, p_condicion, p_due_date
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. El punto de venta de la app
-- ---------------------------------------------------------------------------
update company_settings set sales_point = 3 where id = true;

-- Las secuencias del PV 1 quedaron en cero y sin una sola factura detrás: son
-- de cuando la app numeraba sobre el punto de venta del sistema viejo. Si se
-- dejaran, Configuración mostraría cuatro series donde hay dos.
delete from invoice_sequences
where sales_point = 1
  and last_number = 0
  and not exists (
    select 1 from invoices
    where invoices.invoice_type = invoice_sequences.invoice_type
      and invoices.sales_point = invoice_sequences.sales_point
  );

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select sales_point, sales_point_internal from company_settings where id;
select * from numeracion_facturas();
