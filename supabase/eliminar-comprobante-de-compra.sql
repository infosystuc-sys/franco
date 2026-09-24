-- ===========================================================================
-- Un comprobante de compra se elimina, no se anula
-- ===========================================================================
-- Migración sugerida: eliminar_comprobante_de_compra
--
-- Anular tiene sentido del lado de ventas: la factura la emitimos nosotros,
-- ARCA le dio un CAE y existe para siempre, así que lo único que se puede
-- hacer es dejar dicho que ya no vale.
--
-- Del lado de compras no. El comprobante es del proveedor; lo nuestro es
-- apenas el registro de haberlo recibido. Un registro cargado por error no es
-- un hecho fiscal que haya que preservar: es una fila mal tipeada. Dejarla
-- ANULADA ensucia el listado, el Libro IVA Compras y la cuenta del proveedor
-- con algo que nunca tendría que haber estado.
--
-- ── Lo que hay que mirar antes de borrar ───────────────────────────────────
-- Borrar no se deshace, así que las validaciones son el corazón de esto:
--
--   · que no tenga pagos imputados;
--   · que ninguna orden de pago lo referencie, ni siquiera por $ 0;
--   · que no haya una nota de crédito provisoria apareada contra él;
--   · y si movió stock, devolver ese stock antes de que la fila desaparezca,
--     porque después ya no se sabe cuánto había movido.
--
-- Las dos del medio también las impediría la base por las claves foráneas,
-- pero el error saldría como una violación de restricción que no le dice nada
-- a quien está mirando la pantalla.

create or replace function public.eliminar_comprobante_de_compra(
  p_purchase_invoice_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_doc purchase_invoices%rowtype;
  v_stock_sign int;
  v_row record;
  v_orden text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_doc from purchase_invoices
   where purchase_invoices.id = p_purchase_invoice_id for update;
  if not found then
    raise exception 'El comprobante no existe.';
  end if;

  if v_doc.settled_amount > 0 then
    raise exception
      'El comprobante % tiene pagos imputados por $ %. Sacale la imputación antes de eliminarlo.',
      v_doc.full_number, v_doc.settled_amount;
  end if;

  -- Una imputación en cero no mueve plata pero es un vínculo igual: si se
  -- borra la fila, la orden de pago queda apuntando a un comprobante que no
  -- existe.
  select o.full_number into v_orden
    from payment_order_allocations al
    join payment_orders o on o.id = al.payment_order_id
   where al.purchase_invoice_id = p_purchase_invoice_id
   limit 1;
  if found then
    raise exception
      'El comprobante % está imputado en la orden de pago %. Sacalo de esa orden antes de eliminarlo.',
      v_doc.full_number, v_orden;
  end if;

  if exists (
    select 1 from provisional_credit_notes
     where matched_invoice_id = p_purchase_invoice_id
  ) then
    raise exception
      'El comprobante % está apareado con una nota de crédito provisoria. Desvinculalos antes de eliminarlo.',
      v_doc.full_number;
  end if;

  -- El stock se devuelve solo si esta fila lo había movido y sigue vigente.
  -- Una ya anulada descontó su stock cuando se anuló: hacerlo de nuevo lo
  -- dejaría al revés.
  if v_doc.moves_stock and v_doc.status <> 'ANULADA' then
    v_stock_sign := case when v_doc.doc_type = 'NOTA_CREDITO' then 1 else -1 end;
    for v_row in
      select article_id, quantity from purchase_invoice_items
       where purchase_invoice_id = p_purchase_invoice_id and article_id is not null
    loop
      perform public.adjust_article_stock(v_row.article_id, v_stock_sign * v_row.quantity);
    end loop;
  end if;

  -- El borrador que lo originó vuelve a quedar disponible: el archivo subido
  -- sigue guardado y la lectura ya está hecha, así que se puede volver a
  -- confirmar sin cargar nada de nuevo. Sin esto quedaría marcado como
  -- confirmado contra un comprobante que ya no existe.
  update purchase_invoice_extractions
     set status = 'EXTRAIDO', purchase_invoice_id = null
   where purchase_invoice_id = p_purchase_invoice_id;

  -- Los renglones y los impuestos se van solos: su clave foránea cascadea.
  delete from purchase_invoices where purchase_invoices.id = p_purchase_invoice_id;
end;
$function$;

revoke all on function public.eliminar_comprobante_de_compra(uuid) from public, anon;
grant execute on function public.eliminar_comprobante_de_compra(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Anular deja de existir del lado de compras
-- ---------------------------------------------------------------------------
-- Se saca en vez de dejarla al lado: dos caminos para deshacer lo mismo, uno
-- de los cuales deja la fila a medio morir, es la clase de cosa que alguien
-- elige mal una vez y nadie entiende seis meses después.
drop function if exists public.void_purchase_invoice(uuid, text);

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'eliminar_comprobante_de_compra') as eliminar_existe,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'void_purchase_invoice') as anular_existe,
  (select count(*) from purchase_invoices where status = 'ANULADA') as anulados_que_quedan;
