-- Suma CHEQUE_ENDOSADO al tipo de vuelto de una cobranza: además de
-- efectivo/banco (MEDIO_PAGO) y cheque propio (CHEQUE_PROPIO), el vuelto se
-- puede dar entregando un cheque de la cartera, endosado al cliente.
--
-- Va en su propia migración porque Postgres no permite usar un valor de
-- enum recién agregado en la misma transacción en que se agrega: hace falta
-- que este "alter type" quede confirmado antes de que receipt-changes-multi
-- (que sí usa el valor, en save_receipt/void_receipt) se aplique.
alter type receipt_change_kind add value 'CHEQUE_ENDOSADO';
