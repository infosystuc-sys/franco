-- ===========================================================================
-- Identificador estable para el estado Terminado
-- ===========================================================================
-- Migración: clave_terminado
--
-- El seguimiento que ve el cliente muestra tres etapas: ingresado, cotizado y
-- terminado. Las dos primeras ya se identifican por system_key; la tercera se
-- reconocía solo por su etiqueta, que el taller puede renombrar cuando quiera.
-- El día que alguien la llame "Finalizado" o "Listo", el seguimiento dejaría
-- de mostrar esa etapa sin que nadie entienda por qué.
--
-- Mismo criterio que INGRESADO, COTIZADO, AUTORIZADA, RECHAZADA y RETIRADO: la
-- etiqueta es del usuario, la clave es del sistema.

update public.work_order_statuses
set system_key = 'TERMINADO'
where system_key is null
  and is_terminal
  and lower(label) = 'terminado';
