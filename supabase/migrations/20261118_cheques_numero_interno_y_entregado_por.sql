-- Cheques de terceros: número interno, quién lo entregó, y eliminar un cheque
-- cargado dos veces.
--
-- 1. Número interno. Cada cheque recibe un número correlativo propio (1, 2,
--    3…), independiente del número del banco. Se anota en el papel y sirve
--    para encontrarlo rápido al cargar una orden de pago. Los que ya estaban
--    se numeran por orden de carga.
--
-- 2. Entregado por. Quién trajo el cheque, que no siempre es el librador. Si
--    entró con una cobranza ya se sabe (el cliente del recibo); este campo es
--    para los que se cargan sueltos (Recibir cheque, carga inicial).
--
-- 3. Eliminar un cheque cargado dos veces. Pasaba así: el cheque se cargó
--    suelto (Recibir cheque) y además entró con la cobranza del cliente. El
--    suelto se usó en un pago y el de la cobranza quedó en cartera, de más.
--    Eliminarlo pedía anular la cobranza, que está bien hecha.
--    Ahora, si el cheque a eliminar entró con una cobranza y hay otro igual
--    (mismo número y mismo importe) cargado suelto, se queda uno solo: la
--    cobranza pasa a apuntar al otro, se anula el ingreso suelto del otro
--    (la cobranza ya lo había ingresado a la cartera) y este se elimina.
--    Además, un cheque que figura en un comprobante anulado ya no se puede
--    borrar de la tabla: en ese caso queda ANULADO en vez de desaparecer.

-- ---------------------------------------------------------------------------
-- Columnas
-- ---------------------------------------------------------------------------
alter table public.third_party_checks add column if not exists entregado_por text;
alter table public.third_party_checks add column if not exists numero_interno integer;

create sequence if not exists public.third_party_checks_numero_interno_seq;

with orden as (
  select id, row_number() over (order by created_at, id) as n
    from public.third_party_checks
   where numero_interno is null
)
update public.third_party_checks t
   set numero_interno = orden.n + coalesce((select max(numero_interno) from public.third_party_checks), 0)
  from orden
 where t.id = orden.id;

select setval('public.third_party_checks_numero_interno_seq',
              coalesce((select max(numero_interno) from public.third_party_checks), 0) + 1, false);

alter table public.third_party_checks
  alter column numero_interno set default nextval('public.third_party_checks_numero_interno_seq');
alter sequence public.third_party_checks_numero_interno_seq owned by public.third_party_checks.numero_interno;
alter table public.third_party_checks alter column numero_interno set not null;

create unique index if not exists third_party_checks_numero_interno_unico
  on public.third_party_checks (numero_interno);

