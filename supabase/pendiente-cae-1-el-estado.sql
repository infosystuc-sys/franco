-- ===========================================================================
-- El estado PENDIENTE_CAE — paso 1 de 2: agregar el valor al enum
-- ===========================================================================
-- Migración sugerida: pendiente_cae_el_estado
--
-- Este archivo tiene UNA sola sentencia, y es a propósito.
--
-- Postgres deja agregar un valor a un enum dentro de una transacción, pero no
-- deja USARLO hasta que esa transacción commitee. El SQL Editor de Supabase
-- corre todo el script como una sola transacción: si el `alter type` y el
-- `alter table ... check (... 'PENDIENTE_CAE' ...)` van juntos, el script
-- falla con "unsafe use of new value of enum type" y no queda nada aplicado.
--
-- Por eso son dos archivos. Primero este, solo. Después
-- pendiente-cae-2-las-reglas.sql, en una corrida aparte.

alter type public.invoice_status
  add value if not exists 'PENDIENTE_CAE' before 'EMITIDA';

-- Queda ordenado PENDIENTE_CAE → EMITIDA → ANULADA, que es el orden en que
-- una factura atraviesa su vida. Importa para cualquier `order by status`.

-- Verificación: tienen que aparecer los tres, en ese orden.
select enumlabel, enumsortorder
from pg_enum
where enumtypid = 'public.invoice_status'::regtype
order by enumsortorder;
