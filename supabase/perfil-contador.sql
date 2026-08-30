-- ===========================================================================
-- Perfil contador: solo lectura sobre libros de IVA y reportes fiscales
-- ===========================================================================
-- Migración: perfil_contador
--
-- Tercer rol de acceso, además de admin/operario. No es un cargo más con el
-- mismo nivel que administrativo/dueño (esos son 'admin' con otra etiqueta):
-- contador es su propio rol, sin ningún permiso de escritura, acotado a las
-- tablas que alimentan los informes impositivos (Libro IVA Ventas, Libro IVA
-- Compras, Retenciones sufridas y practicadas).
--
-- La asignación del rol pasa por la misma Edge Function gestionar-empleado
-- que ya arma admin/operario (cargo 'contador' -> role 'contador'); acá solo
-- se habilita el valor en la base y se abre la lectura donde corresponde.

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'operario', 'contador'));

-- profiles.position (el "Cargo" que se ve en Usuarios) tiene su propia
-- constraint, separada de role — gestionar-empleado escribe ahí el cargo tal
-- cual, así que también necesita admitir 'contador'.
alter table public.profiles drop constraint profiles_position_check;
alter table public.profiles add constraint profiles_position_check
  check ("position" = any (array['operario'::text, 'administrativo'::text, 'dueño'::text, 'contador'::text]));

create or replace function public.is_contador()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'contador'
  );
$$;

-- Una política nueva por tabla, sumada a la que ya dice "solo admin" — RLS
-- combina las políticas permisivas del mismo comando con OR, así que esto no
-- toca ni reemplaza la política existente.
create policy "contador lee" on public.invoices for select using (is_contador());
create policy "contador lee" on public.purchase_invoices for select using (is_contador());
create policy "contador lee" on public.receipts for select using (is_contador());
create policy "contador lee" on public.receipt_values for select using (is_contador());
create policy "contador lee" on public.payment_orders for select using (is_contador());
create policy "contador lee" on public.payment_order_values for select using (is_contador());
create policy "contador lee" on public.tax_rates for select using (is_contador());
create policy "contador lee" on public.suppliers for select using (is_contador());
