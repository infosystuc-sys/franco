-- Plazo de la cuenta corriente de cada cliente.
--
-- Hasta ahora toda factura en cuenta corriente vencía a los 7 días. Ahora
-- cada cliente puede tener su propio plazo (30, 60…): al facturarle se
-- propone el vencimiento con ese plazo, y se puede cambiar ahí mismo.
-- Vacío = el de siempre, 7 días.

alter table public.customers
  add column if not exists payment_terms_days integer
    check (payment_terms_days is null or payment_terms_days between 0 and 365);

comment on column public.customers.payment_terms_days is
  'Días de plazo de la cuenta corriente. Null = el plazo general (7 días).';

notify pgrst, 'reload schema';
