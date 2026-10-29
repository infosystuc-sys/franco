-- Notas de crédito de compra, siempre contra una factura.
--
-- Hasta ahora una NC de compra era un comprobante suelto: quedaba como saldo a
-- favor en la cuenta del proveedor y había que acordarse de imputarla en una
-- orden de pago. Ahora toda NC nueva dice a qué factura acredita, y al
-- guardarse se aplica sola contra el saldo de esa factura:
--
--   · TOTAL: cancela la factura entera. Se registra copiando la factura tal
--     cual (renglones, IVA, percepciones, importes al centavo), así que el
--     total coincide exacto sin tener que tipear nada.
--   · PARCIAL: una devolución de algunos artículos, una bonificación, un
--     ajuste de precio. Se carga con sus propios renglones, como hasta ahora.
--
-- Lo que la NC aplica a la factura es lo que la factura todavía debe. Si ya
-- estaba pagada (toda o en parte), el resto de la NC queda como saldo a favor
-- y se usa en la próxima orden de pago, como siempre. La suma de las NC de una
-- factura nunca puede superar el total de la factura.
--
-- Las NC cargadas antes de este cambio quedan como estaban, sin factura.

alter table public.purchase_invoices
  add column if not exists credits_invoice_id uuid references public.purchase_invoices(id),
  add column if not exists credit_applied_amount numeric(14,2) not null default 0;

comment on column public.purchase_invoices.credits_invoice_id is
  'Nota de crédito: la factura a la que acredita.';
comment on column public.purchase_invoices.credit_applied_amount is
  'Nota de crédito: lo que se aplicó contra el saldo de esa factura al registrarla.';

create index if not exists purchase_invoices_credits_invoice_idx
  on public.purchase_invoices (credits_invoice_id)
  where credits_invoice_id is not null;

