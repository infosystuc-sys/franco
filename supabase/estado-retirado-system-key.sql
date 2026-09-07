-- ===========================================================================
-- "Retirado" pasa a reconocerse por clave, no por su nombre
-- ===========================================================================
-- Migración: estado_retirado_system_key
--
-- Una OT facturada queda bloqueada, pero tiene que poder avanzar a Retirado:
-- el vehículo se entrega DESPUÉS de facturar, y sin ese paso la orden queda
-- ocupando lugar en la playa para siempre.
--
-- Para permitir ese único cambio hay que saber cuál es ese estado. El ABM deja
-- renombrarlos, así que compararlo contra el texto 'Retirado' es la misma
-- trampa que ya arreglamos en work-order-status-system-key.sql: alguien lo
-- renombra y la OT facturada se queda sin salida, en silencio.

do $$
declare
  v_id uuid;
  v_cuantos int;
begin
  -- Hoy lo identifican sus marcas: es el único estado que cierra la orden Y
  -- libera la playa (Terminado cierra pero el vehículo sigue estacionado;
  -- Rechazada libera pero no cierra).
  select count(*) into v_cuantos
  from work_order_statuses
  where is_terminal and frees_yard;

  if v_cuantos <> 1 then
    raise exception
      'Se esperaba exactamente un estado terminal que libere la playa, hay %. Revisá el ABM de estados antes de aplicar esta migración.',
      v_cuantos;
  end if;

  select id into v_id from work_order_statuses where is_terminal and frees_yard;
  update work_order_statuses set system_key = 'RETIRADO' where id = v_id;
end $$;
