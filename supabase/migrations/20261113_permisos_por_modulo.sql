-- Usuarios: qué módulos puede usar cada administrativo.
--
-- Hasta ahora había tres accesos fijos: admin (todo), operario (sus órdenes)
-- y contador (informes impositivos). Para poner el sistema en el taller hace
-- falta acotar a los empleados administrativos: uno que factura y cobra, otro
-- que solo carga compras, etc.
--
-- profiles.modulos guarda las pantallas habilitadas (la ruta de cada tarjeta
-- del menú, como '/facturas' o '/informe/libro-caja'). null = todo el sistema,
-- que es como quedan todos los usuarios de hoy. Solo cuenta para role 'admin':
-- operario y contador siguen con su acceso de siempre.
--
-- Es un permiso de pantalla: el menú no muestra lo que no tiene habilitado y
-- la pantalla no se abre aunque se escriba la dirección. Los datos siguen
-- protegidos por las políticas de cada tabla, que son las de admin.

alter table public.profiles add column if not exists modulos text[];

comment on column public.profiles.modulos is
  'Pantallas habilitadas (rutas del menú). null = todo el sistema. Solo aplica a role admin.';

-- La escritura pasa por esta función: profiles no tiene política de update, y
-- así se controla que solo alguien con acceso total reparta permisos (si no,
-- un usuario con acceso a Usuarios podría habilitarse lo que no tiene).
create or replace function public.definir_modulos(p_employee_id uuid, p_modulos text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile uuid;
begin
  if not exists (
    select 1 from profiles where id = auth.uid() and role = 'admin' and modulos is null
  ) then
    raise exception 'Solo un usuario con acceso a todo el sistema puede definir qué módulos usa cada uno.';
  end if;

  select profile_id into v_profile from employees where id = p_employee_id;
  if v_profile is null then
    raise exception 'Ese empleado todavía no tiene usuario para entrar al sistema.';
  end if;

  if v_profile = auth.uid() then
    raise exception 'No podés cambiar tus propios permisos. Pedíselo a otro usuario con acceso total.';
  end if;

  if p_modulos is not null and cardinality(p_modulos) = 0 then
    raise exception 'Elegí al menos un módulo.';
  end if;

  update profiles set modulos = p_modulos where id = v_profile;
end;
$$;

revoke all on function public.definir_modulos(uuid, text[]) from public, anon;
grant execute on function public.definir_modulos(uuid, text[]) to authenticated;

notify pgrst, 'reload schema';
