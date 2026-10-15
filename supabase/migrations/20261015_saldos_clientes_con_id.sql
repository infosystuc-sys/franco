-- El informe "Composición de saldos — clientes" devuelve también el id del
-- cliente: con un solo cliente en pantalla, el informe se le puede mandar por
-- mail o WhatsApp, y para eso hay que saber a quién (dos clientes pueden
-- llamarse igual). La columna va al final y no se muestra.
drop function if exists public.report_customer_balances();

create function public.report_customer_balances()
 RETURNS TABLE(customer_name text, comprobante text, issue_date date, due_date date, dias_vencido integer,
   total_amount numeric, paid_amount numeric, balance numeric, customer_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select * from (
    select
      c.name,
      case when i.saldo_inicial then coalesce(i.referencia_anterior, i.full_number) else i.invoice_type::text || ' ' || i.full_number end,
      i.issue_date,
      i.due_date,
      greatest(0, current_date - i.due_date)::int,
      i.total_amount,
      i.paid_amount,
      i.total_amount - i.paid_amount - i.credited_amount,
      c.id
    from invoices i
    join customers c on c.id = i.customer_id
    where i.status = 'EMITIDA'
      and i.total_amount - i.paid_amount - i.credited_amount > 0

    union all

    -- Recibos con plata a cuenta.
    select c.name, case when r.saldo_inicial then 'Saldo inicial a favor ' || r.full_number else r.full_number || ' (a cuenta)' end, r.receipt_date, null, null,
           r.total_amount, null, -r.on_account_amount, c.id
    from receipts r
    join customers c on c.id = r.customer_id
    where r.status = 'REGISTRADO' and r.on_account_amount > 0

    union all

    -- Notas de crédito que quedaron a cuenta (sin aplicar, y sin devolver la plata).
    select c.name, 'NC ' || nc.invoice_type::text || ' ' || nc.full_number || ' (a cuenta)',
           nc.issue_date, null, null, nc.total_amount, null, -(nc.total_amount - nc.applied_amount), c.id
    from credit_notes nc
    join customers c on c.id = nc.customer_id
    where nc.status = 'EMITIDA' and not nc.devuelve_fondos
      and nc.total_amount - nc.applied_amount > 0

    union all

    -- Lo que de ese saldo a favor ya se usó: pagando con él en otro recibo, o
    -- devolviéndolo como vuelto.
    select c.name, 'Saldo a favor ya usado', null, null, null, null, null, sum(u.monto), c.id
    from (
      select r.customer_id, v.amount as monto
        from receipt_values v join receipts r on r.id = v.receipt_id
       where r.status = 'REGISTRADO' and v.kind = 'SALDO_A_FAVOR'
      union all
      select r.customer_id, ch.amount
        from receipt_changes ch join receipts r on r.id = ch.receipt_id
       where r.status = 'REGISTRADO'
    ) u
    join customers c on c.id = u.customer_id
    group by c.id, c.name
    having sum(u.monto) <> 0
  ) filas(customer_name, comprobante, issue_date, due_date, dias_vencido, total_amount, paid_amount, balance, customer_id)
  order by customer_name, issue_date nulls last, comprobante;
$function$;

grant execute on function public.report_customer_balances() to authenticated;
notify pgrst, 'reload schema';
