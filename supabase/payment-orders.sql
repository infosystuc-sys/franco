-- DieselPro ERP — pagos a proveedores
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de purchases.sql y
-- treasury-checks.sql. Este archivo queda además como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-23-pagos-design.md
--
-- Es el espejo de cobranzas (receipts.sql), con cuatro diferencias:
--
--   1. Las imputaciones llevan SIGNO. Compras sí tiene notas de crédito:
--      facturas y notas de débito en positivo, notas de crédito en negativo.
--   2. El cheque se CONSUME de la cartera, no se crea. Solo se ofrecen los
--      que están EN_CARTERA, y pasan a ENDOSADO.
--   3. La retención es al revés: acá la practica el taller y le queda
--      debiendo ese importe a ARCA. El sistema guarda el certificado; el
--      pasivo no se lleva.
--   4. Anular DEVUELVE el cheque a la cartera. Si la orden fue un error, el
--      cheque sigue en poder del taller.


-- ===========================================================================
-- 1) Tipos
-- ===========================================================================
create type payment_order_status as enum ('REGISTRADA', 'ANULADA');

-- Los dos últimos NO mueven caja:
--   RETENCION      se le retiene al proveedor; cancela factura, no es plata
--                  que sale.
--   SALDO_A_FAVOR  crédito que el taller ya tenía con ese proveedor.
create type payment_value_kind as enum (
  'MEDIO_PAGO', 'CHEQUE_ENDOSADO', 'RETENCION', 'SALDO_A_FAVOR'
);


-- ===========================================================================
-- 2) Numeración
-- ===========================================================================
create table payment_order_sequence (
  id boolean primary key default true check (id),
  last_number int not null default 0 check (last_number >= 0)
);
insert into payment_order_sequence (id) values (true) on conflict (id) do nothing;

alter table payment_order_sequence enable row level security;
create policy "solo admin" on payment_order_sequence for select to authenticated using (is_admin());


-- ===========================================================================
-- 3) La orden
-- ===========================================================================
create table payment_orders (
  id uuid primary key default gen_random_uuid(),

  number int not null unique check (number > 0),
  full_number text not null,
  status payment_order_status not null default 'REGISTRADA',

  supplier_id uuid not null references suppliers(id) on delete restrict,
  supplier_name text not null,

  payment_date date not null default current_date,

  -- Suma de los valores y suma (con signo) de las imputaciones.
  --
  -- El total puede ser CERO: si una nota de crédito cancela exactamente una
  -- factura, la orden no mueve plata. Es una operación real y se admite. Lo
  -- que se rechaza es una orden sin imputaciones y sin valores.
  total_amount numeric(14,2) not null check (total_amount >= 0),
  applied_amount numeric(14,2) not null default 0 check (applied_amount >= 0),
  on_account_amount numeric(14,2) generated always as (total_amount - applied_amount) stored,

  notes text,

  -- El egreso que generó en el libro de caja. Null si se pagó todo con
  -- retenciones y saldo a favor, o si fue una compensación pura.
  treasury_movement_id uuid references treasury_movements(id) on delete restrict,

  voided_at timestamptz,
  voided_reason text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_orders_imputado_no_supera_pagado check (applied_amount <= total_amount),

  constraint payment_orders_anulada_con_motivo check (
    (status = 'ANULADA' and voided_at is not null and voided_reason is not null)
    or (status = 'REGISTRADA' and voided_at is null and voided_reason is null)
  )
);

create index payment_orders_supplier_idx on payment_orders (supplier_id);
create index payment_orders_date_idx on payment_orders (payment_date desc);

create trigger payment_orders_set_updated_at
before update on payment_orders
for each row execute function set_updated_at();


-- ===========================================================================
-- 4) Imputaciones
-- ===========================================================================
create table payment_order_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid not null references payment_orders(id) on delete cascade,
  purchase_invoice_id uuid not null references purchase_invoices(id) on delete restrict,
  -- CON SIGNO: positivo en facturas y notas de débito, negativo en notas de
  -- crédito. Así el imputado de la cabecera es una suma y nada más.
  amount numeric(14,2) not null check (amount <> 0),
  unique (payment_order_id, purchase_invoice_id)
);

