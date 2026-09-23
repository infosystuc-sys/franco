-- ===========================================================================
-- Notas de crédito electrónicas
-- ===========================================================================
-- Migración sugerida: notas_de_credito
--
-- Fase 5 del plan de ARCA, y la que faltaba para que el circuito fiscal cierre.
--
-- Hasta hoy "anular" una factura le cambiaba un estado y nada más. Para la
-- serie interna X eso alcanza: no es fiscal, no existe para nadie más. Para
-- una factura con CAE es una ficción: ARCA la tiene, va en el Libro IVA
-- Ventas, y lo único que la revierte es una nota de crédito con su propio CAE.
--
-- ── Por qué tabla propia y no un tipo más en invoices ──────────────────────
-- Del lado de compras las NC viven en purchase_invoices con un doc_type y un
-- signo. Acá no conviene: invoices lo leen ocho funciones, las cobranzas, los
-- reportes y la pantalla de facturación, y todas dan por sentado que cada fila
-- es algo que el cliente debe. Meterle filas negativas obliga a revisar cada
-- una de esas suposiciones. Una tabla propia deja esas ocho intactas y
-- concentra el efecto en un solo lugar: credited_amount.
--
-- ── Cómo afecta la cuenta corriente ────────────────────────────────────────
-- invoices.credited_amount, y el saldo pasa a ser
--     total - cobrado - acreditado
--
-- NO se suma a paid_amount, que sería más corto de escribir: paid_amount es
-- plata que entró, la miran los reportes de cobranza y el arqueo. Una nota de
-- crédito no es plata que entró, es deuda que dejó de existir. Mezclarlas
-- haría que los reportes informen ingresos que nunca ocurrieron.

-- ---------------------------------------------------------------------------
-- 1. La numeración
-- ---------------------------------------------------------------------------
-- Aparte de invoice_sequences: para ARCA la NC A es el comprobante tipo 3 y la
-- factura A el tipo 1, y cada tipo lleva su propio correlativo en el mismo
-- punto de venta. Compartir el contador haría que ARCA rechace por salteo.
create table if not exists credit_note_sequences (
  invoice_type invoice_type not null,
  sales_point int not null,
  last_number int not null default 0,
  primary key (invoice_type, sales_point)
);

alter table credit_note_sequences enable row level security;

-- ---------------------------------------------------------------------------
-- 2. La nota de crédito
-- ---------------------------------------------------------------------------
create table if not exists credit_notes (
  id uuid primary key default gen_random_uuid(),

  -- El comprobante de referencia. Obligatorio: toda NC de este taller revierte
  -- una factura concreta, y de ahí salen el cliente, la letra y el punto de
  -- venta. Sin él habría que elegir todo a mano y nada garantizaría que la NC
  -- sea de la misma letra que lo que revierte.
  invoice_id uuid not null references invoices(id) on delete restrict,

  invoice_type invoice_type not null,
  sales_point int not null,
  number int not null check (number > 0),
  full_number text generated always as (
    lpad(sales_point::text, greatest(4, length(sales_point::text)), '0')
    || '-' || lpad(number::text, 8, '0')
  ) stored,
  status invoice_status not null default 'PENDIENTE_CAE',

  /* Si revierte la factura entera. Se guarda en vez de deducirlo de los
     importes: una NC parcial puede dar justo el total de la factura por
     coincidencia, y no es lo mismo que haberla cancelado. */
  cancela_total boolean not null default false,

  customer_id uuid not null references customers(id) on delete restrict,

  -- Copia congelada, igual que en la factura: el comprobante no cambia si
  -- después se edita el padrón.
  customer_name text not null,
  customer_legal_name text,
  customer_tax_id text,
  customer_tax_condition text not null,
  customer_address text,

  issuer_legal_name text not null,
  issuer_tax_id text,
  issuer_tax_condition text not null,
  issuer_address text,
  issuer_gross_income text,
  issuer_activity_start_date date,

  issue_date date not null default current_date,

  net_amount numeric(14,2) not null check (net_amount >= 0),
  vat_amount numeric(14,2) not null check (vat_amount >= 0),
  total_amount numeric(14,2) not null check (total_amount > 0),

  motivo text,

  cae text,
  cae_due_date date,
  cae_simulated boolean not null default false,
  cae_rechazo text,
  cae_rechazado_at timestamptz,

  voided_at timestamptz,
  voided_reason text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (invoice_type, sales_point, number),

  constraint credit_notes_anulada_con_motivo check (
    (status = 'ANULADA' and voided_at is not null and voided_reason is not null)
    or (status in ('PENDIENTE_CAE', 'EMITIDA') and voided_at is null and voided_reason is null)
  ),
  constraint credit_notes_pendiente_sin_cae check (
    status <> 'PENDIENTE_CAE' or (cae is null and cae_due_date is null)
  )
);

