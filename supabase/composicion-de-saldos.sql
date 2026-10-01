-- ===========================================================================
-- Composición de saldos de clientes y proveedores, como la de Tango
-- ===========================================================================
-- Migración sugerida: composicion_de_saldos
--
-- Las pantallas de cuenta corriente muestran, por cliente o proveedor, cada
-- comprobante con los cobros (o pagos) que se le aplicaron debajo, y aparte lo
-- que quedó a cuenta. Estas funciones devuelven esos renglones; la pantalla
-- los agrupa, filtra por fechas y calcula el saldo anterior.
--
-- tipo:
--   COMPROBANTE  un comprobante que mueve la cuenta (factura, nota de débito,
--                y del lado de compras también la nota de crédito);
--                importe con signo: positivo aumenta el saldo.
--   APLICACION   lo que se le aplicó a un comprobante (comprobante_id es el de
--                arriba); importe con signo, normalmente negativo.
--   A_CUENTA     lo que no está aplicado a ningún comprobante: un recibo o una
--                orden de pago a cuenta, una nota de crédito sin aplicar, el
--                saldo a favor usado en otro cobro, un vuelto.
--
-- La suma de todos los renglones de un cliente es su saldo: el mismo número
-- que saldos_de_clientes(). Las aplicaciones posteriores a p_hasta no se
-- cuentan, así el saldo es el que tenía a esa fecha.

create or replace function public.cuenta_corriente_clientes(p_hasta date default current_date, p_customer_id uuid default null)
returns table(
  customer_id uuid, nombre text, cuit text, tipo text, comprobante_id uuid, comprobante text,
  fecha date, vencimiento date, importe numeric, aplicado text, fecha_aplicacion date
)
language sql
stable
set search_path to 'public'
as $$
  with clientes as (
    select c.id, c.name, c.tax_id from customers c
     where p_customer_id is null or c.id = p_customer_id
  )
  -- Facturas
  select c.id, c.name, c.tax_id, 'COMPROBANTE', i.id,
         case when i.saldo_inicial
              then 'Factura ' || coalesce(i.referencia_anterior, i.full_number)
              else 'Factura ' || i.invoice_type::text || ' ' || i.full_number end,
         i.issue_date, i.due_date, i.total_amount, null, null
    from invoices i join clientes c on c.id = i.customer_id
   where i.status = 'EMITIDA' and i.issue_date <= p_hasta

  union all
  -- Cobros aplicados a cada factura
  select c.id, c.name, c.tax_id, 'APLICACION', i.id, null, null, null,
         -al.amount, 'Recibo ' || r.full_number, r.receipt_date
    from receipt_allocations al
    join receipts r on r.id = al.receipt_id and r.status = 'REGISTRADO'
    join invoices i on i.id = al.invoice_id
    join clientes c on c.id = i.customer_id
   where i.status = 'EMITIDA' and i.issue_date <= p_hasta and r.receipt_date <= p_hasta

  union all
  -- Notas de crédito aplicadas a cada factura
  select c.id, c.name, c.tax_id, 'APLICACION', i.id, null, null, null,
         -a.amount, 'Nota de crédito ' || nc.invoice_type::text || ' ' || nc.full_number,
         greatest(nc.issue_date, a.created_at::date)
    from credit_note_allocations a
    join credit_notes nc on nc.id = a.credit_note_id and nc.status = 'EMITIDA'
    join invoices i on i.id = a.invoice_id
    join clientes c on c.id = i.customer_id
   where i.status = 'EMITIDA' and i.issue_date <= p_hasta
     and greatest(nc.issue_date, a.created_at::date) <= p_hasta

  union all
  -- Recibos con plata a cuenta
  select c.id, c.name, c.tax_id, 'A_CUENTA', r.id,
         'Recibo ' || r.full_number || case when r.saldo_inicial then ' (saldo inicial a favor)' else ' (a cuenta)' end,
         r.receipt_date, null, -r.on_account_amount, null, null
    from receipts r join clientes c on c.id = r.customer_id
   where r.status = 'REGISTRADO' and r.on_account_amount > 0 and r.receipt_date <= p_hasta

  union all
  -- Notas de crédito sin aplicar (las que devolvieron la plata no quedan a cuenta)
  select c.id, c.name, c.tax_id, 'A_CUENTA', nc.id,
         'Nota de crédito ' || nc.invoice_type::text || ' ' || nc.full_number || ' (a cuenta)',
         nc.issue_date, null, -(nc.total_amount - nc.applied_amount), null, null
    from credit_notes nc join clientes c on c.id = nc.customer_id
   where nc.status = 'EMITIDA' and not nc.devuelve_fondos
     and nc.total_amount - nc.applied_amount > 0 and nc.issue_date <= p_hasta

  union all
  -- Saldo a favor que se usó para pagar en otro recibo
  select c.id, c.name, c.tax_id, 'A_CUENTA', r.id,
         'Recibo ' || r.full_number || ' (usa saldo a favor)',
         r.receipt_date, null, v.amount, null, null
    from receipt_values v
    join receipts r on r.id = v.receipt_id and r.status = 'REGISTRADO'
    join clientes c on c.id = r.customer_id
   where v.kind = 'SALDO_A_FAVOR' and r.receipt_date <= p_hasta

  union all
  -- Vueltos
  select c.id, c.name, c.tax_id, 'A_CUENTA', r.id,
         'Recibo ' || r.full_number || ' (vuelto)',
         r.receipt_date, null, ch.amount, null, null
    from receipt_changes ch
    join receipts r on r.id = ch.receipt_id and r.status = 'REGISTRADO'
    join clientes c on c.id = r.customer_id
   where r.receipt_date <= p_hasta
