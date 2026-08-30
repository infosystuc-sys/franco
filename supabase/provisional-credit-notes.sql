-- ===========================================================================
-- Notas de crédito provisorias por descuento de pronto pago
-- ===========================================================================
-- Migración: provisional-credit-notes
--
-- Cuando el taller paga antes de término y el proveedor ofrece un descuento,
-- a veces la NC formal tarda en llegar. Hasta ahora no había forma de usar
-- ese descuento para cerrar la orden de pago sin ya tener el papel: había
-- que esperar, o cargar la NC "a mano" con un número inventado — lo segundo
-- ensucia el Libro IVA Compras con un comprobante que no es fiscal real.
--
-- Por eso esta NC provisoria vive en una tabla PROPIA, no en
-- purchase_invoices: se aplica en "Comprobantes a cancelar" exactamente
-- igual que una nota de crédito real (mismo signo, mismo efecto en lo
-- imputado), pero nunca aparece en el Libro IVA Compras ni en ningún reporte
-- fiscal, porque no es un comprobante del proveedor.
--
-- Se crea y se usa en el mismo momento, dentro de la propia orden de pago
-- (no hay pantalla de alta suelta) — igual que un cheque nuevo en cobranzas:
-- vive como borrador en la pantalla y se crea recién cuando se guarda la
-- orden, todo en la misma transacción.
--
-- Cuando la NC formal del proveedor finalmente llega (se carga en Compras
-- como cualquier NOTA_CREDITO), se la vincula desde la pantalla "NC
-- provisorias": la formal queda marcada como ya aplicada del todo (el
-- descuento ya se usó, vía la provisoria) y la provisoria pasa a
-- FORMALIZADA. No se descuenta dos veces.
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de payment-orders.sql.


-- ===========================================================================
-- 1) Tipo, numeración y tabla
-- ===========================================================================
create type provisional_credit_note_status as enum ('PENDIENTE', 'FORMALIZADA');

create table provisional_credit_note_sequence (
  id boolean primary key default true check (id),
  last_number int not null default 0 check (last_number >= 0)
);
insert into provisional_credit_note_sequence (id) values (true) on conflict (id) do nothing;

alter table provisional_credit_note_sequence enable row level security;
create policy "solo admin" on provisional_credit_note_sequence for select to authenticated using (is_admin());

create table provisional_credit_notes (
  id uuid primary key default gen_random_uuid(),

  number int not null unique check (number > 0),
  full_number text generated always as ('NCP-' || lpad(number::text, 8, '0')) stored,
  status provisional_credit_note_status not null default 'PENDIENTE',

  supplier_id uuid not null references suppliers(id) on delete restrict,
  -- Copia congelada, mismo criterio que el resto del sistema.
  supplier_name text not null,

  description text not null,
  amount numeric(14,2) not null check (amount > 0),
  -- Cuánto de esta NC ya se aplicó a órdenes de pago. Nace y se usa en la
  -- misma orden, así que casi siempre coincide con amount de entrada; queda
  -- la columna por si alguna vez se anula esa orden y se reutiliza en otra.
  settled_amount numeric(14,2) not null default 0 check (settled_amount >= 0),

  -- La NC real del proveedor que la reemplaza, una vez que llega.
  matched_invoice_id uuid references purchase_invoices(id) on delete restrict,
  matched_at timestamptz,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),

  constraint provisional_credit_notes_settled_no_supera check (settled_amount <= amount),
  constraint provisional_credit_notes_formalizada_con_match check (
    (status = 'FORMALIZADA' and matched_invoice_id is not null and matched_at is not null)
    or (status = 'PENDIENTE' and matched_invoice_id is null and matched_at is null)
  )
);

create index provisional_credit_notes_supplier_idx on provisional_credit_notes (supplier_id);

alter table provisional_credit_notes enable row level security;
create policy "solo admin" on provisional_credit_notes for select to authenticated using (is_admin());
-- Sin políticas de escritura: se escribe solo desde save_payment_order y
-- match_provisional_credit_note.


