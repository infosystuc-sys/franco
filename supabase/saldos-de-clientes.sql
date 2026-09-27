-- ===========================================================================
-- El saldo de cada cliente, calculado en un solo lugar
-- ===========================================================================
-- Migración sugerida: saldos_de_clientes
--
-- El saldo se mostraba en tres lugares y cada uno lo sacaba a su manera:
--   - Cuenta corriente sumaba lo que debe sin descontar las notas de crédito
--     imputadas, y lo a favor solo con recibos (sin notas de crédito a cuenta
--     ni vueltos).
--   - La composición de saldos listaba solo facturas: un recibo o una nota de
--     crédito que quedó a cuenta no aparecía (fue el caso del REC-00000004).
--   - El listado de clientes no lo mostraba.
--
-- Ahora el saldo sale de saldos_de_clientes(), y la composición lista también
-- lo que está a cuenta, en negativo, así la suma de cada cliente da ese mismo
-- saldo. Lo a favor es el mismo cálculo que customer_credit(), que es el que
-- usa la cobranza para ofrecer el saldo a favor.
--
-- El nombre sale de la ficha del cliente y no de la copia guardada en cada
-- comprobante: un cliente renombrado quedaba partido en dos.

create or replace function public.saldos_de_clientes()
returns table(customer_id uuid, customer_name text, deuda numeric, a_favor numeric, saldo numeric)
language sql
stable
set search_path to 'public'
as $$
  with deuda as (
    select i.customer_id, sum(i.total_amount - i.paid_amount - i.credited_amount) as monto
      from invoices i
     where i.status = 'EMITIDA'
       and i.total_amount - i.paid_amount - i.credited_amount > 0
     group by i.customer_id
  ),
  favor as (
    select x.customer_id, sum(x.monto) as monto
      from (
        select r.customer_id, r.on_account_amount as monto
          from receipts r
         where r.status = 'REGISTRADO'
        union all
        select nc.customer_id, nc.total_amount - nc.applied_amount
          from credit_notes nc
         where nc.status = 'EMITIDA' and not nc.devuelve_fondos
        union all
        select r.customer_id, -v.amount
          from receipt_values v
          join receipts r on r.id = v.receipt_id
         where r.status = 'REGISTRADO' and v.kind = 'SALDO_A_FAVOR'
        union all
        select r.customer_id, -c.amount
          from receipt_changes c
          join receipts r on r.id = c.receipt_id
         where r.status = 'REGISTRADO'
      ) x
     group by x.customer_id
  )
  select
    c.id,
    c.name,
    round(coalesce(d.monto, 0), 2),
    round(coalesce(f.monto, 0), 2),
    round(coalesce(d.monto, 0) - coalesce(f.monto, 0), 2)
  from customers c
  left join deuda d on d.customer_id = c.id
  left join favor f on f.customer_id = c.id
  where round(coalesce(d.monto, 0), 2) <> 0 or round(coalesce(f.monto, 0), 2) <> 0
  order by c.name;
$$;

grant execute on function public.saldos_de_clientes() to authenticated;

-- La composición: las facturas con saldo, y lo que el cliente tiene a cuenta
-- en negativo. Así el subtotal de cada cliente es su saldo.
create or replace function public.report_customer_balances()
returns table(
  customer_name text, comprobante text, issue_date date, due_date date,
  dias_vencido integer, total_amount numeric, paid_amount numeric, balance numeric
)
language sql
stable
set search_path to 'public'
as $$
  select * from (
    select
      c.name,
      i.invoice_type::text || ' ' || i.full_number,
      i.issue_date,
      i.due_date,
      greatest(0, current_date - i.due_date)::int,
      i.total_amount,
      i.paid_amount,
      i.total_amount - i.paid_amount - i.credited_amount
    from invoices i
    join customers c on c.id = i.customer_id
    where i.status = 'EMITIDA'
      and i.total_amount - i.paid_amount - i.credited_amount > 0

    union all

    -- Recibos con plata a cuenta.
    select c.name, r.full_number || ' (a cuenta)', r.receipt_date, null, null,
           r.total_amount, null, -r.on_account_amount
    from receipts r
    join customers c on c.id = r.customer_id
    where r.status = 'REGISTRADO' and r.on_account_amount > 0

    union all

    -- Notas de crédito que quedaron a cuenta (sin aplicar, y sin devolver la plata).
    select c.name, 'NC ' || nc.invoice_type::text || ' ' || nc.full_number || ' (a cuenta)',
           nc.issue_date, null, null, nc.total_amount, null, -(nc.total_amount - nc.applied_amount)
    from credit_notes nc
    join customers c on c.id = nc.customer_id
    where nc.status = 'EMITIDA' and not nc.devuelve_fondos
      and nc.total_amount - nc.applied_amount > 0

    union all

    -- Lo que de ese saldo a favor ya se usó: pagando con él en otro recibo, o
    -- devolviéndolo como vuelto.
    select c.name, 'Saldo a favor ya usado', null, null, null, null, null, sum(u.monto)
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
    group by c.name
    having sum(u.monto) <> 0
  ) filas(customer_name, comprobante, issue_date, due_date, dias_vencido, total_amount, paid_amount, balance)
  order by customer_name, issue_date nulls last, comprobante;
$$;

-- ---------------------------------------------------------------------------
-- Verificación: el subtotal de cada cliente en la composición tiene que dar
-- su saldo. Devuelve los que no cuadran (vacío = todo bien).
-- ---------------------------------------------------------------------------
select s.customer_name, s.saldo, r.subtotal
from saldos_de_clientes() s
full join (
  select customer_name, round(sum(balance), 2) as subtotal
  from report_customer_balances() group by customer_name
) r on r.customer_name = s.customer_name
where coalesce(s.saldo, 0) <> coalesce(r.subtotal, 0);
