-- DieselPro ERP — cargo organizativo de cada usuario del sistema
--
-- ⚠️ YA APLICADO en el proyecto Supabase "Ludiesel". Queda como registro
-- del esquema.
--
-- Antes solo existía profiles.role ('admin' | 'operario'), sin manera de
-- distinguir entre los distintos tipos de admin (dueño, administrativo) ni
-- de definir el cargo desde ninguna pantalla — se editaba a mano.
--
-- position es puramente organizativo/informativo: NO reemplaza role, que
-- sigue siendo lo único que is_admin() y todas las políticas RLS del
-- sistema miran. administrativo y dueño mapean los dos a role='admin' —
-- mismo nivel de acceso total, solo cambia el cargo que se muestra en la
-- pantalla de Usuarios (antes "Empleados"). Lo mantiene sincronizado la
-- Edge Function gestionar-empleado (única vía de escritura sobre profiles;
-- no hay política de UPDATE para el cliente, ver "users read own profile").
alter table profiles add column position text not null default 'operario';
alter table profiles add constraint profiles_position_check
  check (position in ('operario', 'administrativo', 'dueño'));

-- Backfill: el único admin existente al momento de esta migración pasa a
-- "dueño" (es el dueño real del taller, no un administrativo contratado).
update profiles set position = 'dueño' where role = 'admin';

-- La única política de SELECT que existía ("users read own profile",
-- auth.uid() = id) dejaba a un admin ver su propio cargo pero no el de
-- ningún otro usuario en la lista de Usuarios (mismo límite preexistente
-- que ya hacía que el email de otros empleados apareciera vacío). Se agrega
-- una segunda política: is_admin() es security definer, así que su consulta
-- interna a profiles no pasa por esta misma política (sin recursión), igual
-- patrón que ya usan las políticas de articles/suppliers/etc.
create policy "admin read all profiles" on profiles for select using (is_admin());
