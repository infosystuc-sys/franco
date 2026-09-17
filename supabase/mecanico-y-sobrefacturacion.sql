-- ===========================================================================
-- El mecánico de la OT y su cuenta corriente
-- ===========================================================================
-- Migración: mecanico_y_sobrefacturacion
--
-- El mecánico cobra por sobrefacturación: al cotizar se define un monto (o un
-- porcentaje) que se reparte DENTRO de los precios de los renglones de la OT.
-- El cliente ve precios más altos y ninguna línea delata el recargo; la
-- diferencia es lo que le queda al mecánico.
--
-- Decisiones tomadas con el taller:
--   · El mecánico es un campo aparte del empleado que toma la orden: el que
--     recibe el vehículo no siempre es el que hace el trabajo.
--   · Se acredita al FACTURAR la OT, no al cotizar ni al cobrar. Anular la
--     factura revierte la acreditación.
--   · Lo ve solo un admin. Un renglón inflado a la vista de todos se comenta.

-- ---------------------------------------------------------------------------
-- 1. El mecánico y el recargo, en la orden
-- ---------------------------------------------------------------------------
alter table work_orders
  add column if not exists mechanic_id uuid references employees(id),
  add column if not exists overbill_amount numeric(14,2) not null default 0;

comment on column work_orders.mechanic_id is
  'Quién hace el trabajo y cobra la sobrefacturación. Distinto de employee_id, que es quien tomó la orden.';
comment on column work_orders.overbill_amount is
  'Monto ya repartido dentro de los precios de los renglones. Es lo que se le acredita al mecánico al facturar.';

alter table work_orders
  drop constraint if exists work_orders_overbill_no_negativo;
alter table work_orders
  add constraint work_orders_overbill_no_negativo check (overbill_amount >= 0);

-- ---------------------------------------------------------------------------
-- 2. La cuenta corriente del mecánico
-- ---------------------------------------------------------------------------
-- Un solo libro por mecánico: lo que se le devengó por sobrefacturación y lo
-- que se le pagó. El saldo es la suma — positivo es lo que se le debe.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'mechanic_entry_kind') then
    create type mechanic_entry_kind as enum ('SOBREFACTURACION', 'PAGO', 'AJUSTE');
  end if;
end $$;

create table if not exists mechanic_account_entries (
  id uuid primary key default gen_random_uuid(),
  mechanic_id uuid not null references employees(id),
  kind mechanic_entry_kind not null,
  -- Firmado: la sobrefacturación suma, el pago resta. Así el saldo es un
  -- sum() y no hay que acordarse del signo en cada consulta.
  amount numeric(14,2) not null,
  entry_date date not null default current_date,
  work_order_id uuid references work_orders(id),
  invoice_id uuid references invoices(id),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint mechanic_entry_signo check (
    (kind = 'SOBREFACTURACION' and amount > 0)
    or (kind = 'PAGO' and amount < 0)
    or kind = 'AJUSTE'
  )
);

-- Una factura acredita UNA sola vez, por más que el trigger se dispare de
-- nuevo: sin esto, reprocesar una factura le duplicaría el beneficio.
create unique index if not exists mechanic_entries_una_por_factura
  on mechanic_account_entries (invoice_id)
  where kind = 'SOBREFACTURACION' and invoice_id is not null;

create index if not exists mechanic_entries_por_mecanico
  on mechanic_account_entries (mechanic_id, entry_date);

alter table mechanic_account_entries enable row level security;

-- Solo admin: son pagos a personas y renglones inflados.
drop policy if exists "admin lee cuentas de mecanicos" on mechanic_account_entries;
create policy "admin lee cuentas de mecanicos"
on mechanic_account_entries for select to authenticated
using (public.is_admin());

-- Se escribe solo por las funciones de abajo (security definer), nunca directo.
revoke all on mechanic_account_entries from anon, authenticated;