-- ===========================================================================
-- 2) payment_order_allocations: admite imputar contra una provisoria
-- ===========================================================================
-- purchase_invoice_id deja de ser obligatorio: una fila imputa contra UN
-- comprobante real O UNA provisoria, nunca los dos ni ninguno.
alter table payment_order_allocations
  alter column purchase_invoice_id drop not null,
  add column provisional_credit_note_id uuid references provisional_credit_notes(id) on delete restrict;

alter table payment_order_allocations
  add constraint payment_order_allocations_uno_de_los_dos check (
    (purchase_invoice_id is not null and provisional_credit_note_id is null)
    or (purchase_invoice_id is null and provisional_credit_note_id is not null)
  );

alter table payment_order_allocations
  add constraint payment_order_allocations_provisional_unica
  unique (payment_order_id, provisional_credit_note_id);

create index payment_order_allocations_provisional_idx
  on payment_order_allocations (provisional_credit_note_id);


-- ===========================================================================
-- 3) Registrar una orden de pago: admite provisorias nuevas y existentes
-- ===========================================================================
-- p_allocations: cada elemento trae purchase_invoice_id (comprobante real),
-- O provisional_credit_note_id (provisoria ya existente, de una orden
-- anulada), O provisional_credit_note_temp_key (provisoria nueva, creada acá
-- mismo a partir de p_new_provisional_credit_notes) — exactamente uno de
-- los tres.
create or replace function public.save_payment_order(
  p_header jsonb,
  p_allocations jsonb,
  p_values jsonb,
  p_new_provisional_credit_notes jsonb default '[]'::jsonb
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

  -- ── NC provisorias nuevas: se crean primero, así p_allocations ya las
  -- puede referenciar por temp_key.
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

  -- ── Comprobantes (reales y provisorios).
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

  -- ── Imputaciones. settled_amount sube por el VALOR ABSOLUTO: en una
  -- factura es lo que se pagó, en una nota de crédito (real o provisoria) es
  -- lo que se consumió de ella.
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

revoke all on function public.save_payment_order(jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_payment_order(jsonb, jsonb, jsonb, jsonb) to authenticated;


-- ===========================================================================
-- 4) Anular una orden de pago: revierte también las provisorias que usó
-- ===========================================================================
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

  -- Una provisoria ya formalizada representa un descuento que el proveedor
  -- ya confirmó por escrito: anular la orden ahora dejaría ese descuento sin
  -- ningún comprobante que lo sostenga.
  select pcn.full_number into v_bad
    from payment_order_allocations al
    join provisional_credit_notes pcn on pcn.id = al.provisional_credit_note_id
   where al.payment_order_id = p_order_id and pcn.status = 'FORMALIZADA'
   limit 1;

  if found then
    raise exception 'La NC provisoria % ya fue formalizada y no se puede dar de baja la orden.', v_bad.full_number;
  end if;

  -- Comprobantes reales: vuelven a quedar pendientes.
  update purchase_invoices
     set settled_amount = purchase_invoices.settled_amount - abs(al.amount)
    from payment_order_allocations al
   where al.payment_order_id = p_order_id and al.purchase_invoice_id = purchase_invoices.id;

  -- NC provisorias: vuelven a estar disponibles (quedan PENDIENTE, listas
  -- para usarse en otra orden si el descuento sigue en pie).
  update provisional_credit_notes
     set settled_amount = provisional_credit_notes.settled_amount - abs(al.amount)
    from payment_order_allocations al
   where al.payment_order_id = p_order_id
     and al.provisional_credit_note_id = provisional_credit_notes.id;

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


-- ===========================================================================
-- 5) Vincular la NC provisoria con la NC formal del proveedor
-- ===========================================================================
-- La NC real queda pre-aplicada del todo: el descuento ya se usó cuando se
-- creó la provisoria, así que la formal no se puede volver a aplicar.
create or replace function public.match_provisional_credit_note(
  p_provisional_id uuid,
  p_invoice_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.match_provisional_credit_note(uuid, uuid) from public, anon;
grant execute on function public.match_provisional_credit_note(uuid, uuid) to authenticated;


comment on table provisional_credit_notes is
  'Descuento de pronto pago usado para cerrar una orden de pago antes de que '
  'llegue la NC formal del proveedor. Nunca es un comprobante fiscal: no '
  'entra al Libro IVA Compras. Se formaliza vinculándola a la NC real cuando '
  'llega, desde match_provisional_credit_note.';
