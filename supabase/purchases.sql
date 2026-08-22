-- DieselPro ERP — compras, fase 2: el comprobante y la cuenta corriente
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de purchase-catalogs.sql.
-- Este archivo queda además como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-22-compras-design.md
--
-- Modelo:
--   A diferencia de la venta, acá NO se genera nada: tipo, letra, punto de
--   venta y número se transcriben del papel que mandó el proveedor. El
--   sistema no numera, valida.
--
--   El comprobante es un registro congelado: guarda copia de los datos
--   fiscales del proveedor y de las alícuotas aplicadas. Editar el padrón no
--   altera un comprobante ya cargado.
--
--   El esquema contempla las dos formas (ARTICULOS y CONCEPTOS) desde ahora,
--   pero esta fase solo permite cargar CONCEPTOS. Los artículos mueven stock
--   y precio de compra, y eso llega en la fase 3: hasta entonces la función
--   los rechaza explícitamente, para que no exista el camino silencioso en
--   que se carga una compra de artículos y el inventario no se entera.


-- ===========================================================================
-- 1) Tipos
-- ===========================================================================
create type purchase_kind as enum ('ARTICULOS', 'CONCEPTOS');
create type purchase_doc_type as enum ('FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO');
create type purchase_letter as enum ('A', 'B', 'C', 'M');
create type purchase_status as enum ('REGISTRADA', 'ANULADA');


-- ===========================================================================
-- 2) El comprobante
-- ===========================================================================
create table purchase_invoices (
  id uuid primary key default gen_random_uuid(),

  kind purchase_kind not null,
  doc_type purchase_doc_type not null,
  letter purchase_letter not null,
  -- Punto de venta y número DEL PROVEEDOR: se transcriben, no se generan.
  sales_point int not null check (sales_point >= 0 and sales_point <= 99999),
  number int not null check (number > 0),
  full_number text generated always as (
    lpad(sales_point::text, 4, '0') || '-' || lpad(number::text, 8, '0')
  ) stored,
  status purchase_status not null default 'REGISTRADA',

  supplier_id uuid not null references suppliers(id) on delete restrict,

  -- Copia congelada del proveedor: la compra no cambia si después se edita
  -- el padrón.
  supplier_name text not null,
  supplier_legal_name text,
  supplier_tax_id text,
  supplier_tax_condition text not null,

  -- issue_date es la fecha del papel; received_date es cuándo entró al
  -- taller. No siempre coinciden, y la que manda para el vencimiento y para
  -- el Libro IVA Compras es la del papel.
  issue_date date not null,
  received_date date not null default current_date,
  due_date date not null,
  payment_terms_days int not null check (payment_terms_days >= 0),

  -- Solo en notas de crédito de artículos: la misma NC puede ser una
  -- devolución de mercadería (resta stock) o un ajuste de precio (no lo
  -- toca), y en el papel no se distinguen. Lo usa la fase 3.
  returns_goods boolean not null default false,

  -- Importes. gross → descuentos → netos por tratamiento → IVA → pie → total.
  gross_amount numeric(14,2) not null check (gross_amount >= 0),
  line_discount_amount numeric(14,2) not null default 0 check (line_discount_amount >= 0),
  general_discount_percent numeric(5,2) not null default 0
    check (general_discount_percent >= 0 and general_discount_percent <= 100),
  general_discount_amount numeric(14,2) not null default 0 check (general_discount_amount >= 0),

  net_taxed numeric(14,2) not null default 0 check (net_taxed >= 0),
  net_exempt numeric(14,2) not null default 0 check (net_exempt >= 0),
  net_untaxed numeric(14,2) not null default 0 check (net_untaxed >= 0),
  vat_amount numeric(14,2) not null default 0 check (vat_amount >= 0),
  other_taxes_amount numeric(14,2) not null default 0 check (other_taxes_amount >= 0),
  total_amount numeric(14,2) not null check (total_amount >= 0),

  -- El enganche del módulo de pagos. Se llama "settled" y no "paid" porque en
  -- una nota de crédito no es "pagado" sino "aplicado".
  settled_amount numeric(14,2) not null default 0 check (settled_amount >= 0),

  -- Negativo en las notas de crédito. Así el saldo de un proveedor es una
  -- suma y nada más, sin case en cada consulta.
  signed_total numeric(14,2) generated always as (
    case when doc_type = 'NOTA_CREDITO' then -total_amount else total_amount end
  ) stored,

  notes text,

  voided_at timestamptz,
  voided_reason text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_anulada_con_motivo check (
    (status = 'ANULADA' and voided_at is not null and voided_reason is not null)
    or (status = 'REGISTRADA' and voided_at is null and voided_reason is null)
  )
);

