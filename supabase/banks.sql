-- ===========================================================================
-- Catálogo de bancos: código + nombre, para buscar al cargar un cheque
-- ===========================================================================
-- Migración: banks
--
-- El banco de un cheque siempre se guardó como texto libre (checkBank /
-- check_bank / bank_name en third_party_checks, receipt_values y
-- payment_order_values) — eso no cambia acá, evita tocar tres tablas y todo
-- lo que ya está cargado. Lo que se agrega es un catálogo propio para que el
-- campo de banco tenga sugerencias por código o nombre en vez de ser un
-- input en blanco: al elegir una sugerencia, lo que se guarda en el cheque
-- sigue siendo el nombre en texto, como siempre.
--
-- Arranca vacío a propósito: los códigos de banco (BCRA) son un dato real
-- que el taller tiene que cargar él mismo — no se siembra ninguno acá para
-- no arriesgar un código equivocado en la base de un cliente real. El
-- admin los agrega desde el propio selector, con un "+ agregar banco"
-- inline la primera vez que necesita uno que todavía no está.

create table public.banks (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.banks enable row level security;

create policy "solo admin" on public.banks for select using (is_admin());
create policy "admin insert" on public.banks for insert with check (is_admin());
create policy "admin update" on public.banks for update using (is_admin()) with check (is_admin());
create policy "admin delete" on public.banks for delete using (is_admin());
