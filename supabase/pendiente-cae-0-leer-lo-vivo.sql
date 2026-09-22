-- ===========================================================================
-- Leer lo que está corriendo hoy (SOLO LECTURA, no cambia nada)
-- ===========================================================================
-- La migración `dos_series_de_factura` reescribió _create_invoice(),
-- issue_invoice() e issue_free_invoice() sin dejar el cuerpo nuevo en el
-- repositorio: el archivo dos-series-de-factura.sql describe los cambios en
-- prosa y remite a pg_get_functiondef(). Por eso acá no hay forma de saber
-- cómo quedaron.
--
-- Eso importa ahora: para que la factura NAZCA en PENDIENTE_CAE hay que tocar
-- el cuerpo de _create_invoice(), y un `create or replace` escrito sobre la
-- última versión que sí está en el repo (remitos-standalone.sql, del 30/08)
-- borraría en silencio todo lo que vino después: las dos series, p_condicion,
-- el CAE simulado. La factura seguiría saliendo, con el comportamiento de
-- hace tres semanas, y nadie se enteraría hasta que algo no cuadre.
--
-- Correr esto en el SQL Editor y pasar el resultado. Con el cuerpo real a la
-- vista se escribe el cambio de _create_invoice() sin adivinar.

select
  p.oid::regprocedure as firma,
  pg_get_functiondef(p.oid) as cuerpo
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    '_create_invoice',      -- el que hay que partir en dos fases
    'issue_invoice',        -- lo llama desde una OT
    'issue_free_invoice',   -- lo llama sin OT
    'void_invoice',         -- tiene que saber qué hacer con una pendiente
    'numeracion_facturas',  -- hoy cuenta solo las EMITIDA
    'fijar_proximo_numero'
  )
order by p.proname, p.oid::regprocedure::text;
