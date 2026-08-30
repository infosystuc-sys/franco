-- Nuevo tipo de aviso: autorización de cambio de precio en una OT.
--
-- Va en migración propia, aplicada ANTES de work-order-price-authorization.sql:
-- un valor de enum recién agregado no se puede usar en la misma transacción
-- en la que se agrega.

alter type notification_kind add value 'CAMBIO_PRECIO';
