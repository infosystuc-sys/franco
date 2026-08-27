-- DieselPro ERP — rediseño del alta de usuarios: contraseña inicial
-- compartida + cambio forzado, y lugar de trabajo del operario
--
-- ⚠️ YA APLICADO en el proyecto Supabase "Ludiesel". Queda como registro
-- del esquema.
--
-- El alta pasa a ser en un solo paso: todo usuario nuevo se crea con
-- contraseña "1234" (ver gestionar-empleado), y tiene que cambiarla en el
-- primer ingreso. RequireAuth.tsx bloquea cualquier ruta interna mientras
-- must_change_password sea true — no hay forma de saltear esa pantalla más
-- que cerrar sesión.

alter table profiles add column must_change_password boolean not null default true;

-- Los usuarios que ya existían no tienen contraseña 1234 (la eligieron a
-- mano), así que no hace falta obligarlos a cambiarla.
update profiles set must_change_password = false;

-- Único punto de escritura que un usuario común puede tocar en su propio
-- profile: apagar su propio flag después de cambiar la contraseña. No
-- existe (ni debe existir) una política de UPDATE genérica sobre profiles
-- para el cliente — el resto (role, position) sigue siendo solo-servidor.
create or replace function public.mark_password_changed()
returns void
language sql
security definer
set search_path to 'public'
as $$
  update profiles set must_change_password = false where id = auth.uid();
$$;

revoke all on function public.mark_password_changed() from public;
grant execute on function public.mark_password_changed() to authenticated;

-- Lugar de trabajo del operario (Laboratorio 1, Laboratorio 2, Playa).
-- Nullable y solo tiene sentido cuando el cargo es operario: no se fuerza a
-- nivel de constraint porque no vale la pena una regla cruzada solo para
-- esto, se resuelve en la pantalla (Users.tsx / gestionar-empleado).
alter table employees add column workplace text;
alter table employees add constraint employees_workplace_check
  check (workplace is null or workplace in ('Laboratorio 1', 'Laboratorio 2', 'Playa'));