create index if not exists credit_notes_invoice_idx on credit_notes (invoice_id);
create index if not exists credit_notes_customer_idx on credit_notes (customer_id);
create index if not exists credit_notes_status_idx on credit_notes (status);

create table if not exists credit_note_items (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references credit_notes(id) on delete cascade,
  article_id uuid references articles(id) on delete set null,
  code text,
  description text not null,
  quantity numeric(14,2) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  subtotal numeric(14,2) not null check (subtotal >= 0),
  line_number int not null
);

create index if not exists credit_note_items_nc_idx on credit_note_items (credit_note_id);

-- Se leen con las mismas reglas que las facturas: admin y contador.
alter table credit_notes enable row level security;
alter table credit_note_items enable row level security;

drop policy if exists "solo admin" on credit_notes;
drop policy if exists "contador lee" on credit_notes;
create policy "solo admin" on credit_notes for select to authenticated using (is_admin());
create policy "contador lee" on credit_notes for select using (is_contador());

drop policy if exists "solo admin" on credit_note_items;
drop policy if exists "contador lee" on credit_note_items;
create policy "solo admin" on credit_note_items for select to authenticated using (is_admin());
create policy "contador lee" on credit_note_items for select using (is_contador());

create trigger credit_notes_set_updated_at
before update on credit_notes
for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Lo acreditado, en la factura
-- ---------------------------------------------------------------------------
alter table invoices
  add column if not exists credited_amount numeric(14,2) not null default 0
    check (credited_amount >= 0);

comment on column invoices.credited_amount is
  'Cuánto de esta factura revirtieron notas de crédito ya emitidas. El saldo '
  'es total_amount - paid_amount - credited_amount.';

-- Lo mantiene un disparador y no quien emite: así da igual por qué camino se
-- creó, se autorizó o se abandonó una NC, el número siempre cuadra con las
-- notas que existen de verdad.
create or replace function public._recalcular_acreditado()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update invoices i
     set credited_amount = coalesce((
       select sum(nc.total_amount) from credit_notes nc
        where nc.invoice_id = v_invoice and nc.status = 'EMITIDA'
     ), 0)
   where i.id = v_invoice;
  return null;
end;
$$;

drop trigger if exists credit_notes_recalcular_acreditado on credit_notes;
create trigger credit_notes_recalcular_acreditado
after insert or update or delete on credit_notes
for each row execute function public._recalcular_acreditado();

