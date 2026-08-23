-- DieselPro ERP — tesorería, fase 1: medios de pago
--
-- Aplicar en el SQL Editor de Supabase. Este archivo queda además como
-- registro del esquema, igual que el resto de supabase/*.sql.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-23-tesoreria-design.md
--
-- Esta fase no registra ningún movimiento todavía: deja el padrón de medios
-- de pago con su saldo inicial. Los movimientos llegan en la fase 2 y los
-- cheques de terceros en la fase 3.


-- ===========================================================================
-- 1) Tipos
-- ===========================================================================
-- El tipo NO es decorativo: decide el comportamiento del medio.
--
--   EFECTIVO         cajas. El saldo sale de las partidas.
--   BANCO            cuentas bancarias. Único tipo que puede recibir el
--                    depósito de un cheque.
--   CARTERA_CHEQUES  los cheques de terceros en mano. Su saldo sale de los
--                    cheques que siguen en cartera, no de partidas sueltas.
--
-- Sin tipo, nada impediría depositar un cheque en la caja chica.
create type payment_method_kind as enum ('EFECTIVO', 'BANCO', 'CARTERA_CHEQUES');


-- ===========================================================================
-- 2) Medios de pago
-- ===========================================================================
create table payment_methods (
  id uuid primary key default gen_random_uuid(),
  kind payment_method_kind not null,
  name text not null unique,

  -- Solo en los de tipo banco.
  bank_name text,
  account_number text,
  cbu text,

  -- Punto de partida del saldo. El saldo NO se guarda: se calcula como este
  -- importe más la suma de las partidas del medio. Un saldo en columna miente
  -- en cuanto algo falla a mitad de camino, y después nadie sabe cuál de los
  -- dos números es el bueno.
  opening_balance numeric(14,2) not null default 0,
  opening_date date not null default current_date,

  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Los datos bancarios solo tienen sentido en una cuenta bancaria.
  constraint payment_methods_banco_coherente check (
    kind = 'BANCO'
    or (bank_name is null and account_number is null and cbu is null)
  ),

  -- La cartera arranca siempre en cero: los cheques que ya estén en mano se
  -- cargan como cheques, no como saldo inicial. Un importe suelto acá sería
  -- un saldo que no se corresponde con ningún valor real.
  constraint payment_methods_cartera_sin_saldo_inicial check (
    kind <> 'CARTERA_CHEQUES' or opening_balance = 0
  )
);

-- Una sola cartera de cheques. Con dos, un cheque no sabría a cuál pertenece
-- y el módulo de cheques tendría que preguntarlo en cada operación sin
-- ninguna ganancia. Si algún día hacen falta varias, se borra este índice.
create unique index payment_methods_una_cartera
  on payment_methods (kind) where kind = 'CARTERA_CHEQUES';

create index payment_methods_kind_idx on payment_methods (kind) where active;

create trigger payment_methods_set_updated_at
before update on payment_methods
for each row execute function set_updated_at();


-- ===========================================================================
-- 3) Padrón inicial
-- ===========================================================================
-- Las tres que existen en cualquier taller. La cuenta bancaria NO se siembra:
-- depende del banco de cada uno, y un placeholder terminaría copiado a los
-- movimientos sin que nadie lo revise.
--
-- "Transferencia recibida" y "transferencia propia" no aparecen acá a
-- propósito: no son medios de pago sino la dirección de un movimiento sobre
-- una cuenta bancaria. La plata que entra y la que sale de la misma cuenta
-- comparten saldo; separarlas daría dos saldos que nunca cerrarían contra el
-- extracto del banco.
insert into payment_methods (kind, name) values
  ('EFECTIVO',        'Caja'),
  ('EFECTIVO',        'Caja Chica'),
  ('CARTERA_CHEQUES', 'Cheques de terceros');


-- ===========================================================================
-- 4) RLS
-- ===========================================================================
-- Solo admin, igual que compras y facturación: es información de dinero y
-- quien repara no la necesita.
alter table payment_methods enable row level security;

create policy "solo admin" on payment_methods for select to authenticated using (is_admin());
create policy "admin insert" on payment_methods for insert with check (is_admin());
create policy "admin update" on payment_methods for update using (is_admin()) with check (is_admin());
create policy "admin delete" on payment_methods for delete using (is_admin());


comment on column payment_methods.kind is
  'Decide el comportamiento del medio: solo BANCO puede recibir el depósito '
  'de un cheque, y el saldo de CARTERA_CHEQUES sale de los cheques en '
  'cartera, no de partidas sueltas.';

comment on column payment_methods.opening_balance is
  'Punto de partida del saldo. El saldo no se guarda: se calcula como este '
  'importe más la suma de las partidas del medio.';
