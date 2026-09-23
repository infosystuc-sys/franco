-- ===========================================================================
-- Una nota de crédito total sobre una factura de contado devuelve la plata
-- ===========================================================================
-- Migración sugerida: revertir_el_cobro_al_acreditar
--
-- Una factura de contado se cobra sola al emitirse: se le arma un recibo con
-- la forma de pago elegida y la plata entra a la caja, al banco o a la cartera
-- de cheques. Si después una nota de crédito la revierte, esa plata dejó de
-- corresponder: el cliente no compró nada.
--
-- Sin esto el saldo quedaba en cero por dos lados a la vez —cobrado y
-- acreditado— y el arqueo mostraba plata en la caja que ya no era del taller.
--
-- ── Cuándo se revierte, y cuándo no ────────────────────────────────────────
-- Solo cuando la reversión es inequívoca:
--
--   · la nota de crédito cancela la factura entera, y
--   · el recibo que la cobró no cobra ninguna otra factura.
--
-- Fuera de eso no se toca nada, y es a propósito. Un recibo puede cubrir
-- varias facturas de una vez: anularlo por una nota de crédito parcial
-- desharía cobros de comprobantes que nadie revirtió. Y una NC parcial sobre
-- una factura ya cobrada no tiene una única respuesta correcta —¿se devuelve
-- plata, o le queda saldo a favor al cliente?—, así que la decide una persona.
--
-- ── Cuándo, en el tiempo ───────────────────────────────────────────────────
-- Al confirmar el CAE, no al crear la nota. Una NC sin CAE no revierte nada:
-- ARCA todavía no la conoce y puede terminar rechazada. Devolver la plata
-- antes de eso sería devolverla por un comprobante que no existe.

-- ---------------------------------------------------------------------------
-- 1. void_receipt también la puede llamar la Edge Function
-- ---------------------------------------------------------------------------
-- Es el mismo motivo que en confirmar_cae: la llave de servicio no representa
-- a ninguna persona, auth.uid() devuelve null y is_admin() da falso. Sin esto
-- la reversión funcionaría cuando la dispara un admin desde la pantalla y
-- fallaría cuando la dispara la función que pide el CAE, que es el camino
-- normal.
create or replace function public.void_receipt(p_receipt_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_receipt receipts%rowtype;
  v_bad record;
  v_change_movement_id uuid;
begin
  if not (public.is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_receipt from receipts where receipts.id = p_receipt_id for update;
  if not found then
    raise exception 'El recibo no existe.';
  end if;
  if v_receipt.status = 'ANULADO' then
    raise exception 'El recibo % ya está anulado.', v_receipt.full_number;
  end if;

  select c.number, c.bank_name, c.status into v_bad
    from receipt_values v
    join third_party_checks c on c.id = v.check_id
   where v.receipt_id = p_receipt_id and c.status <> 'EN_CARTERA'
   limit 1;

  if found then
    raise exception 'El cheque % de % ya está % y no se puede dar de baja. Resolvé el cheque antes de anular el recibo.',
      v_bad.number, v_bad.bank_name, lower(v_bad.status::text);
  end if;

  update invoices
     set paid_amount = invoices.paid_amount - al.amount
    from receipt_allocations al
   where al.receipt_id = p_receipt_id and al.invoice_id = invoices.id;

  update third_party_checks set status = 'ANULADO'
   where third_party_checks.id in (
     select v.check_id from receipt_values v
      where v.receipt_id = p_receipt_id and v.check_id is not null
   );

  update third_party_checks
     set status = 'EN_CARTERA', endorsed_to_customer_id = null
   where third_party_checks.id in (
     select rc.check_id from receipt_changes rc
      where rc.receipt_id = p_receipt_id and rc.check_id is not null
   );

  if v_receipt.treasury_movement_id is not null then
    perform public.void_treasury_movement(
      v_receipt.treasury_movement_id,
      'Anulación del recibo ' || v_receipt.full_number || ': ' || trim(p_reason)
    );
  end if;

  for v_change_movement_id in
    select distinct rc.treasury_movement_id from receipt_changes rc
     where rc.receipt_id = p_receipt_id and rc.treasury_movement_id is not null
  loop
    perform public.void_treasury_movement(
      v_change_movement_id,
      'Anulación del recibo ' || v_receipt.full_number || ': ' || trim(p_reason)
    );
  end loop;

  update receipts
     set status = 'ANULADO',
         voided_at = now(),
         voided_reason = trim(p_reason)
   where receipts.id = p_receipt_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Qué cobros son reversibles sin ambigüedad
-- ---------------------------------------------------------------------------
-- Se expone como función propia para que la pantalla pueda avisar ANTES de
-- emitir qué va a pasar con la plata, en vez de que quien emite se entere
-- después mirando el arqueo.
create or replace function public.cobros_reversibles_de_factura(p_invoice_id uuid)
returns table(receipt_id uuid, full_number text, total_amount numeric)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.full_number, r.total_amount
  from receipts r
  join receipt_allocations al on al.receipt_id = r.id
  where al.invoice_id = p_invoice_id
    and r.status = 'REGISTRADO'
    -- Que no cobre ninguna otra factura: si cubre varias, anularlo desharía
    -- cobros de comprobantes que nadie revirtió.
    and not exists (
      select 1 from receipt_allocations otras
       where otras.receipt_id = r.id and otras.invoice_id <> p_invoice_id
    );
$$;

grant execute on function public.cobros_reversibles_de_factura(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. El CAE de la nota de crédito devuelve la plata
-- ---------------------------------------------------------------------------
create or replace function public.confirmar_cae_nc(
  p_credit_note_id uuid,
  p_cae text,
  p_cae_due_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nc credit_notes%rowtype;
  v_cae text := trim(coalesce(p_cae, ''));
  v_recibo record;
begin
  if not (is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'No autorizado.';
  end if;

  if v_cae !~ '^\d{14}$' then
    raise exception 'El CAE tiene que ser de 14 dígitos.';
  end if;
  if p_cae_due_date is null then
    raise exception 'El CAE tiene que venir con su fecha de vencimiento.';
  end if;

  select * into v_nc from credit_notes where id = p_credit_note_id for update;
  if not found then
    raise exception 'La nota de crédito no existe.';
  end if;
  if v_nc.status <> 'PENDIENTE_CAE' then
    raise exception 'La nota de crédito no está esperando un CAE: está %.', v_nc.status;
  end if;

  update credit_notes
     set status = 'EMITIDA', cae = v_cae, cae_due_date = p_cae_due_date,
         cae_rechazo = null, cae_rechazado_at = null
   where id = p_credit_note_id;

  -- Recién ahora, con el CAE otorgado, la reversión es real. Solo si cancela
  -- la factura entera: una parcial sobre algo ya cobrado la decide una
  -- persona, porque puede terminar en devolución o en saldo a favor.
  if v_nc.cancela_total then
    for v_recibo in select * from public.cobros_reversibles_de_factura(v_nc.invoice_id) loop
      perform public.void_receipt(
        v_recibo.receipt_id,
        'Nota de crédito ' || v_nc.full_number || ' sobre la factura que cobraba'
      );
    end loop;
  end if;
end;
$$;

revoke all on function public.confirmar_cae_nc(uuid, text, date) from public, anon;
grant execute on function public.confirmar_cae_nc(uuid, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select prosrc like '%service_role%' from pg_proc
    where oid = 'public.void_receipt(uuid,text)'::regprocedure) as void_receipt_abierta,
  (select prosrc like '%void_receipt%' from pg_proc
    where oid = 'public.confirmar_cae_nc(uuid,text,date)'::regprocedure) as nc_revierte_cobro;
