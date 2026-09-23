-- ===========================================================================
-- Imputación de comprobantes — ventas
-- ===========================================================================
-- Migración sugerida: imputacion_ventas
--
-- Hasta ahora la imputación se decidía una sola vez, al registrar la cobranza,
-- y no había forma de corregirla. Si un recibo se aplicaba a la factura
-- equivocada, la única salida era anularlo y rehacerlo —lo que además borra un
-- cobro que ocurrió— y si quedaba plata a cuenta se quedaba ahí hasta la
-- próxima cobranza. Las notas de crédito directamente no tenían dónde
-- aplicarse: engrosaban el crédito del cliente y nada más.
--
-- ── Las dos columnas ───────────────────────────────────────────────────────
-- Imputar es aparear dos listas: lo que el cliente tiene a favor —recibos con
-- plata a cuenta, notas de crédito sin aplicar— contra lo que debe. Este
-- módulo permite rehacer ese apareo cuando quedó mal, sin tocar los
-- comprobantes en sí: el recibo sigue diciendo que entraron $ 100.000, lo que
-- cambia es contra qué factura se imputaron.
--
-- ── Vuelve credited_amount ─────────────────────────────────────────────────
-- La nota de crédito necesita bajar el saldo de la factura a la que se aplica,
-- y eso no puede ser paid_amount: esa columna es plata que entró y la miran el
-- arqueo y los reportes de cobranza. La diferencia con la versión anterior de
-- esta columna es de fondo: antes la movía un disparador en cuanto la nota
-- existía, y por eso estaba mal. Ahora solo la mueve una imputación explícita.

