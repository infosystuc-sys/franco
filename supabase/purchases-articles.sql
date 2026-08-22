-- DieselPro ERP — compras, fase 3: compras de artículos
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de purchases.sql.
-- Este archivo queda además como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-22-compras-design.md
--
-- Qué agrega esta fase: los comprobantes con artículos del catálogo, que
-- MUEVEN STOCK y actualizan el precio de compra. Es la primera vez que
-- compras escribe en el inventario, así que todo el movimiento pasa por
-- adjust_article_stock —que ya existe, bloquea la fila y rechaza dejar el
-- stock en negativo— en vez de tocar articles.stock_quantity a mano.


-- ===========================================================================
-- 1) El tilde deja de ser solo de la nota de crédito
-- ===========================================================================
-- returns_goods nació pensando en la NC ("devuelve mercadería"). Ahora la ND
-- también puede mover stock ("ingresa mercadería"), así que el nombre pasa a
-- describir lo que el campo realmente decide: si el comprobante mueve stock.
-- La DIRECCIÓN no sale de acá, sale del tipo de comprobante.
alter table purchase_invoices rename column returns_goods to moves_stock;

comment on column purchase_invoices.moves_stock is
  'Si el comprobante mueve inventario. La factura de artículos siempre lo '
  'mueve; en la nota de crédito y en la de débito lo decide el usuario, '
  'porque la misma NC puede ser una devolución o un ajuste de precio y en el '
  'papel no se distinguen. La dirección la da doc_type, no este campo.';


-- ===========================================================================
-- 2) Registrar un comprobante (reemplaza la versión de la fase 2)
-- ===========================================================================
create or replace function public.save_purchase_invoice(
  p_header jsonb,
  p_items jsonb,
  p_taxes jsonb default '[]'::jsonb
)
returns table (purchase_id uuid, purchase_full_number text)
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.save_purchase_invoice(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_purchase_invoice(jsonb, jsonb, jsonb) to authenticated;


-- ===========================================================================
-- 3) Anular (reemplaza la versión de la fase 2)
-- ===========================================================================
-- Ahora revierte el movimiento de stock. Si los repuestos ya se consumieron
-- en una orden, adjust_article_stock rechaza la anulación por stock
-- insuficiente, y está bien que así sea: no se puede deshacer una compra cuya
-- mercadería ya salió del taller.
--
-- Lo que NO se revierte es el precio de compra: no se guarda el valor
-- anterior, así que no hay a qué volver. Si hace falta, se corrige desde
-- Inventario.
create or replace function public.void_purchase_invoice(
  p_purchase_invoice_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.void_purchase_invoice(uuid, text) from public, anon;
grant execute on function public.void_purchase_invoice(uuid, text) to authenticated;
