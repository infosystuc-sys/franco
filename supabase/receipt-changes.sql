-- ===========================================================================
-- Vuelto en cobranzas: cuando un cheque (u otro valor) cobra de más
-- ===========================================================================
-- Migración: receipt-changes
--
-- Hoy, cobrar de más siempre queda como saldo a favor automático
-- (receipts.on_account_amount, generated). Eso sigue existiendo tal cual: es
-- la opción por default y no requiere nada nuevo. Lo que se agrega es la
-- OTRA opción, cuando el cliente prefiere el vuelto en mano en vez de dejarlo
-- en cuenta corriente:
--
--   - Efectivo o transferencia: sale plata de verdad. Genera un EGRESO real
--     en Tesorería, igual que cualquier otro pago.
--   - Cheque propio: el taller no tiene una cartera de "cheques propios"
--     (documentos que el taller mismo libra) — es una decisión de diseño de
--     esta vuelta, no una limitación técnica. Se guarda solo como una
--     referencia de texto (número/banco/fecha a mano) para que quede
--     documentado en el recibo, sin modelar un objeto financiero nuevo.
--
-- El vuelto nunca puede superar lo que quedó a cuenta: como mucho se
-- devuelve todo el sobrante, y lo que no se devuelve sigue siendo saldo a
-- favor automático, sin ningún cambio de código para eso.
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de receipts.sql.


-- ===========================================================================
-- 1) Tipo y tabla
-- ===========================================================================
create type receipt_change_kind as enum ('MEDIO_PAGO', 'CHEQUE_PROPIO');

create table receipt_changes (
  id uuid primary key default gen_random_uuid(),
  -- Un solo vuelto por recibo: se decide una vez, al cargarlo.
  receipt_id uuid not null unique references receipts(id) on delete cascade,
  kind receipt_change_kind not null,
  amount numeric(14,2) not null check (amount > 0),

  -- MEDIO_PAGO: sale plata real, con su propio movimiento de Tesorería.
  payment_method_id uuid references payment_methods(id) on delete restrict,
  treasury_movement_id uuid references treasury_movements(id) on delete restrict,

  -- CHEQUE_PROPIO: solo una referencia de texto, no hay objeto financiero.
  note text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),

  constraint receipt_changes_coherente check (
    (kind = 'MEDIO_PAGO' and payment_method_id is not null and treasury_movement_id is not null and note is null)
    or (kind = 'CHEQUE_PROPIO' and payment_method_id is null and treasury_movement_id is null and note is not null)
  )
);

alter table receipt_changes enable row level security;
create policy "solo admin" on receipt_changes for select to authenticated using (is_admin());
-- Sin políticas de escritura: se escribe solo desde save_receipt/void_receipt.


-- ===========================================================================
-- 2) Crédito disponible del cliente: ahora también descuenta los vueltos
-- ===========================================================================
create or replace function public.customer_credit(p_customer_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
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
$$;


-- ===========================================================================
-- 3) Registrar un recibo: agrega el parámetro p_change (opcional)
-- ===========================================================================
create or replace function public.save_receipt(
  p_header jsonb,
  p_allocations jsonb,
  p_values jsonb,
  p_change jsonb default null
)
returns table (receipt_id uuid, receipt_full_number text)
language plpgsql
security definer
set search_path = public
as $$
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
  v_change_amount numeric(14,2);
  v_change_kind text;
  v_change_movement record;
  v_change_note text;
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

  -- Se puede cobrar de más (queda a cuenta), pero no imputar más de lo
  -- cobrado: eso sería cancelar facturas con plata que no entró.
  if v_applied > v_total then
    raise exception 'Estás imputando $ % pero el recibo cobra $ %.', v_applied, v_total;
  end if;

  -- ── El vuelto no puede superar lo que sobra: se valida temprano, con los
  -- mismos v_total/v_applied que van a definir on_account_amount.
  if p_change is not null then
    v_change_amount := round((p_change->>'amount')::numeric, 2);
    v_change_kind := p_change->>'kind';

    if v_change_amount is null or v_change_amount <= 0 then
      raise exception 'El importe del vuelto tiene que ser mayor a cero.';
    end if;
    if v_change_amount > (v_total - v_applied) then
      raise exception 'El vuelto ($ %) no puede ser mayor a lo que queda a cuenta ($ %).',
        v_change_amount, v_total - v_applied;
    end if;
    if v_change_kind not in ('MEDIO_PAGO', 'CHEQUE_PROPIO') then
      raise exception 'Tipo de vuelto desconocido.';
    end if;
    if v_change_kind = 'MEDIO_PAGO' and not exists (
      select 1 from payment_methods pm
       where pm.id = nullif(p_change->>'payment_method_id', '')::uuid
         and pm.active and pm.kind <> 'CARTERA_CHEQUES'
    ) then
      raise exception 'El medio del vuelto no existe, está inactivo, o es la cartera de cheques.';
    end if;
    if v_change_kind = 'CHEQUE_PROPIO' and coalesce(trim(p_change->>'note'), '') = '' then
      raise exception 'Indicá una referencia para el cheque propio del vuelto.';
    end if;
  end if;

  -- ── Facturas.
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
        -- El for update de arriba es lo que impide que dos recibos simultáneos
        -- cobren el mismo saldo dos veces.
        if v_amount > v_invoice.total_amount - v_invoice.paid_amount then
          raise exception 'La factura % debe $ % y estás imputando $ %.',
            v_invoice.full_number,
            v_invoice.total_amount - v_invoice.paid_amount, v_amount;
        end if;
      end;
    end loop;
  end if;

  -- ── Saldo a favor.
  select round(coalesce(sum((v->>'amount')::numeric), 0), 2)
    into v_credit_used
    from jsonb_array_elements(p_values) as v
   where v->>'kind' = 'SALDO_A_FAVOR';

  if v_credit_used > 0 and v_credit_used > public.customer_credit(v_customer.id) then
    raise exception '% tiene $ % a favor y estás usando $ %.',
      v_customer.name, public.customer_credit(v_customer.id), v_credit_used;
  end if;

  -- ── Retenciones: tienen que serlo de verdad.
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

  -- ── Medios de pago: existentes, activos y que no sean la cartera. La
  -- cartera se mueve con el cheque, no eligiéndola como medio.
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

  -- ── Cabecera.
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

  -- ── Imputaciones y su efecto en las facturas.
  insert into receipt_allocations (receipt_id, invoice_id, amount)
  select v_new_id, (a->>'invoice_id')::uuid, round((a->>'amount')::numeric, 2)
  from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as a;

  update invoices
     set paid_amount = invoices.paid_amount + al.amount
    from receipt_allocations al
   where al.receipt_id = v_new_id and al.invoice_id = invoices.id;

  -- ── Valores. Los cheques se crean uno por uno porque cada uno es una fila
  -- propia en la cartera; el resto entra de una.
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

    else -- SALDO_A_FAVOR
      insert into receipt_values (receipt_id, kind, amount)
      values (v_new_id, 'SALDO_A_FAVOR', round((v_value->>'amount')::numeric, 2));
    end if;
  end loop;

  -- ── Libro de caja. Solo lo que es plata de verdad: las retenciones y el
  -- saldo a favor no entran a ninguna caja.
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

  -- ── Vuelto: se entrega recién ahora que el recibo ya existe (el EGRESO
  -- queda descripto con su número de comprobante).
  if p_change is not null then
    if v_change_kind = 'MEDIO_PAGO' then
      select * into v_change_movement from public.post_treasury_movement(
        'EGRESO',
        coalesce((p_header->>'receipt_date')::date, current_date),
        null,
        'Vuelto cobranza ' || v_full_number || ' — ' || v_customer.name,
        v_customer.name,
        v_change_amount,
        jsonb_build_array(jsonb_build_object(
          'payment_method_id', (p_change->>'payment_method_id')::uuid,
          'amount', v_change_amount
        )),
        null
      );

      insert into receipt_changes (receipt_id, kind, amount, payment_method_id, treasury_movement_id, created_by)
      values (v_new_id, 'MEDIO_PAGO', v_change_amount, (p_change->>'payment_method_id')::uuid,
              v_change_movement.movement_id, auth.uid());

    else -- CHEQUE_PROPIO
      v_change_note := trim(p_change->>'note');
      insert into receipt_changes (receipt_id, kind, amount, note, created_by)
      values (v_new_id, 'CHEQUE_PROPIO', v_change_amount, v_change_note, auth.uid());
    end if;
  end if;

  return query select v_new_id, v_full_number;