create index payment_order_allocations_doc_idx on payment_order_allocations (purchase_invoice_id);


-- ===========================================================================
-- 5) Valores
-- ===========================================================================
create table payment_order_values (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid not null references payment_orders(id) on delete cascade,
  kind payment_value_kind not null,
  amount numeric(14,2) not null check (amount > 0),

  payment_method_id uuid references payment_methods(id) on delete restrict,
  -- Un cheque QUE YA EXISTE en la cartera, no uno nuevo.
  check_id uuid references third_party_checks(id) on delete restrict,
  tax_rate_id uuid references tax_rates(id) on delete restrict,
  certificate_number text,

  constraint payment_order_values_coherente check (
    (kind = 'MEDIO_PAGO'      and payment_method_id is not null and check_id is null and tax_rate_id is null)
    or (kind = 'CHEQUE_ENDOSADO' and check_id is not null and payment_method_id is null and tax_rate_id is null)
    or (kind = 'RETENCION'    and tax_rate_id is not null and payment_method_id is null and check_id is null)
    or (kind = 'SALDO_A_FAVOR' and payment_method_id is null and check_id is null and tax_rate_id is null)
  )
);

create index payment_order_values_order_idx on payment_order_values (payment_order_id);


-- ===========================================================================
-- 6) RLS
-- ===========================================================================
alter table payment_orders enable row level security;
alter table payment_order_allocations enable row level security;
alter table payment_order_values enable row level security;

create policy "solo admin" on payment_orders for select to authenticated using (is_admin());
create policy "solo admin" on payment_order_allocations for select to authenticated using (is_admin());
create policy "solo admin" on payment_order_values for select to authenticated using (is_admin());