-- Cargar dos veces la misma factura es el error más común de compras, y acá
-- duplica la deuda Y el stock a la vez. Parcial sobre las vigentes: anular
-- una mal tipeada libera la combinación para volver a cargarla bien.
create unique index purchase_invoices_sin_duplicados
  on purchase_invoices (supplier_id, doc_type, letter, sales_point, number)
  where status = 'REGISTRADA';

create index purchase_invoices_supplier_idx on purchase_invoices (supplier_id);
create index purchase_invoices_due_date_idx on purchase_invoices (due_date);
create index purchase_invoices_issue_date_idx on purchase_invoices (issue_date);

create trigger purchase_invoices_set_updated_at
before update on purchase_invoices
for each row execute function set_updated_at();


-- ===========================================================================
-- 3) El cuerpo
-- ===========================================================================
create table purchase_invoice_items (
  id uuid primary key default gen_random_uuid(),
  purchase_invoice_id uuid not null references purchase_invoices(id) on delete cascade,
  line_number int not null,

  -- Como mucho uno de los dos, según el kind del comprobante. Los dos en
  -- null es un renglón de texto libre, que es válido en conceptos.
  article_id uuid references articles(id) on delete restrict,
  concept_id uuid references expense_concepts(id) on delete restrict,

  code text,
  description text not null,
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null check (unit_price >= 0),
  discount_percent numeric(5,2) not null default 0
    check (discount_percent >= 0 and discount_percent <= 100),
  -- Neto del renglón ya bonificado (por renglón y por la parte proporcional
  -- del descuento general).
  net_amount numeric(14,2) not null check (net_amount >= 0),

  -- La alícuota queda congelada además del FK: si mañana se corrige el
  -- padrón, el comprobante tiene que seguir mostrando lo que se aplicó.
  vat_rate_id uuid not null references tax_rates(id) on delete restrict,
  vat_rate numeric(6,3) not null,
  vat_treatment text not null check (vat_treatment in ('GRAVADO', 'EXENTO', 'NO_GRAVADO')),
  vat_amount numeric(14,2) not null check (vat_amount >= 0),

  constraint purchase_item_articulo_o_concepto check (
    article_id is null or concept_id is null
  )
);

create index purchase_invoice_items_idx on purchase_invoice_items (purchase_invoice_id, line_number);


-- ===========================================================================
-- 4) El pie de impuestos
-- ===========================================================================
-- Percepciones e impuestos internos. El importe se calcula pero queda
-- editable: la cuenta del proveedor a veces redondea distinto y el
-- comprobante tiene que cerrar exacto igual.
create table purchase_invoice_taxes (
  id uuid primary key default gen_random_uuid(),
  purchase_invoice_id uuid not null references purchase_invoices(id) on delete cascade,
  tax_rate_id uuid not null references tax_rates(id) on delete restrict,
  -- Congelados, por lo mismo que la alícuota del renglón.
  name text not null,
  kind tax_kind not null,
  rate numeric(6,3) not null,
  base_amount numeric(14,2) not null check (base_amount >= 0),
  amount numeric(14,2) not null check (amount >= 0)
);

create index purchase_invoice_taxes_idx on purchase_invoice_taxes (purchase_invoice_id);


-- ===========================================================================
-- 5) RLS
-- ===========================================================================
-- Lectura solo admin, igual que proveedores y facturación. Sin políticas de
-- escritura: se escribe solo por las RPC de abajo, que son las que calculan
-- los importes.
alter table purchase_invoices enable row level security;
alter table purchase_invoice_items enable row level security;
alter table purchase_invoice_taxes enable row level security;

