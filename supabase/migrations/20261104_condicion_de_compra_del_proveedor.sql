-- Condición de compra de cada proveedor: contado o cuenta corriente.
--
-- La carga de compras con IA no sabía cómo se le compra a cada proveedor y
-- arrancaba todo en contado (salvo lo que llega por correo). Ahora la ficha
-- del proveedor lo dice, y la revisión de la IA arranca con eso.
--
-- Los proveedores que ya están cargados con plazo 0 quedan en contado; el
-- resto, en cuenta corriente.

alter table public.suppliers
  add column if not exists purchase_condition text not null default 'CUENTA_CORRIENTE';

alter table public.suppliers drop constraint if exists suppliers_purchase_condition_check;
alter table public.suppliers
  add constraint suppliers_purchase_condition_check
  check (purchase_condition in ('CONTADO', 'CUENTA_CORRIENTE'));

update public.suppliers set purchase_condition = 'CONTADO'
 where payment_terms_days = 0 and purchase_condition <> 'CONTADO';

notify pgrst, 'reload schema';

select purchase_condition, count(*) from public.suppliers group by 1;