-- ===========================================================================
-- 7) Crédito disponible con el proveedor
-- ===========================================================================
create or replace function public.supplier_credit(p_supplier_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
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
$$;


-- ===========================================================================
-- 8) Registrar una orden de pago
-- ===========================================================================
create or replace function public.save_payment_order(
  p_header jsonb,
  p_allocations jsonb,
  p_values jsonb
)
returns table (order_id uuid, order_full_number text)
language plpgsql
security definer
set search_path = public
as $$
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

  -- Una orden sin nada no es nada.
  if jsonb_array_length(coalesce(p_values, '[]'::jsonb)) = 0
     and jsonb_array_length(coalesce(p_allocations, '[]'::jsonb)) = 0 then
    raise exception 'La orden de pago no tiene ni comprobantes ni valores.';
  end if;

  -- Imputar en negativo neto significaría que el proveedor te debe a vos:
  -- eso no es una orden de pago.
  if v_applied < 0 then
    raise exception 'Las notas de crédito superan a las facturas: no hay nada que pagar.';
  end if;

  -- Se puede pagar de más (queda a cuenta), pero no imputar más de lo pagado.
  if v_applied > v_total then
    raise exception 'Estás imputando $ % y la orden paga $ %.', v_applied, v_total;
  end if;

  -- ── Comprobantes.
  if p_allocations is not null and jsonb_array_length(p_allocations) > 0 then
    for v_alloc in select * from jsonb_array_elements(p_allocations) loop
      declare
        v_doc purchase_invoices%rowtype;
        v_amount numeric(14,2) := round((v_alloc->>'amount')::numeric, 2);
      begin
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

        -- El signo tiene que coincidir con el tipo. Una nota de crédito en
        -- positivo sería pagarle de más al proveedor por una devolución.
        if v_doc.doc_type = 'NOTA_CREDITO' and v_amount > 0 then
          raise exception 'La nota de crédito % resta: cargala en negativo.', v_doc.full_number;
        end if;
        if v_doc.doc_type <> 'NOTA_CREDITO' and v_amount < 0 then
          raise exception 'El comprobante % suma: cargalo en positivo.', v_doc.full_number;
        end if;

        -- El for update de arriba impide que dos órdenes simultáneas cancelen
        -- el mismo saldo dos veces.
        if abs(v_amount) > v_doc.total_amount - v_doc.settled_amount then
          raise exception 'El comprobante % tiene $ % pendientes y estás imputando $ %.',
            v_doc.full_number,
            v_doc.total_amount - v_doc.settled_amount, abs(v_amount);
        end if;
      end;
    end loop;
  end if;

  -- ── Saldo a favor.
  select round(coalesce(sum((v->>'amount')::numeric), 0), 2)
    into v_credit_used
    from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) as v
   where v->>'kind' = 'SALDO_A_FAVOR';

  if v_credit_used > 0 and v_credit_used > public.supplier_credit(v_supplier.id) then
    raise exception 'Tenés $ % a favor con % y estás usando $ %.',
      public.supplier_credit(v_supplier.id), v_supplier.name, v_credit_used;
  end if;

  -- ── Retenciones.
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

  -- ── Medios de pago.
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

  -- ── Cheques: tienen que estar en cartera y valer lo que dice el valor.
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

  -- ── Cabecera.
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

  -- ── Imputaciones. settled_amount sube por el VALOR ABSOLUTO: en una factura
  -- es lo que se pagó, en una nota de crédito es lo que se consumió de ella.
  insert into payment_order_allocations (payment_order_id, purchase_invoice_id, amount)
  select v_new_id, (a->>'purchase_invoice_id')::uuid, round((a->>'amount')::numeric, 2)
  from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as a;

  update purchase_invoices
     set settled_amount = purchase_invoices.settled_amount + abs(al.amount)
    from payment_order_allocations al
   where al.payment_order_id = v_new_id and al.purchase_invoice_id = purchase_invoices.id;

  -- ── Valores.
  v_wallet := public.checks_wallet_id();

  for v_value in select * from jsonb_array_elements(coalesce(p_values, '[]'::jsonb)) loop
    if v_value->>'kind' = 'CHEQUE_ENDOSADO' then
      insert into payment_order_values (payment_order_id, kind, amount, check_id)
      values (
        v_new_id, 'CHEQUE_ENDOSADO', round((v_value->>'amount')::numeric, 2),
        (v_value->>'check_id')::uuid
      );

      -- No se llama a endorse_check a propósito: esa función postea su propio
      -- egreso, y el egreso de esta orden ya lleva la partida de la cartera.
      -- Llamarla sacaría la plata dos veces.
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

    else -- SALDO_A_FAVOR
      insert into payment_order_values (payment_order_id, kind, amount)
      values (v_new_id, 'SALDO_A_FAVOR', round((v_value->>'amount')::numeric, 2));
    end if;
  end loop;

  -- ── Libro de caja. Las partidas ya vienen en negativo: es plata que sale.
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
$$;

revoke all on function public.save_payment_order(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_payment_order(jsonb, jsonb, jsonb) to authenticated;


-- ===========================================================================
-- 9) Anular una orden de pago
-- ===========================================================================
-- A diferencia de cobranzas, acá el cheque SÍ vuelve: si la orden fue un
-- error, el cheque sigue en poder del taller.
create or replace function public.void_payment_order(
  p_order_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order payment_orders%rowtype;
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

  -- Comprobantes: vuelven a quedar pendientes.
  update purchase_invoices
     set settled_amount = purchase_invoices.settled_amount - abs(al.amount)
    from payment_order_allocations al
   where al.payment_order_id = p_order_id and al.purchase_invoice_id = purchase_invoices.id;

  -- Cheques: vuelven a la cartera y se limpia el endoso.
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
$$;

revoke all on function public.void_payment_order(uuid, text) from public, anon;
grant execute on function public.void_payment_order(uuid, text) to authenticated;


comment on column payment_order_allocations.amount is
  'Con signo: positivo en facturas y notas de débito, negativo en notas de '
  'crédito. settled_amount del comprobante sube por el valor absoluto.';

comment on table payment_order_values is
  'Con qué se pagó. RETENCION y SALDO_A_FAVOR cancelan comprobante pero NO '
  'sacan plata de ninguna caja.';
