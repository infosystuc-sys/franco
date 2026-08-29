-- ===========================================================================
-- Se saca "componente" del ingreso de vehículo
-- ===========================================================================
-- Migración: vehicle_intakes_drop_component
--
-- El detalle de qué se trae a reparar ahora vive en las piezas (nombre +
-- N° de serie, vehicle_intake_parts), no en un campo de texto libre suelto.
-- Las tres filas existentes tenían la columna en null, así que no hay nada
-- que migrar.

alter table public.vehicle_intakes drop column component;