-- ── Aplicar una NC recién registrada contra su factura ──────────────────────
-- Solo la llaman save_purchase_invoice y registrar_nota_de_credito_total.
create or replace function public.aplicar_nota_de_credito_a_factura(p_nc_id uuid, p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_nc purchase_invoices%rowtype;
  v_inv purchase_invoices%rowtype;
  v_acreditado numeric(14,2);
  v_aplicado numeric(14,2);
begin
  select * into v_nc from purchase_invoices where id = p_nc_id for update;
  if not found or v_nc.doc_type <> 'NOTA_CREDITO' then
    raise exception 'Solo una nota de crédito se puede acreditar a una factura.';
  end if;

  select * into v_inv from purchase_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'La factura a la que acredita la nota de crédito no existe.';
  end if;
  if v_inv.doc_type <> 'FACTURA' then
    raise exception 'El comprobante % no es una factura: la nota de crédito tiene que acreditar una factura.', v_inv.full_number;
  end if;
  if v_inv.status <> 'REGISTRADA' then
    raise exception 'La factura % está anulada.', v_inv.full_number;
  end if;
  if v_inv.supplier_id <> v_nc.supplier_id then
    raise exception 'La factura % es de otro proveedor.', v_inv.full_number;
  end if;

  select coalesce(sum(total_amount), 0) into v_acreditado
    from purchase_invoices
   where credits_invoice_id = p_invoice_id
     and id <> p_nc_id
     and status = 'REGISTRADA';

  if v_acreditado + v_nc.total_amount > v_inv.total_amount + 0.01 then
    raise exception '%', format(
      'La factura %s es de $ %s y ya tiene notas de crédito por $ %s: queda $ %s para acreditar y esta nota de crédito es de $ %s.',
      v_inv.full_number, v_inv.total_amount, v_acreditado,
      v_inv.total_amount - v_acreditado, v_nc.total_amount);
  end if;

  v_aplicado := greatest(0, least(v_nc.total_amount, v_inv.total_amount - v_inv.settled_amount));

  update purchase_invoices
     set settled_amount = settled_amount + v_aplicado
   where id = p_invoice_id;

  update purchase_invoices
     set credits_invoice_id = p_invoice_id,
         credit_applied_amount = v_aplicado,
         settled_amount = v_aplicado
   where id = p_nc_id;
end;
$$;

revoke all on function public.aplicar_nota_de_credito_a_factura(uuid, uuid) from public, anon, authenticated;

-- ── save_purchase_invoice: la NC exige factura y se aplica al guardarse ─────
do $$
declare
  v_def text;
  v_nuevo text;
begin
  select pg_get_functiondef('public.save_purchase_invoice'::regproc) into v_def;
  v_def := replace(v_def, chr(13), '');
  if position('aplicar_nota_de_credito_a_factura' in v_def) > 0 then
    return;
  end if;
  v_nuevo := replace(v_def,
    '  -- ── Inventario.',
    '  -- ── Nota de crédito: siempre contra una factura, y se aplica a su saldo.
  if v_doc_type = ''NOTA_CREDITO'' then
    if nullif(p_header->>''credits_invoice_id'', '''') is null then
      raise exception ''La nota de crédito tiene que indicar la factura a la que acredita.'';
    end if;
    perform public.aplicar_nota_de_credito_a_factura(v_new_id, (p_header->>''credits_invoice_id'')::uuid);
  end if;

  -- ── Inventario.');
  if v_nuevo = v_def then
    raise exception 'No se encontró dónde enganchar la nota de crédito en save_purchase_invoice';
  end if;
  execute v_nuevo;
end $$;

-- ── NC total: copia exacta de la factura ────────────────────────────────────
create or replace function public.registrar_nota_de_credito_total(p_invoice_id uuid, p_header jsonb)
returns table(purchase_id uuid, purchase_full_number text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv purchase_invoices%rowtype;
  v_new_id uuid;
  v_full_number text;
  v_moves_stock boolean;
  v_issue date;
  v_row record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_inv from purchase_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'La factura no existe.';
  end if;
  if v_inv.doc_type <> 'FACTURA' or v_inv.status <> 'REGISTRADA' then
    raise exception 'Solo se puede acreditar totalmente una factura registrada.';
  end if;
  if exists (
    select 1 from purchase_invoices
     where credits_invoice_id = p_invoice_id and status = 'REGISTRADA'
  ) then
    raise exception 'La factura % ya tiene notas de crédito parciales: lo que falta acreditar se carga como nota de crédito parcial.', v_inv.full_number;
  end if;
  if coalesce((p_header->>'number')::int, 0) <= 0 then
    raise exception 'Falta el número de la nota de crédito.';
  end if;

  -- Si la factura repuso stock, la NC total lo devuelve, salvo que se diga
  -- que la mercadería no vuelve (una NC por un error de facturación).
  v_moves_stock := v_inv.kind = 'ARTICULOS' and v_inv.moves_stock
    and coalesce((p_header->>'moves_stock')::boolean, true);
  v_issue := coalesce((p_header->>'issue_date')::date, current_date);

  insert into purchase_invoices (
    kind, doc_type, letter, sales_point, number, status,
    supplier_id, supplier_name, supplier_legal_name, supplier_tax_id, supplier_tax_condition,
    issue_date, received_date, due_date, payment_terms_days, moves_stock,
    gross_amount, line_discount_amount, general_discount_percent, general_discount_amount,
    net_taxed, net_exempt, net_untaxed, vat_amount, other_taxes_amount, total_amount,
    notes, created_by
  )
  values (
    v_inv.kind, 'NOTA_CREDITO', coalesce((p_header->>'letter')::purchase_letter, v_inv.letter),
    coalesce((p_header->>'sales_point')::int, 0), (p_header->>'number')::int, 'REGISTRADA',
    v_inv.supplier_id, v_inv.supplier_name, v_inv.supplier_legal_name, v_inv.supplier_tax_id,
    v_inv.supplier_tax_condition,
    v_issue, coalesce((p_header->>'received_date')::date, current_date), v_issue, 0,
    v_moves_stock,
    v_inv.gross_amount, v_inv.line_discount_amount, v_inv.general_discount_percent, v_inv.general_discount_amount,
    v_inv.net_taxed, v_inv.net_exempt, v_inv.net_untaxed, v_inv.vat_amount, v_inv.other_taxes_amount,
    v_inv.total_amount,
    nullif(trim(coalesce(p_header->>'notes', '')), ''), auth.uid()
  )
  returning purchase_invoices.id, purchase_invoices.full_number into v_new_id, v_full_number;

  insert into purchase_invoice_items (
    purchase_invoice_id, line_number, article_id, concept_id, code, description,
    quantity, unit_price, discount_percent, net_amount,
    vat_rate_id, vat_rate, vat_treatment, vat_amount
  )
  select v_new_id, line_number, article_id, concept_id, code, description,
         quantity, unit_price, discount_percent, net_amount,
         vat_rate_id, vat_rate, vat_treatment, vat_amount
    from purchase_invoice_items
   where purchase_invoice_id = p_invoice_id;

  insert into purchase_invoice_taxes (
    purchase_invoice_id, tax_rate_id, name, kind, rate, base_amount, amount
  )
  select v_new_id, tax_rate_id, name, kind, rate, base_amount, amount
    from purchase_invoice_taxes
   where purchase_invoice_id = p_invoice_id;

  if v_moves_stock then
    for v_row in
      select article_id, quantity from purchase_invoice_items
       where purchase_invoice_id = p_invoice_id and article_id is not null
    loop
      perform public.adjust_article_stock(v_row.article_id, -v_row.quantity);
    end loop;
  end if;

  perform public.aplicar_nota_de_credito_a_factura(v_new_id, p_invoice_id);

  return query select v_new_id, v_full_number;
end;
$$;

revoke all on function public.registrar_nota_de_credito_total(uuid, jsonb) from public, anon;
grant execute on function public.registrar_nota_de_credito_total(uuid, jsonb) to authenticated;

-- ── Eliminar: la NC devuelve lo que aplicó; la factura con NC no se borra ───
do $$
declare
  v_def text;
  v_nuevo text;
begin
  select pg_get_functiondef('public.eliminar_comprobante_de_compra'::regproc) into v_def;
  v_def := replace(v_def, chr(13), '');
  if position('credit_applied_amount' in v_def) > 0 then
    return;
  end if;
  v_nuevo := regexp_replace(v_def,
    '(\n  if v_doc\.settled_amount > 0 then)',
    '
  -- Una factura con notas de crédito que la acreditan no se borra: primero
  -- van las notas de crédito.
  if exists (
    select 1 from purchase_invoices nc where nc.credits_invoice_id = p_purchase_invoice_id
  ) then
    raise exception ''La factura % tiene notas de crédito que la acreditan (%). Eliminá primero esas notas de crédito.'',
      v_doc.full_number,
      (select string_agg(nc.full_number, '', '') from purchase_invoices nc
        where nc.credits_invoice_id = p_purchase_invoice_id);
  end if;

  -- Una nota de crédito le devuelve a su factura el saldo que le había
  -- cancelado, y eso deja de contar como imputación propia.
  if v_doc.credits_invoice_id is not null and v_doc.credit_applied_amount > 0 then
    update purchase_invoices
       set settled_amount = settled_amount - v_doc.credit_applied_amount
     where id = v_doc.credits_invoice_id;
    v_doc.settled_amount := v_doc.settled_amount - v_doc.credit_applied_amount;
    update purchase_invoices
       set settled_amount = v_doc.settled_amount, credit_applied_amount = 0
     where id = p_purchase_invoice_id;
  end if;
\1');
  if v_nuevo = v_def then
    raise exception 'No se encontró dónde enganchar la nota de crédito en eliminar_comprobante_de_compra';
  end if;
  execute v_nuevo;
end $$;

notify pgrst, 'reload schema';