-- ---------------------------------------------------------------------------
-- 1. Lo que una nota de crédito canceló de cada factura
-- ---------------------------------------------------------------------------
create table if not exists credit_note_allocations (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references credit_notes(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (credit_note_id, invoice_id)
);

create index if not exists credit_note_allocations_nc_idx
  on credit_note_allocations (credit_note_id);
create index if not exists credit_note_allocations_invoice_idx
  on credit_note_allocations (invoice_id);

alter table credit_note_allocations enable row level security;

drop policy if exists "solo admin" on credit_note_allocations;
drop policy if exists "contador lee" on credit_note_allocations;
create policy "solo admin" on credit_note_allocations for select to authenticated using (is_admin());
create policy "contador lee" on credit_note_allocations for select using (is_contador());

alter table credit_notes
  add column if not exists applied_amount numeric(14,2) not null default 0
    check (applied_amount >= 0);

comment on column credit_notes.applied_amount is
  'Cuánto de esta nota ya se imputó a facturas. Lo que falta sigue a cuenta '
  'del cliente.';

alter table invoices
  add column if not exists credited_amount numeric(14,2) not null default 0
    check (credited_amount >= 0);

comment on column invoices.credited_amount is
  'Cuánto de esta factura cancelaron notas de crédito imputadas. Solo lo mueve '
  'una imputación explícita: una nota emitida y sin imputar no lo toca.';

-- Los dos totales salen de las imputaciones que existen, no de quien imputa:
-- así da igual por qué camino se llegó, los números cierran.
create or replace function public._recalcular_imputado_nc()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_nc uuid := coalesce(new.credit_note_id, old.credit_note_id);
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update credit_notes nc
     set applied_amount = coalesce((
       select sum(a.amount) from credit_note_allocations a
        where a.credit_note_id = v_nc
     ), 0)
   where nc.id = v_nc;

  update invoices i
     set credited_amount = coalesce((
       select sum(a.amount) from credit_note_allocations a
        where a.invoice_id = v_invoice
     ), 0)
   where i.id = v_invoice;

  return null;
end;
$$;

drop trigger if exists credit_note_allocations_recalcular on credit_note_allocations;
create trigger credit_note_allocations_recalcular
after insert or update or delete on credit_note_allocations
for each row execute function public._recalcular_imputado_nc();

-- ---------------------------------------------------------------------------
-- 2. El crédito del cliente descuenta lo ya imputado
-- ---------------------------------------------------------------------------
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
    select sum(nc.total_amount - nc.applied_amount)
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
-- 3. El saldo de la factura vuelve a descontar lo acreditado
-- ---------------------------------------------------------------------------
-- Regenerado desde las definiciones vivas, no transcrito.

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

CREATE OR REPLACE FUNCTION public.report_customer_ranking(p_from date, p_to date)
 RETURNS TABLE(customer_name text, customer_tax_id text, comprobantes bigint, net_amount numeric, total_amount numeric, balance numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with movimientos as (
    select
      i.customer_name,
      i.customer_tax_id,
      i.net_amount,
      i.total_amount,
      i.total_amount - i.paid_amount - i.credited_amount as saldo
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
    i.total_amount - i.paid_amount - i.credited_amount
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

-- ---------------------------------------------------------------------------
-- 4. El historial
-- ---------------------------------------------------------------------------
-- Es plata que se mueve entre comprobantes sin que cambie ningún importe, así
-- que sin registro una diferencia es imposible de reconstruir: los totales
-- siguen cerrando y nadie sabe qué se tocó.
create table if not exists imputacion_log (
  id uuid primary key default gen_random_uuid(),
  circuito text not null check (circuito in ('VENTAS', 'COMPRAS')),
  /** El cliente o el proveedor cuya cuenta se reimputó. */
  parte_id uuid not null,
  parte_nombre text not null,
  /** Cómo estaba antes y cómo quedó, comprobante por comprobante. */
  antes jsonb not null,
  despues jsonb not null,
  motivo text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists imputacion_log_parte_idx on imputacion_log (parte_id, created_at desc);

alter table imputacion_log enable row level security;

drop policy if exists "solo admin" on imputacion_log;
drop policy if exists "contador lee" on imputacion_log;
create policy "solo admin" on imputacion_log for select to authenticated using (is_admin());
create policy "contador lee" on imputacion_log for select using (is_contador());

-- ---------------------------------------------------------------------------
-- 5. Reimputar la cuenta de un cliente
-- ---------------------------------------------------------------------------
-- Recibe el cuadro completo, no un delta: todas las imputaciones de ese
-- cliente quedan como dice el pedido. Es más simple de razonar y hace que la
-- pantalla no tenga que calcular diferencias —manda lo que se ve— y de paso
-- evita que dos personas imputando a la vez sumen dos veces lo mismo.
--
-- p_recibos:  [{ receipt_id, invoice_id, amount }, ...]
-- p_notas:    [{ credit_note_id, invoice_id, amount }, ...]
create or replace function public.imputar_ventas(
  p_customer_id uuid,
  p_recibos jsonb,
  p_notas jsonb,
  p_motivo text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_customer customers%rowtype;
  v_antes jsonb;
  v_despues jsonb;
  v_mal record;
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_customer from customers where id = p_customer_id;
  if not found then
    raise exception 'El cliente no existe.';
  end if;

  -- La foto de cómo estaba, para el historial.
  select jsonb_build_object(
    'recibos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'receipt', r.full_number, 'invoice', i.full_number, 'amount', al.amount))
        from receipt_allocations al
        join receipts r on r.id = al.receipt_id
        join invoices i on i.id = al.invoice_id
       where r.customer_id = p_customer_id and r.status = 'REGISTRADO'
    ), '[]'::jsonb),
    'notas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nota', nc.full_number, 'invoice', i.full_number, 'amount', a.amount))
        from credit_note_allocations a
        join credit_notes nc on nc.id = a.credit_note_id
        join invoices i on i.id = a.invoice_id
       where nc.customer_id = p_customer_id
    ), '[]'::jsonb)
  ) into v_antes;

  -- ── Borrar lo que había y poner lo que viene ────────────────────────────
  delete from receipt_allocations al
   using receipts r
   where al.receipt_id = r.id
     and r.customer_id = p_customer_id
     and r.status = 'REGISTRADO';

  delete from credit_note_allocations a
   using credit_notes nc
   where a.credit_note_id = nc.id
     and nc.customer_id = p_customer_id;

  insert into receipt_allocations (receipt_id, invoice_id, amount)
  select
    (x->>'receipt_id')::uuid,
    (x->>'invoice_id')::uuid,
    round((x->>'amount')::numeric, 2)
  from jsonb_array_elements(coalesce(p_recibos, '[]'::jsonb)) as x
  where round((x->>'amount')::numeric, 2) > 0;

  insert into credit_note_allocations (credit_note_id, invoice_id, amount)
  select
    (x->>'credit_note_id')::uuid,
    (x->>'invoice_id')::uuid,
    round((x->>'amount')::numeric, 2)
  from jsonb_array_elements(coalesce(p_notas, '[]'::jsonb)) as x
  where round((x->>'amount')::numeric, 2) > 0;

  -- ── Recalcular lo cobrado de cada factura del cliente ───────────────────
  -- credited_amount y applied_amount los dejó al día el disparador; paid_amount
  -- se recalcula acá porque las imputaciones de recibos no tienen uno.
  update invoices i
     set paid_amount = coalesce((
       select sum(al.amount)
         from receipt_allocations al
         join receipts r on r.id = al.receipt_id
        where al.invoice_id = i.id and r.status = 'REGISTRADO'
     ), 0)
   where i.customer_id = p_customer_id;

  update receipts r
     set applied_amount = coalesce((
       select sum(al.amount) from receipt_allocations al where al.receipt_id = r.id
     ), 0)
   where r.customer_id = p_customer_id and r.status = 'REGISTRADO';

  -- ── Que nada haya quedado en falso ──────────────────────────────────────
  -- Se valida DESPUÉS de escribir y adentro de la transacción: si algo no
  -- cierra, el raise revierte todo y la cuenta queda como estaba.
  select r.full_number, r.total_amount, r.applied_amount into v_mal
    from receipts r
   where r.customer_id = p_customer_id
     and r.status = 'REGISTRADO'
     and r.applied_amount > r.total_amount
   limit 1;
  if found then
    raise exception 'El recibo % cobra $ % y estás imputando $ %.',
      v_mal.full_number, v_mal.total_amount, v_mal.applied_amount;
  end if;

  select nc.full_number, nc.total_amount, nc.applied_amount into v_mal
    from credit_notes nc
   where nc.customer_id = p_customer_id and nc.applied_amount > nc.total_amount
   limit 1;
  if found then
    raise exception 'La nota de crédito % es de $ % y estás imputando $ %.',
      v_mal.full_number, v_mal.total_amount, v_mal.applied_amount;
  end if;

  select i.full_number, i.total_amount, i.paid_amount + i.credited_amount as imputado
    into v_mal
    from invoices i
   where i.customer_id = p_customer_id
     and i.paid_amount + i.credited_amount > i.total_amount
   limit 1;
  if found then
    raise exception 'La factura % es de $ % y le estás imputando $ %.',
      v_mal.full_number, v_mal.total_amount, v_mal.imputado;
  end if;

  if exists (
    select 1 from credit_note_allocations a
    join credit_notes nc on nc.id = a.credit_note_id
    where nc.customer_id = p_customer_id and nc.status <> 'EMITIDA'
  ) then
    raise exception 'Una nota de crédito sin CAE no se puede imputar: ARCA todavía no la conoce.';
  end if;

  if exists (
    select 1 from credit_note_allocations a
    join credit_notes nc on nc.id = a.credit_note_id
    where nc.customer_id = p_customer_id and nc.devuelve_fondos
  ) then
    raise exception 'Una nota de crédito que devolvió la plata no se puede imputar: ya se cobró en efectivo.';
  end if;

  -- Todo lo imputado tiene que ser del mismo cliente. Si no, se estaría
  -- cancelando la deuda de uno con la plata de otro.
  if exists (
    select 1 from receipt_allocations al
    join receipts r on r.id = al.receipt_id
    join invoices i on i.id = al.invoice_id
    where r.customer_id = p_customer_id and i.customer_id <> p_customer_id
  ) or exists (
    select 1 from credit_note_allocations a
    join credit_notes nc on nc.id = a.credit_note_id
    join invoices i on i.id = a.invoice_id
    where nc.customer_id = p_customer_id and i.customer_id <> p_customer_id
  ) then
    raise exception 'Hay una imputación contra una factura de otro cliente.';
  end if;

  select jsonb_build_object(
    'recibos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'receipt', r.full_number, 'invoice', i.full_number, 'amount', al.amount))
        from receipt_allocations al
        join receipts r on r.id = al.receipt_id
        join invoices i on i.id = al.invoice_id
       where r.customer_id = p_customer_id and r.status = 'REGISTRADO'
    ), '[]'::jsonb),
    'notas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nota', nc.full_number, 'invoice', i.full_number, 'amount', a.amount))
        from credit_note_allocations a
        join credit_notes nc on nc.id = a.credit_note_id
        join invoices i on i.id = a.invoice_id
       where nc.customer_id = p_customer_id
    ), '[]'::jsonb)
  ) into v_despues;

  insert into imputacion_log (circuito, parte_id, parte_nombre, antes, despues, motivo, created_by)
  values ('VENTAS', p_customer_id, v_customer.name, v_antes, v_despues,
          nullif(trim(coalesce(p_motivo, '')), ''), auth.uid());