create policy "solo admin" on purchase_invoices for select to authenticated using (is_admin());
create policy "solo admin" on purchase_invoice_items for select to authenticated using (is_admin());
create policy "solo admin" on purchase_invoice_taxes for select to authenticated using (is_admin());


-- ===========================================================================
-- 6) Registrar un comprobante
-- ===========================================================================
-- Una sola transacción. El encabezado viaja como jsonb porque son quince
-- campos y una firma con quince parámetros es imposible de leer y de llamar
-- sin equivocarse.
--
-- Qué calcula la base y qué acepta del cliente, que no es lo mismo que en
-- ventas: acá el comprobante YA EXISTE en papel. Los netos y el IVA salen de
-- cantidad × precio × alícuota, así que los calcula la base. Los importes del
-- pie los transcribe el usuario del papel, así que se aceptan como vienen: es
-- lo que permite que el comprobante cierre exacto aunque el proveedor haya
-- redondeado distinto.
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
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  v_kind := (p_header->>'kind')::purchase_kind;
  v_doc_type := (p_header->>'doc_type')::purchase_doc_type;
  v_general_discount := coalesce((p_header->>'general_discount_percent')::numeric, 0);

  -- Fase 2: solo conceptos. Los artículos mueven stock y precio de compra, y
  -- eso todavía no está implementado. Sin esta guarda existiría el camino
  -- silencioso en que se registra una compra de repuestos y el inventario
  -- nunca se entera.
  if v_kind = 'ARTICULOS' then
    raise exception 'Las compras de artículos todavía no están habilitadas: mueven stock y precio de compra, y eso llega en la próxima etapa.';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'El comprobante no tiene renglones cargados.';
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

  -- ── Renglones. Se calcula todo de una pasada sobre el jsonb.
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

  -- ── Pie. El importe viene del papel; la base se recalcula para dejar
  -- registrado sobre qué se aplicó.
  select round(coalesce(sum((tax->>'amount')::numeric), 0), 2)
  into v_other
  from jsonb_array_elements(coalesce(p_taxes, '[]'::jsonb)) as tax;

  insert into purchase_invoices (
    kind, doc_type, letter, sales_point, number, status,
    supplier_id, supplier_name, supplier_legal_name, supplier_tax_id, supplier_tax_condition,
    issue_date, received_date, due_date, payment_terms_days, returns_goods,
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
    coalesce((p_header->>'returns_goods')::boolean, false),
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

  return query select v_new_id, v_full_number;
end;
$$;

revoke all on function public.save_purchase_invoice(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.save_purchase_invoice(jsonb, jsonb, jsonb) to authenticated;


-- ===========================================================================
-- 7) Anular
-- ===========================================================================
-- En la fase 3 esta función además revierte el stock. Por ahora no hay stock
-- que revertir, porque solo se cargan conceptos.
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

  update purchase_invoices
     set status = 'ANULADA',
         voided_at = now(),
         voided_reason = trim(p_reason)
   where purchase_invoices.id = p_purchase_invoice_id;
end;
$$;

revoke all on function public.void_purchase_invoice(uuid, text) from public, anon;
grant execute on function public.void_purchase_invoice(uuid, text) to authenticated;


-- ===========================================================================
-- 8) Documentación del esquema
-- ===========================================================================
comment on column purchase_invoices.signed_total is
  'Negativo en notas de crédito. Permite que el saldo de un proveedor sea una '
  'suma, sin case en cada consulta.';

comment on column purchase_invoices.settled_amount is
  'Importe cancelado. Se llama settled y no paid porque en una nota de '
  'crédito es aplicado, no pagado. Lo mueve el módulo de pagos.';

comment on column purchase_invoices.returns_goods is
  'Solo en notas de crédito de artículos: distingue la devolución de '
  'mercadería (resta stock) del ajuste de precio (no lo toca). Lo usa la fase 3.';

comment on index purchase_invoices_sin_duplicados is
  'Cargar dos veces la misma factura duplica la deuda y el stock. Parcial '
  'sobre las vigentes: anular una mal tipeada libera la combinación.';
