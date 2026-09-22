-- ===========================================================================
-- confirmar_cae() también la tiene que poder llamar la Edge Function
-- ===========================================================================
-- Migración sugerida: confirmar_cae_service_role
--
-- Corrección de pendiente-cae-2-las-reglas.sql. Ese archivo dejó la función
-- detrás de `if not is_admin()`, y así no sirve para lo que fue escrita.
--
-- is_admin() es `select exists (select 1 from profiles where id = auth.uid()
-- and role = 'admin')`. La Edge Function se conecta con la llave de servicio,
-- que no representa a ninguna persona: no lleva `sub` en el token, auth.uid()
-- devuelve null, ninguna fila de profiles coincide y el guard rebota. La
-- función que va a pedir el CAE a ARCA no podría guardar lo que ARCA conteste.
--
-- Se abre al rol de servicio, no a cualquiera. Los dos caminos que quedan son
-- los dos que existen de verdad:
--
--   · un administrador confirmando a mano desde Configuración (fase 2);
--   · la Edge Function guardando el CAE que devolvió ARCA (fase 3).
--
-- Sigue siendo una sola función, y eso importa: el paso de PENDIENTE_CAE a
-- EMITIDA es el punto donde una factura se vuelve fiscal. Con dos funciones
-- haciendo el mismo update, el día que haya que agregarle una regla se le
-- agrega a una sola y la otra queda floja.

create or replace function public.confirmar_cae(
  p_invoice_id uuid,
  p_cae text,
  p_cae_due_date date,
  p_simulado boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status invoice_status;
  v_cae text := trim(coalesce(p_cae, ''));
begin
  -- El rol viene del token de la petición, no de la sesión de Postgres: dentro
  -- de una security definer current_user ya es el dueño de la función y no
  -- distingue quién llamó.
  if not (is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Solo un administrador puede confirmar el CAE de una factura.';
  end if;

  -- El CAE de ARCA son 14 dígitos. Validarlo acá evita guardar uno pegado a
  -- medias, que después se imprime en el comprobante y en el QR.
  if v_cae !~ '^\d{14}$' then
    raise exception 'El CAE tiene que ser de 14 dígitos.';
  end if;

  if p_cae_due_date is null then
    raise exception 'El CAE tiene que venir con su fecha de vencimiento.';
  end if;

  -- El for update cierra la ventana entre leer el estado y escribirlo: dos
  -- confirmaciones a la vez no pueden pasar las dos por el chequeo.
  select status into v_status
    from invoices
   where id = p_invoice_id
   for update;

  if not found then
    raise exception 'La factura no existe.';
  end if;

  if v_status <> 'PENDIENTE_CAE' then
    raise exception 'La factura no está esperando un CAE: está %.', v_status;
  end if;

  update invoices
     set status        = 'EMITIDA',
         cae           = v_cae,
         cae_due_date  = p_cae_due_date,
         cae_simulated = coalesce(p_simulado, false)
   where id = p_invoice_id;
end;
$$;

-- Los grants no cambian: anon y public siguen afuera, authenticated entra y
-- lo frena is_admin() adentro, y service_role conserva el suyo por defecto.
revoke all on function public.confirmar_cae(uuid, text, date, boolean) from public, anon;
grant execute on function public.confirmar_cae(uuid, text, date, boolean) to authenticated;

-- Verificación: tiene que decir service_role.
select case
         when prosrc like '%service_role%' then 'ok: abierta a la Edge Function'
         else 'PROBLEMA: quedó la versión vieja'
       end as estado
from pg_proc
where oid = 'public.confirmar_cae(uuid, text, date, boolean)'::regprocedure;
