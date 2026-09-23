-- ===========================================================================
-- Imputación de comprobantes — compras
-- ===========================================================================
-- Migración sugerida: imputacion_compras
--
-- El espejo de imputacion-ventas.sql, del lado del proveedor.
--
-- Acá hace falta menos maquinaria: compras ya sabe imputar notas de crédito,
-- porque una nota de proveedor es una fila más de purchase_invoices y se
-- imputa como cualquier otro comprobante, con importe negativo dentro de una
-- orden de pago. settled_amount sube por el valor absoluto: en una factura es
-- lo que se pagó, en una nota es lo que se consumió de ella.
--
-- Entonces reimputar es rehacer payment_order_allocations del proveedor. No se
-- toca ninguna orden de pago: la orden sigue diciendo que salieron $ 100.000
-- y por qué medio. Lo que cambia es contra qué comprobantes se imputaron.

-- ---------------------------------------------------------------------------
-- 1. Reimputar la cuenta de un proveedor
-- ---------------------------------------------------------------------------
-- Igual que en ventas, recibe el cuadro completo y no un delta.
--
-- p_imputaciones: [{ payment_order_id, purchase_invoice_id, amount }, ...]
--   amount viene con signo, como lo guarda save_payment_order: positivo para
--   lo que se paga, negativo para la nota de crédito que se consume.
create or replace function public.imputar_compras(
  p_supplier_id uuid,
  p_imputaciones jsonb,
  p_motivo text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_supplier suppliers%rowtype;
  v_antes jsonb;
  v_despues jsonb;
  v_mal record;
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_supplier from suppliers where id = p_supplier_id;
  if not found then
    raise exception 'El proveedor no existe.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'orden', o.full_number, 'comprobante', pi.full_number, 'amount', al.amount)), '[]'::jsonb)
    into v_antes
    from payment_order_allocations al
    join payment_orders o on o.id = al.payment_order_id
    join purchase_invoices pi on pi.id = al.purchase_invoice_id
   where o.supplier_id = p_supplier_id and o.status = 'REGISTRADA';

  delete from payment_order_allocations al
   using payment_orders o
   where al.payment_order_id = o.id
     and o.supplier_id = p_supplier_id
     and o.status = 'REGISTRADA'
     -- Las notas de crédito provisorias se imputan solas dentro de la orden
     -- que las creó y no se reimputan desde acá: no son comprobantes del
     -- proveedor, son un apaño interno hasta que llegue la formal.
     and al.provisional_credit_note_id is null;

  insert into payment_order_allocations (payment_order_id, purchase_invoice_id, amount)
  select
    (x->>'payment_order_id')::uuid,
    (x->>'purchase_invoice_id')::uuid,
    round((x->>'amount')::numeric, 2)
  from jsonb_array_elements(coalesce(p_imputaciones, '[]'::jsonb)) as x
  where round((x->>'amount')::numeric, 2) <> 0;

  -- ── Recalcular lo saldado de cada comprobante y lo aplicado de cada orden ─
  update purchase_invoices pi
     set settled_amount = coalesce((
       select sum(abs(al.amount))
         from payment_order_allocations al
         join payment_orders o on o.id = al.payment_order_id
        where al.purchase_invoice_id = pi.id and o.status = 'REGISTRADA'
     ), 0)
   where pi.supplier_id = p_supplier_id;

  update payment_orders o
     set applied_amount = coalesce((
       select sum(al.amount) from payment_order_allocations al
        where al.payment_order_id = o.id
     ), 0)
   where o.supplier_id = p_supplier_id and o.status = 'REGISTRADA';

  -- ── Que nada haya quedado en falso ──────────────────────────────────────
  select pi.full_number, pi.total_amount, pi.settled_amount into v_mal
    from purchase_invoices pi
   where pi.supplier_id = p_supplier_id
     and pi.settled_amount > pi.total_amount
   limit 1;
  if found then
    raise exception 'El comprobante % es de $ % y le estás imputando $ %.',
      v_mal.full_number, v_mal.total_amount, v_mal.settled_amount;
  end if;

  select o.full_number, o.total_amount, o.applied_amount into v_mal
    from payment_orders o
   where o.supplier_id = p_supplier_id
     and o.status = 'REGISTRADA'
     and o.applied_amount > o.total_amount
   limit 1;
  if found then
    raise exception 'La orden de pago % paga $ % y estás imputando $ %.',
      v_mal.full_number, v_mal.total_amount, v_mal.applied_amount;
  end if;

  if exists (
    select 1 from payment_order_allocations al
    join payment_orders o on o.id = al.payment_order_id
    join purchase_invoices pi on pi.id = al.purchase_invoice_id
    where o.supplier_id = p_supplier_id and pi.supplier_id <> p_supplier_id
  ) then
    raise exception 'Hay una imputación contra un comprobante de otro proveedor.';
  end if;

  if exists (
    select 1 from payment_order_allocations al
    join payment_orders o on o.id = al.payment_order_id
    join purchase_invoices pi on pi.id = al.purchase_invoice_id
    where o.supplier_id = p_supplier_id and pi.status <> 'REGISTRADA'
  ) then
    raise exception 'Hay una imputación contra un comprobante anulado.';
  end if;

  -- El signo tiene que corresponderse con el tipo: una nota de crédito resta y
  -- una factura suma. Al revés el total de la orden cerraría igual y estaría
  -- diciendo lo contrario de lo que pasó.
  if exists (
    select 1 from payment_order_allocations al
    join payment_orders o on o.id = al.payment_order_id
    join purchase_invoices pi on pi.id = al.purchase_invoice_id
    where o.supplier_id = p_supplier_id
      and ((pi.doc_type = 'NOTA_CREDITO' and al.amount > 0)
        or (pi.doc_type <> 'NOTA_CREDITO' and al.amount < 0))
  ) then
    raise exception 'El signo de una imputación no corresponde al tipo de comprobante: la nota de crédito resta y la factura suma.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'orden', o.full_number, 'comprobante', pi.full_number, 'amount', al.amount)), '[]'::jsonb)
    into v_despues
    from payment_order_allocations al
    join payment_orders o on o.id = al.payment_order_id
    join purchase_invoices pi on pi.id = al.purchase_invoice_id
   where o.supplier_id = p_supplier_id and o.status = 'REGISTRADA';

  insert into imputacion_log (circuito, parte_id, parte_nombre, antes, despues, motivo, created_by)
  values ('COMPRAS', p_supplier_id, v_supplier.name, v_antes, v_despues,
          nullif(trim(coalesce(p_motivo, '')), ''), auth.uid());
end;
$function$;

revoke all on function public.imputar_compras(uuid, jsonb, text) from public, anon;
grant execute on function public.imputar_compras(uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Lo que la pantalla necesita ver de un proveedor
-- ---------------------------------------------------------------------------
create or replace function public.cuenta_del_proveedor(p_supplier_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select jsonb_build_object(
    'comprobantes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pi.id,
        'full_number', pi.doc_type::text || ' ' || pi.letter::text || ' ' || pi.full_number,
        'doc_type', pi.doc_type,
        'issue_date', pi.issue_date,
        'due_date', pi.due_date,
        'total_amount', pi.total_amount,
        'settled_amount', pi.settled_amount
      ) order by pi.issue_date, pi.number)
      from purchase_invoices pi
      where pi.supplier_id = p_supplier_id and pi.status = 'REGISTRADA'
    ), '[]'::jsonb),
    'ordenes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id,
        'full_number', o.full_number,
        'payment_date', o.payment_date,
        'total_amount', o.total_amount,
        'applied_amount', o.applied_amount,
        'allocations', coalesce((
          select jsonb_agg(jsonb_build_object(
            'purchase_invoice_id', al.purchase_invoice_id, 'amount', al.amount))
            from payment_order_allocations al
           where al.payment_order_id = o.id and al.purchase_invoice_id is not null
        ), '[]'::jsonb)
      ) order by o.payment_date, o.number)
      from payment_orders o
      where o.supplier_id = p_supplier_id and o.status = 'REGISTRADA'
    ), '[]'::jsonb)
  );
$function$;

grant execute on function public.cuenta_del_proveedor(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select count(*) as funciones
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('imputar_compras', 'cuenta_del_proveedor');
