-- Proveedores ocasionales: los que aparecen una sola vez en una factura de
-- conceptos (la estación de servicio de la ruta, una ferretería, un flete).
-- Son proveedores como cualquier otro —la compra, la cuenta corriente y el
-- libro de IVA los necesitan—, pero no se muestran en el listado de
-- Proveedores salvo que se pida verlos.

alter table public.suppliers
  add column if not exists is_occasional boolean not null default false;

comment on column public.suppliers.is_occasional is
  'Proveedor de una compra suelta de conceptos. Oculto por defecto en el listado de Proveedores.';

notify pgrst, 'reload schema';