-- ---------------------------------------------------------------------------
-- 4. Emitir la nota de crédito
-- ---------------------------------------------------------------------------
-- Nace en PENDIENTE_CAE igual que la factura y por la misma razón: pedirle el
-- CAE a ARCA es una llamada a un tercero que no puede vivir adentro de esta
-- transacción.
create or replace function public.emitir_nota_credito(
  p_invoice_id uuid,
  p_items jsonb,
  p_cancela_total boolean,
  p_motivo text default null
)
returns table(credit_note_id uuid, credit_note_full_number text, credit_note_letter invoice_type)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_invoice invoices%rowtype;
  v_company company_settings%rowtype;
  v_number int;
  v_net numeric(14,2);
  v_vat numeric(14,2);
  v_disponible numeric(14,2);
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

  -- La serie interna no es fiscal: se sigue anulando como siempre.
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

  select * into v_company from company_settings where company_settings.id = true;

  select round(coalesce(sum(
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  ), 0), 2)
  into v_net
  from jsonb_array_elements(p_items) as item;

  if v_net <= 0 then
    raise exception 'El total de la nota de crédito tiene que ser mayor a cero.';
  end if;

  v_vat := case when v_invoice.invoice_type = 'C' then 0 else round(v_net * 0.21, 2) end;

  -- No se puede acreditar más de lo que la factura todavía sostiene. Si no,
  -- el cliente terminaría con saldo a favor salido de la nada.
  v_disponible := v_invoice.total_amount - v_invoice.credited_amount;
  if v_net + v_vat > v_disponible then
    raise exception
      'La factura % admite hasta $ % de nota de crédito y estás emitiendo $ %.',
      v_invoice.full_number, v_disponible, v_net + v_vat;
  end if;

  insert into credit_note_sequences (invoice_type, sales_point, last_number)
  values (v_invoice.invoice_type, v_invoice.sales_point, 1)
  on conflict (invoice_type, sales_point)
    do update set last_number = credit_note_sequences.last_number + 1
  returning credit_note_sequences.last_number into v_number;

  insert into credit_notes (
    invoice_id, invoice_type, sales_point, number, status, cancela_total,
    customer_id, customer_name, customer_legal_name, customer_tax_id,
    customer_tax_condition, customer_address,
    issuer_legal_name, issuer_tax_id, issuer_tax_condition, issuer_address,
    issuer_gross_income, issuer_activity_start_date,
    issue_date, net_amount, vat_amount, total_amount, motivo, created_by
  )
  values (
    v_invoice.id, v_invoice.invoice_type, v_invoice.sales_point, v_number,
    'PENDIENTE_CAE', coalesce(p_cancela_total, false),
    v_invoice.customer_id, v_invoice.customer_name, v_invoice.customer_legal_name,
    v_invoice.customer_tax_id, v_invoice.customer_tax_condition, v_invoice.customer_address,
    -- El emisor se copia de la factura, no de company_settings: la NC tiene que
    -- salir a nombre de quien emitió el comprobante que revierte, aunque desde
    -- entonces hayan cambiado los datos del taller.
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

revoke all on function public.emitir_nota_credito(uuid, jsonb, boolean, text) from public, anon;
grant execute on function public.emitir_nota_credito(uuid, jsonb, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. El CAE de la nota de crédito
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
  v_status invoice_status;
  v_cae text := trim(coalesce(p_cae, ''));
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

  select status into v_status from credit_notes where id = p_credit_note_id for update;
  if not found then
    raise exception 'La nota de crédito no existe.';
  end if;
  if v_status <> 'PENDIENTE_CAE' then
    raise exception 'La nota de crédito no está esperando un CAE: está %.', v_status;
  end if;

  update credit_notes
     set status = 'EMITIDA', cae = v_cae, cae_due_date = p_cae_due_date,
         cae_rechazo = null, cae_rechazado_at = null
   where id = p_credit_note_id;
end;
$$;

create or replace function public.registrar_rechazo_cae_nc(
  p_credit_note_id uuid,
  p_motivo text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'No autorizado.';
  end if;

  update credit_notes
     set cae_rechazo = nullif(trim(coalesce(p_motivo, '')), ''),
         cae_rechazado_at = now()
   where id = p_credit_note_id and status = 'PENDIENTE_CAE';
end;
$$;

revoke all on function public.confirmar_cae_nc(uuid, text, date) from public, anon;
grant execute on function public.confirmar_cae_nc(uuid, text, date) to authenticated;
revoke all on function public.registrar_rechazo_cae_nc(uuid, text) from public, anon;
grant execute on function public.registrar_rechazo_cae_nc(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Anular deja de valer para las fiscales
-- ---------------------------------------------------------------------------
-- El agregado es el bloque del CAE. Lo demás es el cuerpo que ya estaba.
create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Una factura que ARCA autorizó no se borra del mundo cambiándole un estado
  -- acá adentro: existe en el Libro IVA Ventas y se revierte con una nota de
  -- crédito. Las pendientes sí se abandonan, porque ARCA nunca las conoció.
  if v_invoice.cae is not null and not v_invoice.cae_simulated then
    raise exception
      'La factura % tiene CAE de ARCA y no se puede anular: hay que emitirle una nota de crédito.',
      v_invoice.full_number;
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

  update remitos
  set status = 'ANULADO',
      voided_at = now(),
      voided_reason = 'Se anuló la factura ' || v_invoice.full_number
  where remitos.invoice_id = p_invoice_id and remitos.status = 'EMITIDO';
end;
$function$;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
    where table_name in ('credit_notes', 'credit_note_items', 'credit_note_sequences')) as tablas,
  (select count(*) from information_schema.columns
    where table_name = 'invoices' and column_name = 'credited_amount') as columna_acreditado,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('emitir_nota_credito', 'confirmar_cae_nc', 'registrar_rechazo_cae_nc')) as funciones;
