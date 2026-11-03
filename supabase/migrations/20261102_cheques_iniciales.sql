-- Carga inicial de cheques de terceros.
--
-- Los cheques que había en la cartera al empezar a usar la app. Entran igual
-- que un cheque recibido —un ingreso a la cartera en el libro de caja, con su
-- fecha—, pero marcados como saldo inicial y sin concepto: no son una venta
-- ni un cobro de este sistema, son lo que ya se tenía. Desde ahí se depositan,
-- se acreditan, se endosan o se rechazan como cualquier otro.
--
-- Mientras siga en cartera, un cheque inicial cargado por error se puede
-- borrar: se anula su ingreso y desaparece.

alter table public.third_party_checks
  add column if not exists saldo_inicial boolean not null default false;

-- p_cheques: [{ electronico, number, bank_name, drawer, issue_date, due_date, amount, notes }, ...]
-- Todo o nada: si un cheque falla, no se carga ninguno.
create or replace function public.cargar_cheques_iniciales(p_fecha date, p_cheques jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet uuid;
  v_cheque jsonb;
  v_amount numeric(14,2);
  v_electronico boolean;
  v_movement record;
  v_cantidad integer := 0;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  v_wallet := public.checks_wallet_id();
  if v_wallet is null then
    raise exception 'No hay una cartera de cheques cargada. Creala en Medios de pago con el tipo Cartera de cheques.';
  end if;
  if p_fecha is null then
    raise exception 'Indicá la fecha de inicio.';
  end if;
  if coalesce(jsonb_array_length(p_cheques), 0) = 0 then
    raise exception 'No hay cheques para cargar.';
  end if;

  -- El mismo cheque dos veces en la misma carga.
  if exists (
    select 1 from jsonb_array_elements(p_cheques) c
     group by upper(trim(c->>'bank_name')), trim(c->>'number')
    having count(*) > 1
  ) then
    raise exception 'Hay un cheque repetido en la carga (mismo banco y número).';
  end if;

  for v_cheque in select * from jsonb_array_elements(p_cheques) loop
    v_amount := round((v_cheque->>'amount')::numeric, 2);
    v_electronico := coalesce((v_cheque->>'electronico')::boolean, false);

    if coalesce(trim(v_cheque->>'number'), '') = '' then
      raise exception 'Hay un cheque sin número.';
    end if;
    if coalesce(trim(v_cheque->>'bank_name'), '') = '' then
      raise exception 'El cheque % no tiene banco.', trim(v_cheque->>'number');
    end if;
    if nullif(v_cheque->>'due_date', '') is null then
      raise exception 'El cheque % no tiene fecha de cobro.', trim(v_cheque->>'number');
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'El importe del cheque % tiene que ser mayor a cero.', trim(v_cheque->>'number');
    end if;
    if exists (
      select 1 from third_party_checks t
       where upper(t.bank_name) = upper(trim(v_cheque->>'bank_name'))
         and t.number = trim(v_cheque->>'number')
    ) then
      raise exception 'El cheque % del % ya está cargado.', trim(v_cheque->>'number'), trim(v_cheque->>'bank_name');
    end if;

    select * into v_movement from public.post_treasury_movement(
      'INGRESO', p_fecha, null,
      'Saldo inicial — ' || case when v_electronico then 'eCheq ' else 'Cheque ' end
        || trim(v_cheque->>'number') || ' — ' || trim(v_cheque->>'bank_name'),
      nullif(trim(coalesce(v_cheque->>'drawer', '')), ''),
      v_amount,
      jsonb_build_array(jsonb_build_object('payment_method_id', v_wallet, 'amount', v_amount)),
      nullif(trim(coalesce(v_cheque->>'notes', '')), '')
    );

    insert into third_party_checks (
      number, bank_name, drawer, issue_date, due_date, amount,
      status, received_movement_id, notes, created_by, electronico, saldo_inicial
    )
    values (
      trim(v_cheque->>'number'), trim(v_cheque->>'bank_name'),
      nullif(trim(coalesce(v_cheque->>'drawer', '')), ''),
      nullif(v_cheque->>'issue_date', '')::date,
      (v_cheque->>'due_date')::date,
      v_amount, 'EN_CARTERA', v_movement.movement_id,
      nullif(trim(coalesce(v_cheque->>'notes', '')), ''), auth.uid(), v_electronico, true
    );

    v_cantidad := v_cantidad + 1;
  end loop;

  return v_cantidad;
end;
$$;

-- Borra un cheque inicial cargado por error, si todavía está en cartera.
create or replace function public.borrar_cheque_inicial(p_check_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_check from third_party_checks where id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if not v_check.saldo_inicial then
    raise exception 'Solo se borran cheques de la carga inicial.';
  end if;
  if v_check.status <> 'EN_CARTERA' then
    raise exception 'El cheque % ya no está en cartera: no se puede borrar.', v_check.number;
  end if;

  delete from third_party_checks where id = p_check_id;
  if v_check.received_movement_id is not null then
    perform public.void_treasury_movement(v_check.received_movement_id, 'Cheque inicial borrado');
  end if;
end;
$$;

revoke all on function public.cargar_cheques_iniciales(date, jsonb) from public, anon;
revoke all on function public.borrar_cheque_inicial(uuid) from public, anon;
grant execute on function public.cargar_cheques_iniciales(date, jsonb) to authenticated;
grant execute on function public.borrar_cheque_inicial(uuid) to authenticated;

notify pgrst, 'reload schema';
