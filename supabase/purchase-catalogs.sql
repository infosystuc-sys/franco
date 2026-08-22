-- DieselPro ERP — compras, fase 1: padrones
--
-- Aplicar en el SQL Editor de Supabase. Este archivo queda además como
-- registro del esquema, igual que el resto de supabase/*.sql.
--
-- Orden en una base vacía: schema.sql → auth.sql → articles.sql →
--   quotations.sql → price-lists.sql → price-lists-functions.sql →
--   employees.sql → invoicing.sql → purchase-catalogs.sql
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-22-compras-design.md
--
-- Esta fase no registra ninguna compra todavía: deja los padrones que el
-- comprobante va a necesitar (alícuotas y conceptos) y el plazo de pago en
-- proveedores. Los comprobantes llegan en la fase 2.


-- ===========================================================================
-- 1) Alícuotas
-- ===========================================================================
-- Un solo padrón para todos los impuestos, discriminados por tipo:
--
--   IVA               se elige por renglón del comprobante.
--   PERCEPCION        la cobra el proveedor y viene impresa en su factura:
--                     va al pie y SUMA al total y a la deuda.
--   IMPUESTO_INTERNO  ídem, al pie y suma.
--   RETENCION         la practica el taller al PAGAR, no al comprar. Se
--                     define acá, pero la usa el módulo de pagos: no existe
--                     hasta que se paga.
create type tax_kind as enum ('IVA', 'PERCEPCION', 'IMPUESTO_INTERNO', 'RETENCION');

-- Sobre qué importe se aplica. No queda fijo a propósito: hay percepciones
-- sobre el neto y otras sobre el total con IVA. Clavarlo obligaría a corregir
-- el importe a mano en cada factura.
create type tax_base as enum ('NETO', 'TOTAL');

create table tax_rates (
  id uuid primary key default gen_random_uuid(),
  kind tax_kind not null,
  name text not null,
  rate numeric(6,3) not null check (rate >= 0 and rate <= 100),
  base tax_base not null default 'NETO',
  -- Provincia, para las de Ingresos Brutos. Null en las que no la tienen.
  jurisdiction text,
  -- Solo en las de IVA. Un renglón exento y uno gravado al 0% dan el mismo
  -- IVA —cero— pero NO van al mismo renglón del pie ni del Libro IVA
  -- Compras. Sin esta columna serían indistinguibles.
  vat_treatment text check (vat_treatment in ('GRAVADO', 'EXENTO', 'NO_GRAVADO')),
  active boolean not null default true,
  created_at timestamptz not null default now(),

  -- El IVA siempre declara tratamiento y se aplica sobre el neto del
  -- renglón; los demás impuestos no tienen tratamiento que declarar.
  constraint tax_rates_iva_coherente check (
    (kind = 'IVA' and vat_treatment is not null and base = 'NETO')
    or (kind <> 'IVA' and vat_treatment is null)
  ),

  unique (kind, name)
);

create index tax_rates_kind_idx on tax_rates (kind) where active;

-- La lista de IVA de AFIP. Se siembra porque es la lista legal, no una
-- suposición: son las alícuotas que existen y no cambian por taller.
insert into tax_rates (kind, name, rate, base, vat_treatment) values
  ('IVA', 'IVA 21%',    21,    'NETO', 'GRAVADO'),
  ('IVA', 'IVA 10,5%',  10.5,  'NETO', 'GRAVADO'),
  ('IVA', 'IVA 27%',    27,    'NETO', 'GRAVADO'),
  ('IVA', 'IVA 5%',      5,    'NETO', 'GRAVADO'),
  ('IVA', 'IVA 2,5%',    2.5,  'NETO', 'GRAVADO'),
  ('IVA', 'IVA 0%',      0,    'NETO', 'GRAVADO'),
  ('IVA', 'Exento',      0,    'NETO', 'EXENTO'),
  ('IVA', 'No gravado',  0,    'NETO', 'NO_GRAVADO');

-- Las percepciones NO se siembran: dependen de la provincia y del padrón en
-- que esté inscripto cada proveedor. Un valor inventado acá es peor que una
-- lista vacía, porque se copia a los comprobantes sin que nadie lo revise.

alter table tax_rates enable row level security;

-- Compras es información comercial: mismo criterio que proveedores y
-- cotizaciones, no la ve quien repara.
create policy "solo admin" on tax_rates for select to authenticated using (is_admin());
create policy "admin insert" on tax_rates for insert with check (is_admin());
create policy "admin update" on tax_rates for update using (is_admin()) with check (is_admin());
create policy "admin delete" on tax_rates for delete using (is_admin());


-- ===========================================================================
-- 2) Conceptos de gasto
-- ===========================================================================
-- Padrón chico para poder agrupar el gasto por tipo, que con texto libre puro
-- no se puede hacer nunca. El renglón del comprobante admite igual texto
-- libre cuando el gasto no encaja en ninguno.
create table expense_concepts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into expense_concepts (name) values
  ('Flete'),
  ('Energía eléctrica'),
  ('Gas'),
  ('Agua'),
  ('Teléfono e internet'),
  ('Alquiler'),
  ('Honorarios'),
  ('Seguros'),
  ('Combustible'),
  ('Mantenimiento e infraestructura'),
  ('Herramientas'),
  ('Librería y papelería');

alter table expense_concepts enable row level security;

create policy "solo admin" on expense_concepts for select to authenticated using (is_admin());
create policy "admin insert" on expense_concepts for insert with check (is_admin());
create policy "admin update" on expense_concepts for update using (is_admin()) with check (is_admin());
create policy "admin delete" on expense_concepts for delete using (is_admin());


-- ===========================================================================
-- 3) Plazo de pago del proveedor
-- ===========================================================================
-- De acá sale el vencimiento que se propone al cargar un comprobante, que
-- después se puede pisar. 0 = contado.
alter table suppliers
  add column payment_terms_days int not null default 30
    check (payment_terms_days >= 0 and payment_terms_days <= 365);

comment on column suppliers.payment_terms_days is
  'Plazo de pago en días. Propone el vencimiento al cargar un comprobante de '
  'compra; el comprobante guarda el suyo, así que cambiar esto no mueve la '
  'deuda ya registrada. 0 = contado.';

comment on column tax_rates.base is
  'Sobre qué importe se aplica. Hay percepciones sobre el neto y otras sobre '
  'el total con IVA; por eso no es un valor fijo.';

comment on column tax_rates.vat_treatment is
  'Solo en kind=IVA. Separa gravado de exento y no gravado, que dan el mismo '
  'IVA cero pero van a renglones distintos del pie y del Libro IVA Compras.';
