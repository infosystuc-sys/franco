-- Comprobantes de compra X (en negro).
--
-- Un comprobante X no es fiscal: no discrimina IVA y no da crédito fiscal.
-- Va a la cuenta corriente del proveedor como cualquier otro y figura en el
-- Libro IVA Compras como "FACTURA X", donde se puede filtrar por letra para
-- sacarlo del libro que se le pasa al contador.

alter type public.purchase_letter add value if not exists 'X';
