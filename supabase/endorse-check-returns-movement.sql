-- endorse_check devolvía void: la pantalla nueva de endoso de cheques
-- (Tesorería → Endosar cheques) quiere mostrar el número de comprobante
-- generado en la confirmación, igual que ya hace receive_check con el suyo.
-- La lógica interna (validaciones, generación del comprobante de egreso,
-- actualización del cheque) queda exactamente igual — solo se agrega el
-- return final. Postgres no permite cambiar el tipo de retorno con
-- create or replace, así que se dropea y se recrea.
--
-- Ya aplicado contra la base viva el 2026-08-31.
drop function public.endorse_check(uuid, uuid, date);

create function public.endorse_check(
  p_check_id uuid,
  p_supplier_id uuid,
  p_date date default current_date
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
  v_supplier suppliers%rowtype;
  v_wallet uuid;
  v_movement record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_check from third_party_checks
   where third_party_checks.id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if v_check.status <> 'EN_CARTERA' then
    raise exception 'Solo se endosan cheques en cartera (estado actual: %).', v_check.status;
  end if;

  select * into v_supplier from suppliers where suppliers.id = p_supplier_id;
  if not found then
    raise exception 'El proveedor no existe.';
  end if;

  v_wallet := public.checks_wallet_id();

  select * into v_movement from public.post_treasury_movement(
    'EGRESO', coalesce(p_date, current_date), null,
    'Endoso cheque ' || v_check.number || ' — ' || v_check.bank_name,
    v_supplier.name, v_check.amount,
    jsonb_build_array(
      jsonb_build_object('payment_method_id', v_wallet, 'amount', -v_check.amount)
    )
  );

  update third_party_checks
     set status = 'ENDOSADO', endorsed_to_supplier_id = p_supplier_id
   where third_party_checks.id = p_check_id;

  return v_movement.movement_full_number;
end;
$$;

revoke all on function public.endorse_check(uuid, uuid, date) from public, anon;
grant execute on function public.endorse_check(uuid, uuid, date) to authenticated;
