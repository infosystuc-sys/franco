-- ===========================================================================
-- Dos series de factura: la electrónica y la interna
-- ===========================================================================
-- Migraciones: invoice_type_x, dos_series_de_factura
--
-- El taller emite dos comprobantes distintos:
--
--   · La factura electrónica, que en su momento va a pedirle el CAE a ARCA.
--     Hasta que eso exista, el CAE se simula acá adentro para poder probar el
--     circuito entero —numeración, impresión, cuenta corriente— sin depender
--     del organismo. Queda marcada como simulada, así que cuando ARCA conteste
--     de verdad se ve de un vistazo cuáles nunca estuvieron autorizadas.
--
--   · La interna, letra X, sin validez fiscal pero con el mismo comportamiento
--     en el sistema: numera, imprime, va a la cuenta corriente y se cobra igual.
--
-- Cada una tiene su punto de venta: la electrónica el habilitado en ARCA, la
-- interna el 90000. Así no existen dos comprobantes distintos con el mismo
-- número, que es lo que después nadie puede desenredar.

-- ---------------------------------------------------------------------------
-- 1. El número completo, con puntos de venta de más de cuatro dígitos
-- ---------------------------------------------------------------------------
-- lpad() TRUNCA cuando el texto es más largo que el ancho pedido: con el punto
-- de venta 90000, lpad('90000', 4, '0') devuelve '9000' y el comprobante
-- quedaba numerado 9000-00000001, en silencio y sin que nada fallara.
--
-- Se arregla en las tres tablas que comparten la expresión, no solo en la que
-- hacía falta: es el mismo defecto, y en compras el punto de venta lo pone el
-- proveedor, así que puede venir de cinco dígitos cualquier día.

alter table invoices drop column full_number;
alter table invoices add column full_number text
  generated always as (
    lpad(sales_point::text, greatest(4, length(sales_point::text)), '0')
    || '-' || lpad(number::text, 8, '0')
  ) stored;

alter table remitos drop column full_number;
alter table remitos add column full_number text
  generated always as (
    lpad(sales_point::text, greatest(4, length(sales_point::text)), '0')
    || '-' || lpad(number::text, 8, '0')
  ) stored;

alter table purchase_invoices drop column full_number;
alter table purchase_invoices add column full_number text
  generated always as (
    lpad(sales_point::text, greatest(4, length(sales_point::text)), '0')
    || '-' || lpad(number::text, 8, '0')
  ) stored;

-- ---------------------------------------------------------------------------
-- 2. El CAE y el punto de venta de la serie interna
-- ---------------------------------------------------------------------------
alter table invoices
  add column if not exists cae text,
  add column if not exists cae_due_date date,
  -- Sin esto no habría forma de distinguir, el día que ARCA conteste de
  -- verdad, un CAE real de uno inventado en las pruebas.
  add column if not exists cae_simulated boolean not null default false;

comment on column invoices.cae is
  'CAE de ARCA. Mientras la integración no exista, se simula: ver cae_simulated.';

alter table company_settings
  add column if not exists sales_point_internal integer not null default 90000;

comment on column company_settings.sales_point is
  'Punto de venta de la factura electrónica: el habilitado en ARCA.';
comment on column company_settings.sales_point_internal is
  'Punto de venta de la factura interna (letra X), sin validez fiscal.';

-- ---------------------------------------------------------------------------
-- 3. Emitir: qué serie y cómo se cobra
-- ---------------------------------------------------------------------------
-- Se dropean antes de recrear porque los parámetros nuevos tienen default: un
-- "create or replace" con más argumentos deja viva la versión vieja y las
-- llamadas con la lista corta quedan ambiguas.
--
-- El cuerpo completo de _create_invoice, issue_invoice e issue_free_invoice
-- quedó aplicado en la migración `emitir_por_serie_y_condicion`. Lo que cambia
-- respecto de la versión anterior:
--
--   · Dos parámetros nuevos, p_serie ('ELECTRONICA' | 'INTERNA') y p_condicion
--     ('CONTADO' | 'CUENTA_CORRIENTE'), ambos con default, validados al entrar.
--   · La serie decide letra y punto de venta: INTERNA es X sobre
--     sales_point_internal; ELECTRONICA es la letra del cliente sobre
--     sales_point.
--   · El IVA se calcula SIEMPRE con la letra que le corresponde al cliente,
--     también en la interna, para que el total dé igual en las dos series. La X
--     no lo discrimina al imprimirse, pero el importe es el mismo.
--   · CONTADO factura a 0 días (vence el mismo día); CUENTA_CORRIENTE a 7,
--     como siempre.
--   · La electrónica recibe un CAE simulado de 14 dígitos con vencimiento a 10
--     días, y cae_simulated en true.
--
-- Para leerlo tal como está corriendo:
--   select pg_get_functiondef('public._create_invoice'::regproc);

-- ---------------------------------------------------------------------------
-- 4. La numeración, visible y editable (migración `numeracion_editable`)
-- ---------------------------------------------------------------------------
-- numeracion_facturas() lista cada serie con su próximo número y cuántas lleva
-- emitidas. fijar_proximo_numero() lo cambia, y se niega a retroceder por
-- debajo de lo ya emitido: si no, la próxima factura chocaría contra un número
-- existente y el error saltaría recién al emitir, con el cliente enfrente.