end;
$$;

revoke all on function public.save_receipt(jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_receipt(jsonb, jsonb, jsonb, jsonb) to authenticated;


-- ===========================================================================
-- 4) Anular un recibo: revierte también el EGRESO del vuelto, si lo hubo
-- ===========================================================================
create or replace function public.void_receipt(
  p_receipt_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt receipts%rowtype;
  v_bad record;
  v_change receipt_changes%rowtype;
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

  -- Un cheque que ya se depositó o endosó salió de las manos del taller: no
  -- hay nada que deshacer, y forzarlo dejaría la cartera mintiendo.
  select c.number, c.bank_name, c.status into v_bad
    from receipt_values v
    join third_party_checks c on c.id = v.check_id
   where v.receipt_id = p_receipt_id and c.status <> 'EN_CARTERA'
   limit 1;

  if found then
    raise exception 'El cheque % de % ya está % y no se puede dar de baja. Resolvé el cheque antes de anular el recibo.',
      v_bad.number, v_bad.bank_name, lower(v_bad.status::text);
  end if;

  -- Facturas: vuelven a deber lo que este recibo había cancelado.
  update invoices
     set paid_amount = invoices.paid_amount - al.amount
    from receipt_allocations al
   where al.receipt_id = p_receipt_id and al.invoice_id = invoices.id;

  -- Cheques: salen de la cartera.
  update third_party_checks set status = 'ANULADO'
   where third_party_checks.id in (
     select v.check_id from receipt_values v
      where v.receipt_id = p_receipt_id and v.check_id is not null
   );

  -- Caja: el ingreso del cobro.
  if v_receipt.treasury_movement_id is not null then
    perform public.void_treasury_movement(
      v_receipt.treasury_movement_id,
      'Anulación del recibo ' || v_receipt.full_number || ': ' || trim(p_reason)
    );
  end if;

  -- Caja: el egreso del vuelto, si lo hubo.
  select * into v_change from receipt_changes where receipt_changes.receipt_id = p_receipt_id;
  if found and v_change.treasury_movement_id is not null then
    perform public.void_treasury_movement(
      v_change.treasury_movement_id,
      'Anulación del recibo ' || v_receipt.full_number || ': ' || trim(p_reason)
    );
  end if;

  update receipts
     set status = 'ANULADO', voided_at = now(), voided_reason = trim(p_reason)
   where receipts.id = p_receipt_id;
end;
$$;

revoke all on function public.void_receipt(uuid, text) from public, anon;
grant execute on function public.void_receipt(uuid, text) to authenticated;


comment on table receipt_changes is
  'Vuelto entregado cuando un recibo cobra de más y el cliente prefiere no '
  'dejarlo como saldo a favor. MEDIO_PAGO genera un EGRESO real en Tesorería; '
  'CHEQUE_PROPIO es solo una referencia de texto, sin objeto financiero propio.';