$$;

grant execute on function public.cuenta_corriente_clientes(date, uuid) to authenticated;

-- Del lado de compras, el saldo es lo que el taller le debe al proveedor.
-- Facturas y notas de débito lo aumentan; las notas de crédito, los pagos y
-- lo que se le pagó a cuenta lo bajan.
create or replace function public.cuenta_corriente_proveedores(p_hasta date default current_date, p_supplier_id uuid default null)
returns table(
  supplier_id uuid, nombre text, cuit text, tipo text, comprobante_id uuid, comprobante text,
  fecha date, vencimiento date, importe numeric, aplicado text, fecha_aplicacion date
)
language sql
stable
set search_path to 'public'
as $$
  with proveedores as (
    select s.id, s.name, s.tax_id from suppliers s
     where p_supplier_id is null or s.id = p_supplier_id
  )
  -- Comprobantes de compra
  select s.id, s.name, s.tax_id, 'COMPROBANTE', pi.id,
         case pi.doc_type::text
           when 'FACTURA' then 'Factura '
           when 'NOTA_DEBITO' then 'Nota de débito '
           else 'Nota de crédito ' end || pi.letter::text || ' ' || pi.full_number,
         pi.issue_date,
         case when pi.doc_type::text = 'NOTA_CREDITO' then null else pi.due_date end,
         case when pi.doc_type::text = 'NOTA_CREDITO' then -pi.total_amount else pi.total_amount end,
         null, null
    from purchase_invoices pi join proveedores s on s.id = pi.supplier_id
   where pi.status = 'REGISTRADA' and pi.issue_date <= p_hasta

  union all
  -- Pagos aplicados (una nota de crédito aplicada en una orden va en negativo,
  -- y debajo de la nota suma)
  select s.id, s.name, s.tax_id, 'APLICACION', pi.id, null, null, null,
         -al.amount, 'Orden de pago ' || o.full_number, o.payment_date
    from payment_order_allocations al
    join payment_orders o on o.id = al.payment_order_id and o.status = 'REGISTRADA'
    join purchase_invoices pi on pi.id = al.purchase_invoice_id
    join proveedores s on s.id = pi.supplier_id
   where pi.status = 'REGISTRADA' and pi.issue_date <= p_hasta and o.payment_date <= p_hasta

  union all
  -- Notas de crédito provisorias, con lo que se les aplicó
  select s.id, s.name, s.tax_id, 'COMPROBANTE', pc.id,
         'NC provisoria ' || pc.full_number, pc.created_at::date, null, -pc.amount, null, null
    from provisional_credit_notes pc join proveedores s on s.id = pc.supplier_id
   where pc.created_at::date <= p_hasta

  union all
  select s.id, s.name, s.tax_id, 'APLICACION', pc.id, null, null, null,
         -al.amount, 'Orden de pago ' || o.full_number, o.payment_date
    from payment_order_allocations al
    join payment_orders o on o.id = al.payment_order_id and o.status = 'REGISTRADA'
    join provisional_credit_notes pc on pc.id = al.provisional_credit_note_id
    join proveedores s on s.id = pc.supplier_id
   where pc.created_at::date <= p_hasta and o.payment_date <= p_hasta

  union all
  -- Pagado a cuenta
  select s.id, s.name, s.tax_id, 'A_CUENTA', o.id,
         'Orden de pago ' || o.full_number || ' (a cuenta)',
         o.payment_date, null, -o.on_account_amount, null, null
    from payment_orders o join proveedores s on s.id = o.supplier_id
   where o.status = 'REGISTRADA' and o.on_account_amount > 0 and o.payment_date <= p_hasta

  union all
  -- Saldo a favor usado en otra orden
  select s.id, s.name, s.tax_id, 'A_CUENTA', o.id,
         'Orden de pago ' || o.full_number || ' (usa saldo a favor)',
         o.payment_date, null, v.amount, null, null
    from payment_order_values v
    join payment_orders o on o.id = v.payment_order_id and o.status = 'REGISTRADA'
    join proveedores s on s.id = o.supplier_id
   where v.kind::text = 'SALDO_A_FAVOR' and o.payment_date <= p_hasta
$$;

grant execute on function public.cuenta_corriente_proveedores(date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación: la suma por cliente tiene que dar su saldo. Devuelve los que
-- no cuadran (vacío = todo bien).
-- ---------------------------------------------------------------------------
select s.customer_name, s.saldo, cc.suma
from saldos_de_clientes() s
full join (
  select customer_id, round(sum(importe), 2) as suma
  from cuenta_corriente_clientes() group by customer_id
) cc on cc.customer_id = s.customer_id
where round(coalesce(s.saldo, 0), 2) <> round(coalesce(cc.suma, 0), 2);
