-- DieselPro ERP — cobranzas
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de invoicing.sql,
-- treasury-checks.sql y purchase-catalogs.sql (de ahí sale tax_rates).
-- Este archivo queda además como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-23-cobranzas-design.md
--
-- Modelo:
--   El recibo tiene IMPUTACIONES (qué factura y cuánto) y VALORES (con qué se
--   cobró). El pago parcial y el pago de varias facturas son la misma tabla
--   vista de dos maneras: un importe menor al saldo es parcial, varias filas
--   son varias facturas.
--
--   No todos los valores son plata. Una retención cancela la factura pero no
--   entra a la caja: es un crédito fiscal. Tratarla como cobro haría que el
--   saldo del banco diga de más, y ese error no se nota hasta conciliar.


-- ===========================================================================
-- 1) Los cheques pueden anularse
-- ===========================================================================
-- Al anular un recibo hay que dar de baja el cheque que generó. Va primero y
-- en su propia sentencia: un valor nuevo de enum no se puede USAR en la misma
-- transacción en que se agrega. Acá solo aparece dentro del cuerpo de una
-- función, que se resuelve en tiempo de ejecución, así que no hay problema.
alter type check_status add value if not exists 'ANULADO';


-- ===========================================================================
-- 2) Tipos
-- ===========================================================================
create type receipt_status as enum ('REGISTRADO', 'ANULADO');

-- Con qué se cobró. Los dos últimos NO mueven caja:
--   RETENCION      el cliente la retuvo; es crédito fiscal, no plata.
--   SALDO_A_FAVOR  crédito que el cliente ya tenía por un cobro anterior.
create type receipt_value_kind as enum (
  'MEDIO_PAGO', 'CHEQUE', 'RETENCION', 'SALDO_A_FAVOR'
);


-- ===========================================================================
-- 3) Numeración
-- ===========================================================================
create table receipt_sequence (
  id boolean primary key default true check (id),
  last_number int not null default 0 check (last_number >= 0)
);
insert into receipt_sequence (id) values (true) on conflict (id) do nothing;

alter table receipt_sequence enable row level security;
create policy "solo admin" on receipt_sequence for select to authenticated using (is_admin());


-- ===========================================================================
-- 4) El recibo
-- ===========================================================================
create table receipts (
  id uuid primary key default gen_random_uuid(),

  number int not null unique check (number > 0),
  full_number text not null,
  status receipt_status not null default 'REGISTRADO',

  customer_id uuid not null references customers(id) on delete restrict,
  -- Copia congelada: el recibo no cambia si después se edita el padrón.
  customer_name text not null,

  receipt_date date not null default current_date,

  -- Suma de los valores y suma de las imputaciones. Lo que sobra queda a
  -- cuenta del cliente.
  total_amount numeric(14,2) not null check (total_amount > 0),
  applied_amount numeric(14,2) not null default 0 check (applied_amount >= 0),
  on_account_amount numeric(14,2) generated always as (total_amount - applied_amount) stored,

  notes text,

  -- El ingreso que generó en el libro de caja. Null si se cobró todo con
  -- retenciones y saldo a favor: no entró un peso.
  treasury_movement_id uuid references treasury_movements(id) on delete restrict,

  voided_at timestamptz,
  voided_reason text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint receipts_imputado_no_supera_cobrado check (applied_amount <= total_amount),

  constraint receipts_anulado_con_motivo check (
    (status = 'ANULADO' and voided_at is not null and voided_reason is not null)
    or (status = 'REGISTRADO' and voided_at is null and voided_reason is null)
  )
);

create index receipts_customer_idx on receipts (customer_id);
create index receipts_date_idx on receipts (receipt_date desc);

create trigger receipts_set_updated_at
before update on receipts
for each row execute function set_updated_at();


-- ===========================================================================
-- 5) Imputaciones
-- ===========================================================================
create table receipt_allocations (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references receipts(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  -- Una factura no puede aparecer dos veces en el mismo recibo: sería la
  -- misma imputación partida, y confunde al leer el comprobante.
  unique (receipt_id, invoice_id)
);

create index receipt_allocations_invoice_idx on receipt_allocations (invoice_id);


-- ===========================================================================
-- 6) Valores
-- ===========================================================================
create table receipt_values (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references receipts(id) on delete cascade,
  kind receipt_value_kind not null,
  amount numeric(14,2) not null check (amount > 0),

  -- MEDIO_PAGO
  payment_method_id uuid references payment_methods(id) on delete restrict,
  -- CHEQUE
  check_id uuid references third_party_checks(id) on delete restrict,
  -- RETENCION
  tax_rate_id uuid references tax_rates(id) on delete restrict,
  certificate_number text,

  -- Cada tipo trae lo suyo y nada más. Sin esto se podría guardar una
  -- retención sin certificado o un medio de pago sin medio.
  constraint receipt_values_coherente check (
    (kind = 'MEDIO_PAGO'    and payment_method_id is not null and check_id is null and tax_rate_id is null)
    or (kind = 'CHEQUE'     and check_id is not null and payment_method_id is null and tax_rate_id is null)
    or (kind = 'RETENCION'  and tax_rate_id is not null and payment_method_id is null and check_id is null)
    or (kind = 'SALDO_A_FAVOR' and payment_method_id is null and check_id is null and tax_rate_id is null)
  )
);

create index receipt_values_receipt_idx on receipt_values (receipt_id);


-- ===========================================================================
-- 7) RLS
-- ===========================================================================
alter table receipts enable row level security;
alter table receipt_allocations enable row level security;
alter table receipt_values enable row level security;

create policy "solo admin" on receipts for select to authenticated using (is_admin());
create policy "solo admin" on receipt_allocations for select to authenticated using (is_admin());
create policy "solo admin" on receipt_values for select to authenticated using (is_admin());
-- Sin políticas de escritura: se escribe solo por las RPC de abajo.


-- ===========================================================================
-- 8) Crédito disponible del cliente
-- ===========================================================================
-- Lo que cobró de más menos lo que ya usó de ese crédito. Al anular un recibo
-- sus dos términos desaparecen juntos, así que el número se recalcula solo.
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
  ), 0);
$$;


-- ===========================================================================
-- 9) Registrar un recibo
-- ===========================================================================
create or replace function public.save_receipt(
  p_header jsonb,
  p_allocations jsonb,
  p_values jsonb
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

  return query select v_new_id, v_full_number;
end;
$$;

revoke all on function public.save_receipt(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_receipt(jsonb, jsonb, jsonb) to authenticated;


-- ===========================================================================
-- 10) Anular un recibo
-- ===========================================================================
-- Revierte los tres efectos: las facturas, la caja y la cartera.
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

  -- Caja.
  if v_receipt.treasury_movement_id is not null then
    perform public.void_treasury_movement(
      v_receipt.treasury_movement_id,
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


comment on column receipts.on_account_amount is
  'Lo cobrado de más, que queda a cuenta del cliente. Se puede usar en un '
  'recibo posterior como un valor de tipo SALDO_A_FAVOR.';

comment on table receipt_values is
  'Con qué se cobró. RETENCION y SALDO_A_FAVOR cancelan factura pero NO '
  'entran a ninguna caja: la retención es crédito fiscal y el saldo a favor '
  'es plata que ya había entrado antes.';
