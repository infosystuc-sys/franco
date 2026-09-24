-- ===========================================================================
-- Cada cliente con su condición de venta habitual
-- ===========================================================================
-- Migración sugerida: condicion_de_venta_del_cliente
--
-- Al facturar hay que elegir contado o cuenta corriente, y no hay valor por
-- defecto a propósito: un default se confirma sin mirarlo. Pero la condición
-- casi nunca cambia por cliente —el de mostrador paga siempre de contado, el
-- taller amigo siempre a cuenta corriente— así que volver a elegirla en cada
-- factura es tipear lo mismo una y otra vez.
--
-- Guardarla en el cliente permite proponerla al facturar. Sigue siendo una
-- propuesta: la pantalla la deja cambiar, porque el cliente de cuenta corriente
-- a veces paga al contado y al revés.
--
-- Null significa "no está definida" y la factura sigue obligando a elegir, que
-- es exactamente el comportamiento de hoy para los clientes ya cargados.

alter table customers
  add column if not exists condicion_venta text
    check (condicion_venta in ('CONTADO', 'CUENTA_CORRIENTE'));

comment on column customers.condicion_venta is
  'Condición de venta habitual. Se propone al facturar y se puede cambiar. '
  'Null = sin definir: la factura obliga a elegirla.';

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_name = 'customers' and column_name = 'condicion_venta') as columna,
  (select count(*) from customers where condicion_venta is not null) as clientes_con_condicion;