end;
$function$;

revoke all on function public.imputar_ventas(uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.imputar_ventas(uuid, jsonb, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Lo que la pantalla necesita ver de un cliente
-- ---------------------------------------------------------------------------
create or replace function public.cuenta_del_cliente(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select jsonb_build_object(
    'facturas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'full_number', i.invoice_type::text || ' ' || i.full_number,
        'issue_date', i.issue_date,
        'due_date', i.due_date,
        'total_amount', i.total_amount,
        'paid_amount', i.paid_amount,
        'credited_amount', i.credited_amount
      ) order by i.issue_date, i.number)
      from invoices i
      where i.customer_id = p_customer_id and i.status = 'EMITIDA'
    ), '[]'::jsonb),
    'recibos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'full_number', r.full_number,
        'receipt_date', r.receipt_date,
        'total_amount', r.total_amount,
        'applied_amount', r.applied_amount,
        'allocations', coalesce((
          select jsonb_agg(jsonb_build_object('invoice_id', al.invoice_id, 'amount', al.amount))
            from receipt_allocations al where al.receipt_id = r.id
        ), '[]'::jsonb)
      ) order by r.receipt_date, r.number)
      from receipts r
      where r.customer_id = p_customer_id and r.status = 'REGISTRADO'
    ), '[]'::jsonb),
    'notas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', nc.id,
        'full_number', 'NC ' || nc.invoice_type::text || ' ' || nc.full_number,
        'issue_date', nc.issue_date,
        'total_amount', nc.total_amount,
        'applied_amount', nc.applied_amount,
        'allocations', coalesce((
          select jsonb_agg(jsonb_build_object('invoice_id', a.invoice_id, 'amount', a.amount))
            from credit_note_allocations a where a.credit_note_id = nc.id
        ), '[]'::jsonb)
      ) order by nc.issue_date, nc.number)
      from credit_notes nc
      where nc.customer_id = p_customer_id
        and nc.status = 'EMITIDA'
        and not nc.devuelve_fondos
    ), '[]'::jsonb)
  );
$function$;

grant execute on function public.cuenta_del_cliente(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
    where table_name in ('credit_note_allocations', 'imputacion_log')) as tablas,
  (select count(*) from information_schema.columns
    where (table_name = 'invoices' and column_name = 'credited_amount')
       or (table_name = 'credit_notes' and column_name = 'applied_amount')) as columnas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('imputar_ventas', 'cuenta_del_cliente')) as funciones;
