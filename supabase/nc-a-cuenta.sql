-- ===========================================================================
-- La nota de crédito queda a cuenta; no se aplica sola ni anula recibos
-- ===========================================================================
-- Migración sugerida: nc_a_cuenta
--
-- Corrige el modelo que dejó notas-de-credito.sql, que estaba mal entendido.
--
-- ── Lo que estaba mal ──────────────────────────────────────────────────────
-- Se había supuesto que una nota de crédito se aplica sola contra la factura
-- que referencia, bajándole el saldo (invoices.credited_amount), y que si esa
-- factura se había cobrado de contado correspondía ANULAR el recibo.
--
-- Las dos cosas son incorrectas:
--
--   · Anular el recibo borra un hecho que ocurrió. El cliente pagó, la plata
--     entró y quedó registrada. Lo que corresponde no es borrar ese registro
--     sino, si hay que devolver la plata, registrar la salida.
--
--   · Aplicarla sola le saca a quien cobra la decisión de a qué comprobante va.
--     Una nota de crédito queda A CUENTA del cliente y se aplica después:
--     contra esa factura, contra otra, o en una cobranza. Es el mismo lugar
--     donde ya vive el saldo a favor.
--
-- ── Lo que hace ahora ──────────────────────────────────────────────────────
-- Cuenta corriente: la NC suma al crédito del cliente y no toca nada más.
-- Contado: se pregunta qué hace con la plata, porque ya entró. Puede
-- devolverse por un medio de pago —y eso registra un egreso de tesorería que
-- baja esa caja o ese banco— o quedar a cuenta igual que en cuenta corriente.
--
-- No hay datos que migrar: al aplicar esto no existe ninguna nota de crédito
-- ni ningún recibo emitido.

-- ---------------------------------------------------------------------------
-- 1. Sacar la aplicación automática
-- ---------------------------------------------------------------------------
drop trigger if exists credit_notes_recalcular_acreditado on credit_notes;
drop function if exists public._recalcular_acreditado();
drop function if exists public.cobros_reversibles_de_factura(uuid);

-- ---------------------------------------------------------------------------
-- 2. El saldo de la factura vuelve a ser total - cobrado
-- ---------------------------------------------------------------------------
-- Regenerado desde las definiciones vivas quitando " - credited_amount", no
-- transcrito: save_receipt tiene doscientas líneas.

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
    i.total_amount - i.paid_amount
  from invoices i
  where i.status = 'EMITIDA'
    and i.total_amount - i.paid_amount > 0
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
$function$;

-- ---------------------------------------------------------------------------
-- 3. Ventas del período y ranking, sin lo acreditado en el saldo
-- ---------------------------------------------------------------------------
-- La nota de crédito sigue restando de la venta —eso no cambió—, pero ya no
-- descuenta del saldo de la factura, que es lo que el cliente sigue debiendo
-- hasta que la nota se aplique.
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
    i.total_amount - i.paid_amount
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

  order by 1, 2;
$function$;

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
      i.total_amount - i.paid_amount as saldo
    from invoices i
    where i.status = 'EMITIDA'
      and i.issue_date between p_from and p_to

    union all

    -- Resta de la venta, pero no del saldo: mientras la nota no se aplique, la
    -- factura sigue debiendo lo suyo y el cliente tiene el crédito aparte.
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
-- 4. Fuera la columna
-- ---------------------------------------------------------------------------
alter table invoices drop column if exists credited_amount;

