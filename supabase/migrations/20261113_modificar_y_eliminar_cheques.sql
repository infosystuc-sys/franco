-- Cheques: corregir los datos de un cheque cargado y eliminar uno cargado por
-- error.
--
-- Modificar:
--   * Número, banco, librador, fechas, observaciones y si es electrónico se
--     corrigen siempre, esté donde esté el cheque: son datos del papel.
--   * El importe solo mientras siga en cartera y si entró suelto (Cheques →
--     Nuevo, o la carga inicial). Se anula el ingreso de caja que generó y se
--     registra otro con el importe nuevo, con la misma fecha y concepto.
--     Un cheque que entró con una cobranza tiene el importe atado a ese recibo:
--     para cambiarlo hay que anular la cobranza y volver a hacerla.
--
-- Eliminar:
--   * Solo un cheque en cartera (si ya se depositó o endosó, primero hay que
--     deshacer eso) y que no haya entrado con una cobranza. Se anula su
--     ingreso de caja y el cheque desaparece.

create or replace function public.modificar_cheque(p_check_id uuid, p_datos jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
  v_mov treasury_movements%rowtype;
  v_recibo text;
  v_number text := trim(coalesce(p_datos->>'number', ''));
  v_bank text := trim(coalesce(p_datos->>'bank_name', ''));
  v_electronico boolean := coalesce((p_datos->>'electronico')::boolean, false);
  v_amount numeric(14,2) := round((p_datos->>'amount')::numeric, 2);
  v_descripcion text;
  v_nuevo record;
  v_wallet uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_check from third_party_checks where id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;

  if v_number = '' then
    raise exception 'Indicá el número del cheque.';
  end if;
  if v_bank = '' then
    raise exception 'Indicá el banco del cheque.';
  end if;
  if nullif(p_datos->>'due_date', '') is null then
    raise exception 'Indicá la fecha de cobro del cheque.';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'El importe del cheque tiene que ser mayor a cero.';
  end if;
  if exists (
    select 1 from third_party_checks t
     where t.id <> p_check_id
       and upper(t.bank_name) = upper(v_bank)
       and t.number = v_number
  ) then
    raise exception 'Ya hay otro cheque % del %.', v_number, v_bank;
  end if;

  v_descripcion := case when v_check.saldo_inicial then 'Saldo inicial — ' else '' end
    || case when v_electronico then 'eCheq ' else 'Cheque ' end || v_number || ' — ' || v_bank;

  -- El importe.
  if v_amount <> v_check.amount then
    select r.full_number into v_recibo
      from receipt_values rv join receipts r on r.id = rv.receipt_id
     where rv.check_id = p_check_id
     limit 1;
    if v_recibo is not null then
      raise exception 'El importe de este cheque sale de la cobranza %: para cambiarlo, anulá esa cobranza y hacela de nuevo.', v_recibo;
    end if;
    if v_check.status <> 'EN_CARTERA' then
      raise exception 'El cheque ya no está en cartera: el importe no se puede cambiar.';
    end if;
    if v_check.received_movement_id is null then
      raise exception 'Este cheque no tiene un ingreso de caja propio: el importe no se puede cambiar desde acá.';
    end if;

    v_wallet := public.checks_wallet_id();
    select * into v_mov from treasury_movements where id = v_check.received_movement_id;
    if v_mov.status <> 'ANULADO' then
      perform public.void_treasury_movement(v_mov.id, 'Cheque corregido: importe de ' || v_check.amount || ' a ' || v_amount);
    end if;
    select * into v_nuevo from public.post_treasury_movement(
      'INGRESO', v_mov.movement_date, v_mov.concept_id, v_descripcion,
      nullif(trim(coalesce(p_datos->>'drawer', '')), ''),
      v_amount,
      jsonb_build_array(jsonb_build_object('payment_method_id', v_wallet, 'amount', v_amount)),
      v_mov.notes
    );
    v_check.received_movement_id := v_nuevo.movement_id;
  elsif v_check.received_movement_id is not null then
    -- Que el libro de caja muestre el número y el banco corregidos.
    update treasury_movements
       set description = v_descripcion,
           payee = nullif(trim(coalesce(p_datos->>'drawer', '')), '')
     where id = v_check.received_movement_id;
  end if;

  update third_party_checks
     set number = v_number,
         bank_name = v_bank,
         drawer = nullif(trim(coalesce(p_datos->>'drawer', '')), ''),
         issue_date = nullif(p_datos->>'issue_date', '')::date,
         due_date = (p_datos->>'due_date')::date,
         amount = v_amount,
         electronico = v_electronico,
         notes = nullif(trim(coalesce(p_datos->>'notes', '')), ''),
         received_movement_id = v_check.received_movement_id
   where id = p_check_id;
end;
$$;

create or replace function public.eliminar_cheque(p_check_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
  v_recibo text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_check from third_party_checks where id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if v_check.status <> 'EN_CARTERA' then
    raise exception 'El cheque % ya no está en cartera (está %): no se puede eliminar.',
      v_check.number, lower(replace(v_check.status::text, '_', ' '));
  end if;

  select r.full_number into v_recibo
    from receipt_values rv join receipts r on r.id = rv.receipt_id
   where rv.check_id = p_check_id
   limit 1;
  if v_recibo is not null then
    raise exception 'El cheque % entró con la cobranza %: para sacarlo, anulá esa cobranza.', v_check.number, v_recibo;
  end if;

  delete from third_party_checks where id = p_check_id;
  if v_check.received_movement_id is not null
     and exists (select 1 from treasury_movements where id = v_check.received_movement_id and status <> 'ANULADO') then
    perform public.void_treasury_movement(v_check.received_movement_id, 'Cheque ' || v_check.number || ' eliminado');
  end if;
end;
$$;

revoke all on function public.modificar_cheque(uuid, jsonb) from public, anon;
revoke all on function public.eliminar_cheque(uuid) from public, anon;
grant execute on function public.modificar_cheque(uuid, jsonb) to authenticated;
grant execute on function public.eliminar_cheque(uuid) to authenticated;

notify pgrst, 'reload schema';
