-- DieselPro ERP — módulo de facturación (sin ARCA)
--
-- Aplicar en el SQL Editor de Supabase. Este archivo queda además como
-- registro del esquema, igual que el resto de supabase/*.sql.
--
-- Orden en una base vacía: schema.sql → auth.sql → articles.sql →
--   quotations.sql → price-lists.sql → price-lists-functions.sql →
--   employees.sql → invoicing.sql
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-21-facturacion-design.md
--
-- Modelo:
--   La factura se emite desde una OT TERMINADA y es un registro CONGELADO:
--   guarda copia de los datos del cliente, del emisor y de los renglones. Si
--   mañana se corrige el CUIT del cliente o el precio de un artículo, el
--   comprobante ya emitido no se mueve.
--
--   Todas las facturas salen en cuenta corriente con vencimiento a 7 días.
--   No hay CAE ni código de barras: ARCA no está conectado. Pero la FORMA es
--   la que ARCA pide (tipo A/B/C, punto de venta, correlativo por tipo), así
--   que integrarlo después no obliga a renumerar ni a migrar lo emitido.


-- ===========================================================================
-- 1) Datos fiscales del taller (el emisor)
-- ===========================================================================
-- Una sola fila. El check sobre la primary key booleana es lo que lo
-- garantiza: solo existe el valor true, así que un segundo insert choca.
--
-- tax_condition va como text con check y no como el tipo enum que usan
-- customers: así este archivo no depende de cómo se llame ese tipo en la
-- base, y los snapshots de la factura pueden guardar el valor sin castear.

create table if not exists company_settings (
  id boolean primary key default true check (id),

  legal_name text not null,
  trade_name text,
  tax_id text,
  tax_condition text not null default 'RESPONSABLE_INSCRIPTO'
    check (tax_condition in ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL')),

  -- Punto de venta habilitado. Con ARCA tiene que coincidir con el que AFIP
  -- tenga dado de alta para el CUIT.
  sales_point int not null default 1 check (sales_point between 1 and 99999),

  gross_income text,             -- Ingresos Brutos
  activity_start_date date,      -- Inicio de actividades

  address_street text,
  address_city text,
  address_state text,
  address_zip text,

  phone text,
  email text,

  updated_at timestamptz not null default now()
);

-- El drop previo acompaña al "if not exists" de arriba: si la tabla ya
-- estaba, volver a correr este bloque no tiene que romperse por el trigger.
drop trigger if exists company_settings_set_updated_at on company_settings;
create trigger company_settings_set_updated_at
before update on company_settings
for each row execute function set_updated_at();

-- Fila inicial con datos a completar desde Configuración. Sin ella la
-- pantalla no tendría qué editar, y issue_invoice avisa que falta cargarla.
insert into company_settings (id, legal_name, tax_condition, sales_point)
values (true, '', 'RESPONSABLE_INSCRIPTO', 1)
on conflict (id) do nothing;

alter table company_settings enable row level security;

-- Solo admin, incluso para leer: son los datos fiscales del taller y van en
-- la cabecera de los comprobantes.
create policy "solo admin" on company_settings for select to authenticated using (is_admin());
create policy "admin update" on company_settings for update using (is_admin()) with check (is_admin());


-- ===========================================================================
-- 2) Numeración
-- ===========================================================================
create type invoice_type as enum ('A', 'B', 'C');
create type invoice_status as enum ('EMITIDA', 'ANULADA');

-- Correlativo independiente por letra y punto de venta.
--
-- Tabla y no sequence de Postgres a propósito: cuando entre ARCA hay que
-- poder SINCRONIZAR el correlativo con el último número que AFIP dé por
-- autorizado. Una secuencia no se deja corregir cómodamente; una fila sí.
create table invoice_sequences (
  invoice_type invoice_type not null,
  sales_point int not null,
  last_number int not null default 0 check (last_number >= 0),
  primary key (invoice_type, sales_point)
);

alter table invoice_sequences enable row level security;
create policy "solo admin" on invoice_sequences for select to authenticated using (is_admin());
-- Sin políticas de escritura: solo la escribe issue_invoice, que es security definer.


-- ===========================================================================
-- 3) Facturas
-- ===========================================================================
create table invoices (
  id uuid primary key default gen_random_uuid(),

  -- Identidad del comprobante
  invoice_type invoice_type not null,
  sales_point int not null,
  number int not null check (number > 0),
  -- El formato de ARCA: 0001-00000001
  full_number text generated always as (
    lpad(sales_point::text, 4, '0') || '-' || lpad(number::text, 8, '0')
  ) stored,
  status invoice_status not null default 'EMITIDA',

  -- Origen
  work_order_id uuid not null references work_orders(id) on delete restrict,
  customer_id uuid not null references customers(id) on delete restrict,

  -- Copia congelada del cliente: la factura no cambia si después se edita
  -- el padrón.
  customer_name text not null,
  customer_legal_name text,
  customer_tax_id text,
  customer_tax_condition text not null,
  customer_address text,

  -- Copia congelada del emisor, por lo mismo.
  issuer_legal_name text not null,
  issuer_tax_id text,
  issuer_tax_condition text not null,
  issuer_address text,
  issuer_gross_income text,
  issuer_activity_start_date date,

  -- Cuenta corriente. El vencimiento se congela al emitir: cambiar el plazo
  -- por defecto no debe mover las facturas ya emitidas.
  issue_date date not null default current_date,
  due_date date not null,
  payment_terms_days int not null default 7 check (payment_terms_days >= 0),

  net_amount numeric(14,2) not null check (net_amount >= 0),
  vat_amount numeric(14,2) not null check (vat_amount >= 0),
  total_amount numeric(14,2) not null check (total_amount >= 0),
  -- El enganche del módulo de cobranzas. El estado de cobro NO es un enum:
  -- se deriva de este importe contra total_amount (impaga / parcial /
  -- pagada), así cobranzas no obliga a migrar el tipo.
  paid_amount numeric(14,2) not null default 0 check (paid_amount >= 0),

  notes text,

  voided_at timestamptz,
  voided_reason text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (invoice_type, sales_point, number),

  -- Una factura anulada tiene que decir cuándo y por qué; una vigente, no.
  constraint invoices_anulada_con_motivo check (
    (status = 'ANULADA' and voided_at is not null and voided_reason is not null)
    or (status = 'EMITIDA' and voided_at is null and voided_reason is null)
  )
);

-- La regla "una OT, una factura", en la base y no en la interfaz.
-- Al ser parcial hace las dos cosas de una vez: impide facturar dos veces la
-- misma orden, y deja que anular la libere para refacturar.
create unique index invoices_una_activa_por_ot
  on invoices (work_order_id) where status = 'EMITIDA';

create index invoices_customer_idx on invoices (customer_id);
create index invoices_status_idx on invoices (status);
create index invoices_due_date_idx on invoices (due_date);

create trigger invoices_set_updated_at
before update on invoices
for each row execute function set_updated_at();


create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  -- Sirve para reportes, pero la factura no depende de que el artículo siga
  -- existiendo: es una copia, no una referencia viva.
  article_id uuid references articles(id) on delete set null,
  code text,
  description text not null,
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null check (unit_price >= 0),
  subtotal numeric not null check (subtotal >= 0),
  -- line_number y no "position": position es palabra con significado propio
  -- en Postgres, y no vale la pena discutir con el parser por el nombre de
  -- una columna.
  line_number int not null
);

create index invoice_items_invoice_idx on invoice_items (invoice_id, line_number);


-- ===========================================================================
-- 4) RLS
-- ===========================================================================
-- Lectura solo admin, igual que cotizaciones y proveedores: la facturación es
-- información comercial y quien repara no la necesita.
-- Sin políticas de escritura: se escribe solo por las RPCs de abajo.
alter table invoices enable row level security;
alter table invoice_items enable row level security;

create policy "solo admin" on invoices for select to authenticated using (is_admin());
create policy "solo admin" on invoice_items for select to authenticated using (is_admin());


-- ===========================================================================
-- 5) La letra del comprobante
-- ===========================================================================
-- El cruce estándar de AFIP entre la condición del emisor y la del cliente.
-- Está acá y no solo en el navegador porque es una decisión fiscal: la app es
-- un sitio estático y cualquiera puede llamar a la API con la anon key.
create or replace function public.invoice_type_for(
  p_issuer_condition text,
  p_customer_condition text
)
returns invoice_type
language sql
immutable
as $$
  select case
    -- Un monotributista o exento emite siempre C, sin IVA.
    when p_issuer_condition in ('MONOTRIBUTO', 'EXENTO') then 'C'::invoice_type
    -- Responsable inscripto: A solo contra otro inscripto (IVA discriminado).
    when p_customer_condition = 'RESPONSABLE_INSCRIPTO' then 'A'::invoice_type
    -- Contra consumidor final, monotributo o exento: B, con IVA incluido.
    else 'B'::invoice_type
  end;
$$;


-- ===========================================================================
-- 6) Emisión
-- ===========================================================================
-- Una sola transacción: si algo falla no queda ni factura a medias ni
-- correlativo consumido. Mismo patrón que convert_quotation_to_work_order.
--
-- p_items es el array de renglones tal como quedó en la pantalla (pueden
-- diferir de los de la OT: se permite ajustarlos antes de emitir). La letra,
-- el IVA y el número los decide esta función, no el navegador.
create or replace function public.issue_invoice(
  p_work_order_id uuid,
  p_items jsonb,
  p_notes text default null
)
-- Las columnas de retorno se llaman invoice_* y no id/full_number/invoice_type
-- a propósito: en plpgsql las columnas de un RETURNS TABLE son variables en
-- alcance, y un "id" suelto dentro de la función se resolvería como la
-- variable en vez de como la columna de la tabla.
returns table (invoice_id uuid, invoice_full_number text, invoice_letter invoice_type)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo work_orders%rowtype;
  v_customer customers%rowtype;
  v_company company_settings%rowtype;
  v_type invoice_type;
  v_number int;
  v_net numeric(14,2);
  v_vat numeric(14,2);
  v_terms int := 7;   -- cuenta corriente a 7 días: la regla del taller
  v_new_id uuid;
  v_full_number text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  -- for update: es lo que impide que un doble clic emita dos facturas.
  select * into v_wo from work_orders where work_orders.id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;
  if v_wo.status <> 'TERMINADO' then
    raise exception 'Solo se facturan órdenes terminadas (estado actual: %).', v_wo.status;
  end if;

  if exists (
    select 1 from invoices
    where invoices.work_order_id = p_work_order_id and invoices.status = 'EMITIDA'
  ) then
    raise exception 'La orden % ya tiene una factura emitida.', v_wo.number;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La factura no tiene renglones cargados.';
  end if;

  select * into v_company from company_settings where company_settings.id = true;
  if not found or coalesce(trim(v_company.legal_name), '') = '' then
    raise exception 'Cargá los datos fiscales del taller en Configuración antes de facturar.';
  end if;

  select * into v_customer from customers where customers.id = v_wo.customer_id;
  if not found then
    raise exception 'El cliente de la orden no existe.';
  end if;

  v_type := public.invoice_type_for(
    v_company.tax_condition,
    v_customer.tax_condition::text
  );

  -- Los renglones son NETOS (articles.unit_price lo es, ver price-lists.sql).
  select round(coalesce(sum(
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  ), 0), 2)
  into v_net
  from jsonb_array_elements(p_items) as item;

  if v_net <= 0 then
    raise exception 'El total de la factura tiene que ser mayor a cero.';
  end if;

  -- En C no hay IVA. En A se discrimina y en B va incluido, pero en ambas se
  -- guarda: ARCA lo pide también en la B, aunque no se imprima.
  v_vat := case when v_type = 'C' then 0 else round(v_net * 0.21, 2) end;

  -- Correlativo. El insert ... on conflict crea la fila la primera vez que se
  -- usa esa combinación de letra y punto de venta, y en ambos caminos deja la
  -- fila bloqueada hasta el commit.
  insert into invoice_sequences (invoice_type, sales_point, last_number)
  values (v_type, v_company.sales_point, 1)
  on conflict (invoice_type, sales_point)
    do update set last_number = invoice_sequences.last_number + 1
  returning invoice_sequences.last_number into v_number;

  insert into invoices (
    invoice_type, sales_point, number, status,
    work_order_id, customer_id,
    customer_name, customer_legal_name, customer_tax_id, customer_tax_condition, customer_address,
    issuer_legal_name, issuer_tax_id, issuer_tax_condition, issuer_address,
    issuer_gross_income, issuer_activity_start_date,
    issue_date, due_date, payment_terms_days,
    net_amount, vat_amount, total_amount,
    notes, created_by
  )
  values (
    v_type, v_company.sales_point, v_number, 'EMITIDA',
    p_work_order_id, v_wo.customer_id,
    v_customer.name, v_customer.legal_name, v_customer.tax_id,
    v_customer.tax_condition::text,
    nullif(concat_ws(', ',
      nullif(trim(coalesce(v_customer.address_street, '')), ''),
      nullif(trim(coalesce(v_customer.address_city, '')), ''),
      nullif(trim(coalesce(v_customer.address_state, '')), '')
    ), ''),
    v_company.legal_name, v_company.tax_id, v_company.tax_condition,
    nullif(concat_ws(', ',
      nullif(trim(coalesce(v_company.address_street, '')), ''),
      nullif(trim(coalesce(v_company.address_city, '')), ''),
      nullif(trim(coalesce(v_company.address_state, '')), '')
    ), ''),
    v_company.gross_income, v_company.activity_start_date,
    current_date, current_date + v_terms, v_terms,
    v_net, v_vat, v_net + v_vat,
    nullif(trim(coalesce(p_notes, '')), ''), auth.uid()
  )
  returning invoices.id, invoices.full_number into v_new_id, v_full_number;

  insert into invoice_items (invoice_id, article_id, code, description, quantity, unit_price, subtotal, line_number)
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

  return query select v_new_id, v_full_number, v_type;
end;
$$;

revoke all on function public.issue_invoice(uuid, jsonb, text) from public, anon;
grant execute on function public.issue_invoice(uuid, jsonb, text) to authenticated;


-- ===========================================================================
-- 7) Anulación
-- ===========================================================================
-- Sin nota de crédito: ARCA no está conectado, así que corregir es anular y
-- refacturar. El índice parcial invoices_una_activa_por_ot libera la OT sola.
--
-- La guarda de paid_amount es la que importa: sin ella, cobranzas heredaría
-- facturas anuladas con cobros imputados encima.
create or replace function public.void_invoice(
  p_invoice_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_invoice from invoices where invoices.id = p_invoice_id for update;
  if not found then
    raise exception 'La factura no existe.';
  end if;
  if v_invoice.status = 'ANULADA' then
    raise exception 'La factura % ya está anulada.', v_invoice.full_number;
  end if;
  if v_invoice.paid_amount > 0 then
    raise exception 'La factura % tiene cobros imputados por $ %. Revertí los cobros antes de anularla.',
      v_invoice.full_number, v_invoice.paid_amount;
  end if;

  update invoices
  set status = 'ANULADA',
      voided_at = now(),
      voided_reason = trim(p_reason)
  where invoices.id = p_invoice_id;
end;
$$;

revoke all on function public.void_invoice(uuid, text) from public, anon;
grant execute on function public.void_invoice(uuid, text) to authenticated;


-- ===========================================================================
-- 8) Documentación del esquema
-- ===========================================================================
-- Las decisiones que no se leen en el DDL quedan anotadas en la propia base,
-- para quien abra el esquema sin tener el diseño a mano.
comment on table company_settings is
  'Datos fiscales del emisor. Una sola fila. Se copian a cada factura al '
  'emitirla, así cambiarlos no altera los comprobantes ya emitidos.';

comment on column invoices.paid_amount is
  'Importe cobrado. El estado de cobro se deriva de acá contra total_amount '
  '(impaga / parcial / pagada), no de un enum. Lo mueve el módulo de cobranzas.';

comment on index invoices_una_activa_por_ot is
  'Una OT tiene como máximo una factura vigente. Al ser parcial, anular la '
  'factura libera la orden para refacturar.';
