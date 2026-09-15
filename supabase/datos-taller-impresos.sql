-- ===========================================================================
-- Los datos del taller que van impresos en un comprobante
-- ===========================================================================
-- Migración: datos_taller_impresos
--
-- company_settings solo la lee un admin, y está bien que así sea: ahí vive el
-- punto de venta habilitado y el resto de la configuración fiscal. Pero el
-- encabezado del presupuesto —razón social, domicilio, CUIT, ingresos brutos—
-- es justamente lo que el taller imprime y le entrega al cliente. No es un
-- dato reservado: figura en cada factura que recibe.
--
-- Sin esto, el presupuesto salía sin encabezado para dos de los tres que lo
-- miran: el cliente que entra por el link (que no tiene sesión) y el operario
-- que lo imprime desde la orden (que no es admin).
--
-- Devuelve solo los campos que se imprimen. El punto de venta queda afuera a
-- propósito: no se imprime en un presupuesto y no tiene por qué salir de
-- company_settings.

create or replace function public.datos_del_taller()
returns table (
  legal_name text,
  trade_name text,
  tax_id text,
  tax_condition text,
  gross_income text,
  activity_start_date date,
  address_street text,
  address_city text,
  address_state text,
  address_zip text,
  phone text,
  email text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    legal_name, trade_name, tax_id, tax_condition, gross_income,
    activity_start_date, address_street, address_city, address_state,
    address_zip, phone, email
  from company_settings;
$$;

grant execute on function public.datos_del_taller() to anon, authenticated;
