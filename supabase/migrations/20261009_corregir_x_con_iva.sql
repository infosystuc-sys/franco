-- Las facturas X emitidas antes de apagar el IVA de la serie interna quedaron con
-- el 21% sumado al total. Se les saca: el total pasa a ser el neto.
--
-- Dos de ellas estaban cobradas por el total con IVA. La plata que entró no se
-- toca: el recibo sigue valiendo lo mismo, pero ahora imputa solo lo que la
-- factura vale y la diferencia queda a cuenta del cliente (saldo a favor).
do $$
declare
  r record;
begin
  for r in
    select i.id, i.full_number, i.vat_amount, i.net_amount, i.paid_amount
      from invoices i
     where i.invoice_type = 'X' and i.vat_amount > 0
  loop
    -- Lo imputado de más en recibos vigentes baja a lo que vale la factura; el resto
    -- del recibo (applied_amount / on_account_amount) se recalcula solo.
    update receipt_allocations ra
       set amount = r.net_amount
      from receipts rr
     where ra.invoice_id = r.id and rr.id = ra.receipt_id
       and rr.status = 'REGISTRADO' and ra.amount > r.net_amount;

    -- Lo aplicado de cada recibo es la suma de sus imputaciones; lo que sobra
    -- queda a cuenta del cliente (on_account_amount se calcula solo).
    update receipts rc
       set applied_amount = coalesce((select sum(amount) from receipt_allocations where receipt_id = rc.id), 0)
     where rc.status = 'REGISTRADO'
       and rc.id in (select receipt_id from receipt_allocations where invoice_id = r.id);

    update invoices
       set vat_amount = 0,
           total_amount = net_amount,
           paid_amount = least(paid_amount, net_amount)
     where id = r.id;
  end loop;
end $$;
