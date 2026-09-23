-- ===========================================================================
-- Una nota de crédito total devuelve la orden a "sin facturar"
-- ===========================================================================
-- Migración sugerida: ot_facturable_tras_nc
--
-- Si una nota de crédito cancela la factura entera, el trabajo de esa orden
-- quedó sin comprobante que lo respalde y hay que poder volver a facturarlo.
-- Hasta ahora no se podía: la regla "una OT, una factura" mira el estado de la
-- factura, y una revertida sigue EMITIDA.
--
-- Y tiene que seguir EMITIDA. Ahí está la diferencia con anular: ARCA le dio
-- un CAE, va en el Libro IVA Ventas y existe para siempre. Lo que cambió no es
-- la factura sino lo que respalda: nada.
--
-- Por eso una marca aparte en vez de tocarle el estado. invoices.revertida_por_nc
-- dice "esta factura existe pero ya no respalda su orden", que es exactamente
-- lo que pasó, y deja el estado contando la verdad fiscal.
--
-- La lleva un disparador y no quien emite: se recalcula desde las notas que
-- existen de verdad, así da igual por qué camino se autorizó una.

alter table invoices
  add column if not exists revertida_por_nc boolean not null default false;

comment on column invoices.revertida_por_nc is
  'Una nota de crédito la cancela entera. Sigue siendo fiscalmente válida, '
  'pero ya no respalda su orden de trabajo, que vuelve a ser facturable.';

create or replace function public._marcar_factura_revertida()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  update invoices i
     set revertida_por_nc = exists (
       select 1 from credit_notes nc
        where nc.invoice_id = v_invoice
          and nc.cancela_total
          and nc.status = 'EMITIDA'
     )
   where i.id = v_invoice;
  return null;
end;
$$;

drop trigger if exists credit_notes_marcar_revertida on credit_notes;
create trigger credit_notes_marcar_revertida
after insert or update or delete on credit_notes
for each row execute function public._marcar_factura_revertida();

-- ---------------------------------------------------------------------------
-- "Una OT, una factura" deja de contar las revertidas
-- ---------------------------------------------------------------------------
drop index if exists public.invoices_una_activa_por_ot;

create unique index invoices_una_activa_por_ot
  on public.invoices (work_order_id)
  where status <> 'ANULADA' and not revertida_por_nc;

-- ---------------------------------------------------------------------------
-- El mensaje en castellano tiene que mirar lo mismo que el índice
-- ---------------------------------------------------------------------------
create or replace function public.issue_invoice(
  p_work_order_id uuid,
  p_items jsonb,
  p_notes text default null,
  p_emit_remito boolean default false,
  p_invoice_type invoice_type default 'X'::invoice_type,
  p_condicion text default null,
  p_due_date date default null
)
returns table(invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_wo work_orders%rowtype;
  v_existente invoices%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_wo from work_orders where work_orders.id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;

  select * into v_existente from invoices
  where invoices.work_order_id = p_work_order_id
    and invoices.status <> 'ANULADA'
    and not invoices.revertida_por_nc
  limit 1;

  if found then
    if v_existente.status = 'PENDIENTE_CAE' then
      raise exception 'La orden % ya tiene la factura % esperando el CAE de ARCA.',
        v_wo.number, v_existente.full_number;
    else
      raise exception 'La orden % ya tiene una factura emitida.', v_wo.number;
    end if;
  end if;

  return query
  select * from public._create_invoice(
    p_work_order_id, v_wo.customer_id, p_items, p_notes, p_emit_remito,
    null::uuid, p_invoice_type, p_condicion, p_due_date
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_name = 'invoices' and column_name = 'revertida_por_nc') as columna,
  (select indexdef like '%revertida_por_nc%' from pg_indexes
    where indexname = 'invoices_una_activa_por_ot') as indice_la_mira,
  (select prosrc like '%revertida_por_nc%' from pg_proc
    where oid = 'public.issue_invoice(uuid,jsonb,text,boolean,invoice_type,text,date)'::regprocedure) as issue_invoice_la_mira;