-- ---------------------------------------------------------------------------
-- Quién lo entregó, para un cheque recién recibido
-- ---------------------------------------------------------------------------
create or replace function public.asignar_entregado_por(p_check_id uuid, p_nombre text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  update third_party_checks
     set entregado_por = nullif(trim(coalesce(p_nombre, '')), '')
   where id = p_check_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Modificar: igual que antes, más "entregado por"; las cobranzas anuladas
-- y los cheques anulados no cuentan.
-- ---------------------------------------------------------------------------
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
  if v_check.status = 'ANULADO' then
    raise exception 'El cheque está anulado: no se puede modificar.';
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

  if v_amount <> v_check.amount then
    select r.full_number into v_recibo
      from receipt_values rv join receipts r on r.id = rv.receipt_id
     where rv.check_id = p_check_id and r.status <> 'ANULADO'
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
         entregado_por = case when p_datos ? 'entregado_por'
                              then nullif(trim(coalesce(p_datos->>'entregado_por', '')), '')
                              else entregado_por end,
         received_movement_id = v_check.received_movement_id
   where id = p_check_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Eliminar, con el caso del cheque cargado dos veces
-- ---------------------------------------------------------------------------
-- Devuelve qué hizo: 'ELIMINADO', 'ANULADO' (figuraba en un comprobante
-- anulado y no se puede borrar) o 'UNIFICADO' (era un duplicado de otro).
drop function if exists public.eliminar_cheque(uuid);

create or replace function public.eliminar_cheque(p_check_id uuid, p_conservar uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
  v_otro third_party_checks%rowtype;
  v_otro_id uuid;
  v_recibo text;
  v_cuantos integer;
  v_resultado text := 'ELIMINADO';
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
   where rv.check_id = p_check_id and r.status <> 'ANULADO'
   limit 1;

  if v_recibo is not null then
    -- Entró con una cobranza vigente. Solo se puede sacar si es el duplicado
    -- de otro cheque igual cargado suelto: ese pasa a ser el de la cobranza.
    if p_conservar is not null then
      v_otro_id := p_conservar;
    else
      select count(*), min(t.id::text)::uuid into v_cuantos, v_otro_id
        from third_party_checks t
       where t.id <> p_check_id
         and t.status <> 'ANULADO'
         and trim(t.number) = trim(v_check.number)
         and t.amount = v_check.amount
         and not exists (
           select 1 from receipt_values rv join receipts r on r.id = rv.receipt_id
            where rv.check_id = t.id and r.status <> 'ANULADO');
      if v_cuantos = 0 then
        raise exception 'El cheque % entró con la cobranza %: para sacarlo, anulá esa cobranza.', v_check.number, v_recibo;
      end if;
      if v_cuantos > 1 then
        raise exception 'El cheque % entró con la cobranza % y hay % cheques iguales cargados aparte: no sé con cuál quedarme.', v_check.number, v_recibo, v_cuantos;
      end if;
    end if;

    select * into v_otro from third_party_checks where id = v_otro_id for update;
    if not found or v_otro.id = p_check_id then
      raise exception 'No se encontró el cheque con el que quedarse.';
    end if;
    if trim(v_otro.number) <> trim(v_check.number) or v_otro.amount <> v_check.amount then
      raise exception 'Los dos cheques no son iguales (número o importe distintos).';
    end if;
    if v_otro.received_movement_id is null then
      raise exception 'El cheque % entró con la cobranza %, y el otro igual no tiene un ingreso de caja propio: para sacarlo, anulá esa cobranza.', v_check.number, v_recibo;
    end if;

    -- La cobranza ya ingresó el cheque a la cartera: el ingreso suelto del
    -- otro sobra. Y la cobranza pasa a apuntar al otro.
    if exists (select 1 from treasury_movements where id = v_otro.received_movement_id and status <> 'ANULADO') then
      perform public.void_treasury_movement(v_otro.received_movement_id,
        'Cheque ' || v_check.number || ' cargado dos veces: queda el de la cobranza ' || v_recibo);
    end if;
    update third_party_checks
       set received_movement_id = null,
           entregado_por = coalesce(entregado_por, v_check.entregado_por)
     where id = v_otro.id;
    update receipt_values set check_id = v_otro.id where check_id = p_check_id;
    v_resultado := 'UNIFICADO';
  end if;

  if v_check.received_movement_id is not null
     and exists (select 1 from treasury_movements where id = v_check.received_movement_id and status <> 'ANULADO') then
    perform public.void_treasury_movement(v_check.received_movement_id, 'Cheque ' || v_check.number || ' eliminado');
  end if;

  -- Si figura en algún comprobante (aunque esté anulado) no se puede borrar
  -- de la tabla: queda anulado.
  if exists (select 1 from payment_order_values where check_id = p_check_id)
     or exists (select 1 from receipt_values where check_id = p_check_id)
     or exists (select 1 from receipt_changes where check_id = p_check_id) then
    update third_party_checks
       set status = 'ANULADO',
           notes = trim(coalesce(notes || ' — ', '') || 'Eliminado el ' || to_char(now(), 'DD/MM/YYYY'))
     where id = p_check_id;
    if v_resultado = 'ELIMINADO' then
      v_resultado := 'ANULADO';
    end if;
  else
    delete from third_party_checks where id = p_check_id;
  end if;

  return v_resultado;
end;
$$;

revoke all on function public.asignar_entregado_por(uuid, text) from public, anon;
revoke all on function public.modificar_cheque(uuid, jsonb) from public, anon;
revoke all on function public.eliminar_cheque(uuid, uuid) from public, anon;
grant execute on function public.asignar_entregado_por(uuid, text) to authenticated;
grant execute on function public.modificar_cheque(uuid, jsonb) to authenticated;
grant execute on function public.eliminar_cheque(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
