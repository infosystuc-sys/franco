-- DieselPro ERP — autenticación y roles
--
-- ⚠️ YA APLICADO en el proyecto Supabase "ludiesel". Este archivo queda como
-- registro del esquema; volver a ejecutarlo dará errores de "already exists".
-- Solo es necesario si algún día se levanta el proyecto desde cero.
--
-- Orden de ejecución en una base vacía: schema.sql → auth.sql → articles.sql

-- 1) Perfiles: guardan el rol de cada usuario de Supabase Auth.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'operario' check (role in ('admin', 'operario')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "users read own profile" on profiles
  for select using (auth.uid() = id);

-- 2) Al crear un usuario nuevo (desde Authentication > Users), se le crea
-- automáticamente un perfil con rol "operario".
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, role) values (new.id, new.email, 'operario');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- 3) Helper para las políticas: ¿el usuario logueado es admin?
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- 4) Reemplazar las políticas abiertas de schema.sql: la lectura se
-- mantiene pública (la necesita el Portal de Cliente, sin login), pero
-- crear/editar/borrar pasa a requerir rol admin.
drop policy "public full access" on customers;
drop policy "public full access" on vehicles;
drop policy "public full access" on technicians;
drop policy "public full access" on work_orders;
drop policy "public full access" on work_order_items;

create policy "read all" on customers for select using (true);
create policy "admin insert" on customers for insert with check (is_admin());
create policy "admin update" on customers for update using (is_admin()) with check (is_admin());
create policy "admin delete" on customers for delete using (is_admin());

create policy "read all" on vehicles for select using (true);
create policy "admin insert" on vehicles for insert with check (is_admin());
create policy "admin update" on vehicles for update using (is_admin()) with check (is_admin());
create policy "admin delete" on vehicles for delete using (is_admin());

create policy "read all" on technicians for select using (true);
create policy "admin insert" on technicians for insert with check (is_admin());
create policy "admin update" on technicians for update using (is_admin()) with check (is_admin());
create policy "admin delete" on technicians for delete using (is_admin());

create policy "read all" on work_orders for select using (true);
create policy "admin insert" on work_orders for insert with check (is_admin());
create policy "admin update" on work_orders for update using (is_admin()) with check (is_admin());
create policy "admin delete" on work_orders for delete using (is_admin());

create policy "read all" on work_order_items for select using (true);
create policy "admin insert" on work_order_items for insert with check (is_admin());
create policy "admin update" on work_order_items for update using (is_admin()) with check (is_admin());
create policy "admin delete" on work_order_items for delete using (is_admin());

-- 5) Para promover un usuario a admin (corré esto por cada admin, después
-- de haberlo creado en Authentication > Users):
-- update profiles set role = 'admin' where email = 'tu-email@ejemplo.com';
