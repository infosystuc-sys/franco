-- DieselPro ERP — motivo obligatorio al rechazar un presupuesto
--
-- Aplicar en el SQL Editor de Supabase.
--
-- Cuando el cliente rechaza desde el link público, ahora tiene que decir por
-- qué. Es el dato que decide si vale la pena recotizar o si el trabajo se
-- perdió, y hasta ahora se perdía con él.
--
-- La obligatoriedad vive acá y no solo en el formulario: el link es público y
-- cualquiera puede llamar a la RPC directamente.


-- ===========================================================================
-- 1) El motivo
-- ===========================================================================
alter table quotations add column if not exists rejection_reason text;

comment on column quotations.rejection_reason is
  'Por qué el cliente rechazó, desde el link público. NO se exige con un '
  'check sobre el estado: el taller también puede rechazar desde su pantalla '
  'y ahí no hay motivo del cliente. La regla es "si rechaza el cliente, '
  'motivo obligatorio", no "toda rechazada tiene motivo".';


-- ===========================================================================
-- 2) La decisión del cliente
-- ===========================================================================
-- Se elimina la versión de dos parámetros antes de crear la de tres: si
-- convivieran, una llamada con dos argumentos quedaría ambigua entre la vieja
-- y la nueva —que tiene default— y Postgres la rechazaría.
--
-- El tercer parámetro va con default para que una app todavía sin actualizar
-- siga funcionando: va a poder aceptar, y al rechazar recibirá FALTA_MOTIVO
-- en vez de un error.
drop function if exists public.decide_quotation(uuid, boolean);

create or replace function public.decide_quotation(
  p_token uuid,
  p_accept boolean,
  p_reason text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  q quotations%rowtype;
begin
  select * into q from quotations where public_token = p_token for update;

  if not found then
    return 'NO_EXISTE';
  end if;

  -- Una cotización ya resuelta no se vuelve a tocar.
  if q.status not in ('EMITIDA', 'ENVIADA') then
    return 'YA_RESUELTA';
  end if;

  -- Si ya generó una orden, es un hecho consumado.
  if q.work_order_id is not null then
    return 'YA_CONVERTIDA';
  end if;

  -- Vencida: el precio ya no vale.
  if q.valid_until is not null and q.valid_until < current_date then
    return 'VENCIDA';
  end if;

  -- Rechazar sin decir por qué deja al taller sin la única información que
  -- sirve para reaccionar. Se valida antes de tocar nada.
  if not p_accept and coalesce(trim(p_reason), '') = '' then
    return 'FALTA_MOTIVO';
  end if;

  update quotations
     set status = case when p_accept then 'ACEPTADA'::quotation_status
                       else 'RECHAZADA'::quotation_status end,
         decided_at = now(),
         decided_by_client = true,
         -- Al aceptar no se pisa un motivo previo: si el presupuesto se había
         -- rechazado, se reabrió y ahora se acepta, el rechazo anterior sigue
         -- siendo parte de la historia.
         rejection_reason = case when p_accept then q.rejection_reason
                                 else trim(p_reason) end
   where id = q.id;

  return case when p_accept then 'ACEPTADA' else 'RECHAZADA' end;
end;
$$;

-- El link es público: lo llama gente sin sesión.
grant execute on function public.decide_quotation(uuid, boolean, text) to anon, authenticated;
