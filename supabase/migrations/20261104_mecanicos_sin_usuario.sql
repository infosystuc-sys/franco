-- Mecánicos: personas que cobran comisión, no empleados del sistema.
--
-- Hasta ahora el mecánico de una OT se elegía entre los operarios, y un
-- operario es un usuario con acceso a la app. Los mecánicos no son empleados:
-- no entran al sistema, solo se les paga lo que se les devenga en cada orden.
--
-- Siguen viviendo en employees (work_orders.mechanic_id y la cuenta corriente
-- apuntan ahí), pero marcados como mecánico: se dan de alta desde "Cuentas de
-- mecánicos", sin usuario, y no aparecen en la pantalla de Usuarios.

alter table public.employees
  add column if not exists es_mecanico boolean not null default false;

comment on column public.employees.es_mecanico is
  'Mecánico de las OT: cobra comisión (sobrefacturación). Puede no tener usuario.';

-- Los que ya figuran como mecánico de alguna orden o tienen cuenta, quedan marcados.
update public.employees e set es_mecanico = true
 where not e.es_mecanico
   and (exists (select 1 from public.work_orders w where w.mechanic_id = e.id)
        or exists (select 1 from public.mechanic_account_entries m where m.mechanic_id = e.id));

notify pgrst, 'reload schema';

select name, es_mecanico, profile_id is not null as tiene_usuario
  from public.employees where es_mecanico order by name;
