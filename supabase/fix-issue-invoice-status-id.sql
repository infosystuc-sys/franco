-- ===========================================================================
-- Arregla issue_invoice: todavía comparaba contra work_orders.status
-- ===========================================================================
-- Migración: fix_issue_invoice_status_id
--
-- Regresión de la migración del ABM de estados de OT: esa migración dropeó
-- work_orders.status (reemplazado por status_id) y redefinió las funciones
-- que lo mencionaban EN SU FIRMA, pero issue_invoice lo usaba en el CUERPO
-- (v_wo.status <> 'TERMINADO'), no en la firma, así que no apareció en ese
-- relevamiento y quedó roto: facturar cualquier OT terminada fallaba porque
-- v_wo (work_orders%rowtype) ya no tiene ningún campo status.
--
-- Mismo fix que ya se aplicó en fetchPendingToInvoice (frontend): reemplazar
-- la comparación contra el enum por is_terminal de la tabla work_order_statuses.

create or replace function public.issue_invoice(
  p_work_order_id uuid,
  p_items jsonb,
  p_notes text default null::text,
  p_emit_remito boolean default false
)
returns table(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_wo work_orders%rowtype;
  v_status_label text;
  v_is_terminal boolean;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  -- for update: es lo que impide que un doble clic emita dos facturas.
  select * into v_wo from work_orders where work_orders.id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;

  select ws.label, ws.is_terminal into v_status_label, v_is_terminal
    from work_order_statuses ws where ws.id = v_wo.status_id;

  if not coalesce(v_is_terminal, false) then
    raise exception 'Solo se facturan órdenes terminadas (estado actual: %).', coalesce(v_status_label, '—');
  end if;

  if exists (
    select 1 from invoices
    where invoices.work_order_id = p_work_order_id and invoices.status = 'EMITIDA'
  ) then
    raise exception 'La orden % ya tiene una factura emitida.', v_wo.number;
  end if;

  return query
  select * from public._create_invoice(p_work_order_id, v_wo.customer_id, p_items, p_notes, p_emit_remito);
end;
$function$;
