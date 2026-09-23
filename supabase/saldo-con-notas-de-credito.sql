-- ===========================================================================
-- El saldo del cliente descuenta las notas de crédito
-- ===========================================================================
-- Migración sugerida: saldo_con_notas_de_credito
--
-- Generado a partir de las definiciones vivas (pg_get_functiondef) con un
-- reemplazo exacto, no transcrito a mano: son cuerpos largos y una diferencia
-- de una línea en save_receipt se paga con cobranzas rotas.
--
-- El cambio es siempre el mismo: donde el saldo era
--     total_amount - paid_amount
-- ahora es
--     total_amount - paid_amount - credited_amount
--
-- void_receipt quedó afuera a propósito: solo revierte cobros, y un cobro
-- revertido no tiene nada que ver con lo que acreditó una nota de crédito.
--
-- Falta todavía: report_customer_ranking y report_sales_by_period siguen
-- informando la venta bruta, sin descontar las NC. Es otro cambio, y de
-- reporte, no de saldo.

CREATE OR REPLACE FUNCTION public.report_customer_aging()
 RETURNS TABLE(customer_name text, a_vencer numeric, d1_30 numeric, d31_60 numeric, d61_90 numeric, d90_mas numeric, total numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with saldos as (
    select
      i.customer_name,
      i.total_amount - i.paid_amount - i.credited_amount as saldo,
      current_date - i.due_date as dias
    from invoices i
    where i.status = 'EMITIDA'
      and i.total_amount - i.paid_amount - i.credited_amount > 0
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
$function$;

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
    i.total_amount - i.paid_amount - i.credited_amount
  from invoices i
  where i.status = 'EMITIDA'
    and i.total_amount - i.paid_amount - i.credited_amount > 0
  order by i.customer_name, i.issue_date;
$function$;

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
        if v_amount > v_invoice.total_amount - v_invoice.paid_amount - v_invoice.credited_amount then
          raise exception 'La factura % debe $ % y estás imputando $ %.',
            v_invoice.full_number,
            v_invoice.total_amount - v_invoice.paid_amount - v_invoice.credited_amount, v_amount;
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
$function$;