-- ---------------------------------------------------------------------------
-- 5. void_receipt vuelve a ser solo para un admin
-- ---------------------------------------------------------------------------
-- Se le había abierto el rol de servicio para que la nota de crédito pudiera
-- anular recibos. Ya no lo hace, así que el permiso sobra: un privilegio que
-- nadie usa es un privilegio que alguien va a usar mal.
create or replace function public.void_receipt(p_receipt_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
     set status = 'ANULADO',
         voided_at = now(),
         voided_reason = trim(p_reason)
   where receipts.id = p_receipt_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Qué hace la nota con la plata
-- ---------------------------------------------------------------------------
alter table credit_notes
  add column if not exists devuelve_fondos boolean not null default false,
  add column if not exists payment_method_id uuid references payment_methods(id),
  add column if not exists treasury_movement_id uuid references treasury_movements(id);

alter table credit_notes
  drop constraint if exists credit_notes_devolucion_con_medio;

alter table credit_notes
  add constraint credit_notes_devolucion_con_medio check (
    (devuelve_fondos and payment_method_id is not null)
    or (not devuelve_fondos and payment_method_id is null)
  );

comment on column credit_notes.devuelve_fondos is
  'Si la nota devuelve la plata por un medio de pago. Solo tiene sentido '
  'cuando la factura de origen estaba cobrada; si no, queda a cuenta.';

-- ---------------------------------------------------------------------------
-- 7. El crédito del cliente incluye las notas a cuenta
-- ---------------------------------------------------------------------------
-- Es la bolsa que ya existía para el saldo a favor, y donde las cobranzas lo
-- aplican con el valor SALDO_A_FAVOR. La nota de crédito entra ahí: no hace
-- falta un mecanismo nuevo ni llevar cuenta nota por nota, porque la bolsa ya
-- se lleva por neto —lo que entró menos lo que se usó—.
--
-- Las que devuelven la plata no entran: esa ya salió por la caja.
create or replace function public.customer_credit(p_customer_id uuid)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce((
    select sum(r.on_account_amount)
      from receipts r
     where r.customer_id = p_customer_id and r.status = 'REGISTRADO'
  ), 0) + coalesce((
    select sum(nc.total_amount)
      from credit_notes nc
     where nc.customer_id = p_customer_id
       and nc.status = 'EMITIDA'
       and not nc.devuelve_fondos
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
$function$;

-- ---------------------------------------------------------------------------
-- 8. Emitir, con la decisión sobre la plata
-- ---------------------------------------------------------------------------
create or replace function public.emitir_nota_credito(
  p_invoice_id uuid,
  p_items jsonb,
  p_cancela_total boolean,
  p_motivo text default null,
  p_devuelve_fondos boolean default false,
  p_payment_method_id uuid default null
)
returns table(credit_note_id uuid, credit_note_full_number text, credit_note_letter invoice_type)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_invoice invoices%rowtype;
  v_number int;
  v_net numeric(14,2);
  v_vat numeric(14,2);
  v_acreditado numeric(14,2);
  v_new_id uuid;
  v_full_number text;
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La nota de crédito no tiene renglones cargados.';
  end if;

  select * into v_invoice from invoices where invoices.id = p_invoice_id for update;
  if not found then
    raise exception 'La factura de referencia no existe.';
  end if;

  if v_invoice.invoice_type = 'X' then
    raise exception 'La serie interna X no lleva nota de crédito: se anula.';
  end if;

  if v_invoice.status <> 'EMITIDA' then
    raise exception 'La factura % está %: solo se le hace nota de crédito a una emitida.',
      v_invoice.full_number, v_invoice.status;
  end if;

  if v_invoice.cae is null then
    raise exception 'La factura % todavía no tiene CAE.', v_invoice.full_number;
  end if;

  -- Devolver plata solo tiene sentido si entró. Una factura en cuenta
  -- corriente sin cobrar no tiene nada que devolver: la nota queda a cuenta.
  if p_devuelve_fondos and v_invoice.paid_amount <= 0 then
    raise exception
      'La factura % no está cobrada, así que no hay plata para devolver. La nota queda a cuenta del cliente.',
      v_invoice.full_number;
  end if;

  if p_devuelve_fondos and p_payment_method_id is null then
    raise exception 'Elegí por qué medio se devuelve la plata.';
  end if;

  select round(coalesce(sum(
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  ), 0), 2)
  into v_net
  from jsonb_array_elements(p_items) as item;

  if v_net <= 0 then
    raise exception 'El total de la nota de crédito tiene que ser mayor a cero.';
  end if;

  v_vat := case when v_invoice.invoice_type = 'C' then 0 else round(v_net * 0.21, 2) end;

  -- No se puede acreditar más de lo que la factura vale, aunque el crédito no
  -- se aplique contra ella: seguiría siendo una nota por algo que no se vendió.
  select coalesce(sum(nc.total_amount), 0) into v_acreditado
    from credit_notes nc
   where nc.invoice_id = p_invoice_id and nc.status <> 'ANULADA';

  if v_net + v_vat + v_acreditado > v_invoice.total_amount then
    raise exception
      'La factura % admite hasta $ % de nota de crédito y estás emitiendo $ %.',
      v_invoice.full_number, v_invoice.total_amount - v_acreditado, v_net + v_vat;
  end if;

  insert into credit_note_sequences (invoice_type, sales_point, last_number)
  values (v_invoice.invoice_type, v_invoice.sales_point, 1)
  on conflict (invoice_type, sales_point)
    do update set last_number = credit_note_sequences.last_number + 1
  returning credit_note_sequences.last_number into v_number;

  insert into credit_notes (
    invoice_id, invoice_type, sales_point, number, status, cancela_total,
    devuelve_fondos, payment_method_id,
    customer_id, customer_name, customer_legal_name, customer_tax_id,
    customer_tax_condition, customer_address,
    issuer_legal_name, issuer_tax_id, issuer_tax_condition, issuer_address,
    issuer_gross_income, issuer_activity_start_date,
    issue_date, net_amount, vat_amount, total_amount, motivo, created_by
  )
  values (
    v_invoice.id, v_invoice.invoice_type, v_invoice.sales_point, v_number,
    'PENDIENTE_CAE', coalesce(p_cancela_total, false),
    coalesce(p_devuelve_fondos, false), p_payment_method_id,
    v_invoice.customer_id, v_invoice.customer_name, v_invoice.customer_legal_name,
    v_invoice.customer_tax_id, v_invoice.customer_tax_condition, v_invoice.customer_address,
    v_invoice.issuer_legal_name, v_invoice.issuer_tax_id, v_invoice.issuer_tax_condition,
    v_invoice.issuer_address, v_invoice.issuer_gross_income, v_invoice.issuer_activity_start_date,
    current_date, v_net, v_vat, v_net + v_vat,
    nullif(trim(coalesce(p_motivo, '')), ''), auth.uid()
  )
  returning credit_notes.id, credit_notes.full_number into v_new_id, v_full_number;

  insert into credit_note_items (credit_note_id, article_id, code, description, quantity, unit_price, subtotal, line_number)
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

  return query select v_new_id, v_full_number, v_invoice.invoice_type;
end;
$function$;

drop function if exists public.emitir_nota_credito(uuid, jsonb, boolean, text);
revoke all on function public.emitir_nota_credito(uuid, jsonb, boolean, text, boolean, uuid) from public, anon;
grant execute on function public.emitir_nota_credito(uuid, jsonb, boolean, text, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. El CAE, y recién ahí la plata
-- ---------------------------------------------------------------------------
create or replace function public.confirmar_cae_nc(
  p_credit_note_id uuid,
  p_cae text,
  p_cae_due_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nc credit_notes%rowtype;
  v_cae text := trim(coalesce(p_cae, ''));
  v_movimiento uuid;
begin
  if not (is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'No autorizado.';
  end if;

  if v_cae !~ '^\d{14}$' then
    raise exception 'El CAE tiene que ser de 14 dígitos.';
  end if;
  if p_cae_due_date is null then
    raise exception 'El CAE tiene que venir con su fecha de vencimiento.';
  end if;

  select * into v_nc from credit_notes where id = p_credit_note_id for update;
  if not found then
    raise exception 'La nota de crédito no existe.';
  end if;
  if v_nc.status <> 'PENDIENTE_CAE' then
    raise exception 'La nota de crédito no está esperando un CAE: está %.', v_nc.status;
  end if;

  -- La plata sale recién con el CAE otorgado. Antes, ARCA no conoce la nota y
  -- puede terminar rechazándola: devolver por algo que todavía no existe
  -- dejaría la caja corta y sin comprobante que lo explique.
  if v_nc.devuelve_fondos then
    select movement_id into v_movimiento
      from public.post_treasury_movement(
        'EGRESO'::treasury_movement_type,
        current_date,
        null,
        'Devolución por nota de crédito ' || v_nc.full_number,
        v_nc.customer_name,
        v_nc.total_amount,
        jsonb_build_array(jsonb_build_object(
          'payment_method_id', v_nc.payment_method_id,
          'amount', v_nc.total_amount
        )),
        null
      );
  end if;

  update credit_notes
     set status = 'EMITIDA', cae = v_cae, cae_due_date = p_cae_due_date,
         cae_rechazo = null, cae_rechazado_at = null,
         treasury_movement_id = v_movimiento
   where id = p_credit_note_id;
end;
$$;

revoke all on function public.confirmar_cae_nc(uuid, text, date) from public, anon;
grant execute on function public.confirmar_cae_nc(uuid, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_name = 'invoices' and column_name = 'credited_amount') as columna_vieja,
  (select count(*) from information_schema.columns
    where table_name = 'credit_notes'
      and column_name in ('devuelve_fondos', 'payment_method_id', 'treasury_movement_id')) as columnas_nuevas,
  (select prosrc like '%credit_notes%' from pg_proc
    where oid = 'public.customer_credit(uuid)'::regprocedure) as credito_incluye_notas,
  (select prosrc not like '%service_role%' from pg_proc
    where oid = 'public.void_receipt(uuid,text)'::regprocedure) as void_receipt_solo_admin;
