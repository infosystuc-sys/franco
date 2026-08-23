-- DieselPro ERP — tesorería, fase 3: cheques de terceros
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de treasury-movements.sql.
-- Este archivo queda además como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-23-tesoreria-design.md
--
-- CORRECCIÓN AL DISEÑO ORIGINAL:
--   El diseño decía que el saldo de la cartera saldría de los cheques en
--   cartera. No cierra: un cheque rechazado vuelve a contar como valor pero
--   su estado ya no es EN_CARTERA, así que habría dos reglas peleándose por
--   el mismo número. La cartera calcula su saldo por partidas, como cualquier
--   otro medio; lo que cambia es que sus partidas las generan las operaciones
--   de acá y no la carga manual, que save_treasury_movement sigue rechazando.
--
-- Ciclo de vida:
--   EN CARTERA ─┬─ Depositar → DEPOSITADO ─┬→ ACREDITADO
--               │                          └→ RECHAZADO
--               └─ Endosar   → ENDOSADO
--
--   La plata entra al banco al ACREDITAR, no al depositar: hasta que el banco
--   no confirma, los fondos no existen. Mientras está depositado el valor
--   sigue contando en la cartera, que es donde realmente está el riesgo.


-- ===========================================================================
-- 1) Postear un movimiento: la parte común
-- ===========================================================================
-- save_treasury_movement y las operaciones de cheques necesitan lo mismo:
-- tomar el correlativo e insertar cabecera y partidas. Se extrae acá para que
-- la numeración exista en un solo lugar y no pueda divergir entre las dos.
--
-- No se expone: es plomería interna. Las validaciones de que las partidas
-- cuadren siguen viviendo en quien llama, porque son distintas en cada caso.
create or replace function public.post_treasury_movement(
  p_type treasury_movement_type,
  p_date date,
  p_concept_id uuid,
  p_description text,
  p_payee text,
  p_amount numeric,
  p_legs jsonb,
  p_notes text default null
)
returns table (movement_id uuid, movement_full_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number int;
  v_new_id uuid;
  v_full_number text;
begin
  insert into treasury_sequences (movement_type, last_number)
  values (p_type, 1)
  on conflict (movement_type)
    do update set last_number = treasury_sequences.last_number + 1
  returning treasury_sequences.last_number into v_number;

  insert into treasury_movements (
    movement_type, number, full_number, status, movement_date,
    concept_id, description, payee, amount, notes, created_by
  )
  values (
    p_type, v_number,
    case p_type
      when 'EGRESO' then 'EG-'
      when 'INGRESO' then 'IN-'
      else 'TR-'
    end || lpad(v_number::text, 8, '0'),
    'REGISTRADO', coalesce(p_date, current_date),
    p_concept_id, p_description,
    nullif(trim(coalesce(p_payee, '')), ''),
    round(p_amount, 2),
    nullif(trim(coalesce(p_notes, '')), ''),
    auth.uid()
  )
  returning treasury_movements.id, treasury_movements.full_number
       into v_new_id, v_full_number;

  insert into treasury_movement_legs (movement_id, payment_method_id, amount)
  select v_new_id, (leg->>'payment_method_id')::uuid, round((leg->>'amount')::numeric, 2)
  from jsonb_array_elements(p_legs) as leg;

  return query select v_new_id, v_full_number;
end;
$$;

revoke all on function public.post_treasury_movement(
  treasury_movement_type, date, uuid, text, text, numeric, jsonb, text
) from public, anon, authenticated;


-- ===========================================================================
-- 2) Los cheques
-- ===========================================================================
create type check_status as enum (
  'EN_CARTERA', 'DEPOSITADO', 'ACREDITADO', 'RECHAZADO', 'ENDOSADO'
);

create table third_party_checks (
  id uuid primary key default gen_random_uuid(),

  number text not null,
  bank_name text not null,
  -- Quién lo firmó. Texto libre: no siempre es un cliente del padrón.
  drawer text,
  issue_date date,
  -- Fecha de cobro. Es la que importa: un cheque diferido no se puede
  -- depositar antes.
  due_date date not null,
  amount numeric(14,2) not null check (amount > 0),

  status check_status not null default 'EN_CARTERA',

  -- Trazabilidad de dónde salió y adónde fue.
  received_movement_id uuid references treasury_movements(id) on delete restrict,
  deposited_to_id uuid references payment_methods(id) on delete restrict,
  deposited_at date,
  endorsed_to_supplier_id uuid references suppliers(id) on delete restrict,
  rejected_reason text,

  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cargar dos veces el mismo cheque infla la cartera igual que una factura
-- repetida infla la deuda. El mismo número puede repetirse entre bancos
-- distintos, así que la clave es el par.
create unique index third_party_checks_sin_duplicados
  on third_party_checks (upper(bank_name), number);

create index third_party_checks_status_idx on third_party_checks (status);
create index third_party_checks_due_idx on third_party_checks (due_date);

create trigger third_party_checks_set_updated_at
before update on third_party_checks
for each row execute function set_updated_at();

alter table third_party_checks enable row level security;
create policy "solo admin" on third_party_checks for select to authenticated using (is_admin());
-- Sin políticas de escritura: se escribe solo por las RPC de abajo, que son
-- las que mantienen el estado y las partidas consistentes entre sí.


-- ===========================================================================
-- 3) La cartera
-- ===========================================================================
-- Helper: cuál es el medio de pago de tipo cartera. Hay uno solo, garantizado
-- por el índice payment_methods_una_cartera.
create or replace function public.checks_wallet_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from payment_methods where kind = 'CARTERA_CHEQUES' limit 1;
$$;


-- ===========================================================================
-- 4) Recibir un cheque
-- ===========================================================================
-- Entra un valor a la cartera. Genera su ingreso, así el cheque aparece en el
-- libro de caja y no solo en su propia pantalla.
create or replace function public.receive_check(p_check jsonb)
returns table (check_id uuid, check_movement_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet uuid;
  v_amount numeric(14,2);
  v_date date;
  v_new_id uuid;
  v_movement record;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  v_wallet := public.checks_wallet_id();
  if v_wallet is null then
    raise exception 'No hay una cartera de cheques cargada. Creala en Medios de pago con el tipo Cartera de cheques.';
  end if;

  v_amount := round((p_check->>'amount')::numeric, 2);
  if v_amount is null or v_amount <= 0 then
    raise exception 'El importe del cheque tiene que ser mayor a cero.';
  end if;
  if coalesce(trim(p_check->>'number'), '') = '' then
    raise exception 'Indicá el número del cheque.';
  end if;
  if coalesce(trim(p_check->>'bank_name'), '') = '' then
    raise exception 'Indicá el banco del cheque.';
  end if;
  if (p_check->>'due_date') is null then
    raise exception 'Indicá la fecha de cobro del cheque.';
  end if;

  v_date := coalesce((p_check->>'received_date')::date, current_date);

  select * into v_movement from public.post_treasury_movement(
    'INGRESO', v_date,
    nullif(p_check->>'concept_id', '')::uuid,
    'Cheque ' || (p_check->>'number') || ' — ' || (p_check->>'bank_name'),
    nullif(trim(coalesce(p_check->>'drawer', '')), ''),
    v_amount,
    jsonb_build_array(jsonb_build_object('payment_method_id', v_wallet, 'amount', v_amount)),
    nullif(trim(coalesce(p_check->>'notes', '')), '')
  );

  insert into third_party_checks (
    number, bank_name, drawer, issue_date, due_date, amount,
    status, received_movement_id, notes, created_by
  )
  values (
    trim(p_check->>'number'), trim(p_check->>'bank_name'),
    nullif(trim(coalesce(p_check->>'drawer', '')), ''),
    (p_check->>'issue_date')::date,
    (p_check->>'due_date')::date,
    v_amount, 'EN_CARTERA', v_movement.movement_id,
    nullif(trim(coalesce(p_check->>'notes', '')), ''), auth.uid()
  )
  returning third_party_checks.id into v_new_id;

  return query select v_new_id, v_movement.movement_full_number;
end;
$$;

revoke all on function public.receive_check(jsonb) from public, anon;
grant execute on function public.receive_check(jsonb) to authenticated;


-- ===========================================================================
-- 5) Depositar
-- ===========================================================================
-- Solo cambia el estado y deja anotado en qué banco se depositó. NO mueve
-- plata: hasta que el banco no acredita, los fondos no existen y el valor
-- sigue en riesgo, así que sigue contando en la cartera.
create or replace function public.deposit_check(
  p_check_id uuid,
  p_bank_method_id uuid,
  p_date date default current_date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
  v_kind payment_method_kind;
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
    raise exception 'Solo se depositan cheques en cartera (estado actual: %).', v_check.status;
  end if;

  select kind into v_kind from payment_methods where id = p_bank_method_id and active;
  if not found then
    raise exception 'La cuenta de destino no existe o está inactiva.';
  end if;
  -- Un cheque se deposita en un banco. Sin esta guarda se podría "depositar"
  -- en la caja chica, que no significa nada.
  if v_kind <> 'BANCO' then
    raise exception 'Un cheque se deposita en una cuenta bancaria, no en un medio de tipo %.', v_kind;
  end if;

  update third_party_checks
     set status = 'DEPOSITADO',
         deposited_to_id = p_bank_method_id,
         deposited_at = coalesce(p_date, current_date)
   where third_party_checks.id = p_check_id;
end;
$$;

revoke all on function public.deposit_check(uuid, uuid, date) from public, anon;
grant execute on function public.deposit_check(uuid, uuid, date) to authenticated;


-- ===========================================================================
-- 6) Acreditar
-- ===========================================================================
-- Acá sí entra la plata: sale de la cartera y entra al banco.
create or replace function public.credit_check(
  p_check_id uuid,
  p_date date default current_date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
  v_wallet uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_check from third_party_checks
   where third_party_checks.id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if v_check.status <> 'DEPOSITADO' then
    raise exception 'Solo se acreditan cheques depositados (estado actual: %).', v_check.status;
  end if;

  v_wallet := public.checks_wallet_id();

  perform public.post_treasury_movement(
    'TRANSFERENCIA', coalesce(p_date, current_date), null,
    'Acreditación cheque ' || v_check.number || ' — ' || v_check.bank_name,
    v_check.drawer, v_check.amount,
    jsonb_build_array(
      jsonb_build_object('payment_method_id', v_wallet, 'amount', -v_check.amount),
      jsonb_build_object('payment_method_id', v_check.deposited_to_id, 'amount', v_check.amount)
    )
  );

  update third_party_checks set status = 'ACREDITADO'
   where third_party_checks.id = p_check_id;
end;
$$;

revoke all on function public.credit_check(uuid, date) from public, anon;
grant execute on function public.credit_check(uuid, date) to authenticated;


-- ===========================================================================
-- 7) Rechazar
-- ===========================================================================
-- El cheque rebota y su valor vuelve a la cartera: normalmente se le reclama
-- al cliente o se lo reemplaza, así que el valor sigue existiendo hasta que
-- se decida darlo de baja.
--
-- Si todavía no estaba acreditado no hay plata que devolver, porque nunca
-- salió de la cartera: solo cambia el estado.
create or replace function public.reject_check(
  p_check_id uuid,
  p_reason text,
  p_date date default current_date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
  v_wallet uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo del rechazo.';
  end if;

  select * into v_check from third_party_checks
   where third_party_checks.id = p_check_id for update;
  if not found then
    raise exception 'El cheque no existe.';
  end if;
  if v_check.status not in ('DEPOSITADO', 'ACREDITADO') then
    raise exception 'Solo rebotan los cheques depositados o acreditados (estado actual: %).', v_check.status;
  end if;

  -- Solo hay que devolver plata si había salido de la cartera, y eso pasó
  -- únicamente si el cheque llegó a acreditarse.
  if v_check.status = 'ACREDITADO' then
    v_wallet := public.checks_wallet_id();
    perform public.post_treasury_movement(
      'TRANSFERENCIA', coalesce(p_date, current_date), null,
      'Rechazo cheque ' || v_check.number || ' — ' || v_check.bank_name,
      v_check.drawer, v_check.amount,
      jsonb_build_array(
        jsonb_build_object('payment_method_id', v_check.deposited_to_id, 'amount', -v_check.amount),
        jsonb_build_object('payment_method_id', v_wallet, 'amount', v_check.amount)
      ),
      trim(p_reason)
    );
  end if;

  update third_party_checks
     set status = 'RECHAZADO', rejected_reason = trim(p_reason)
   where third_party_checks.id = p_check_id;
end;
$$;

revoke all on function public.reject_check(uuid, text, date) from public, anon;
grant execute on function public.reject_check(uuid, text, date) to authenticated;


-- ===========================================================================
-- 8) Endosar
-- ===========================================================================
-- El cheque se entrega a un proveedor y sale de la cartera. No pasa por
-- ninguna caja: es un valor que cambia de manos.
create or replace function public.endorse_check(
  p_check_id uuid,
  p_supplier_id uuid,
  p_date date default current_date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check third_party_checks%rowtype;
  v_supplier suppliers%rowtype;
  v_wallet uuid;
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

  perform public.post_treasury_movement(
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
end;
$$;

revoke all on function public.endorse_check(uuid, uuid, date) from public, anon;
grant execute on function public.endorse_check(uuid, uuid, date) to authenticated;


comment on table third_party_checks is
  'Cheques de terceros recibidos. El saldo de la cartera NO sale de esta '
  'tabla sino de las partidas, como cualquier otro medio: las operaciones de '
  'acá son las que generan esas partidas.';

comment on column third_party_checks.due_date is
  'Fecha de cobro. Un cheque diferido no se puede depositar antes.';


-- ===========================================================================
-- 9) save_treasury_movement pasa a usar el helper
-- ===========================================================================
-- Reemplaza la versión de la fase 2, que tenía su propia copia de la
-- numeración y del insert. Con post_treasury_movement extraído, dejarla como
-- estaba significaría dos lugares donde se toma el correlativo, que tarde o
-- temprano se despegan.
--
-- Las validaciones se quedan acá: son las de la carga manual, distintas de
-- las de una operación de cheques. Y la carga manual sigue sin poder tocar la
-- cartera: sus movimientos salen de las funciones de arriba.
create or replace function public.save_treasury_movement(
  p_header jsonb,
  p_legs jsonb
)
returns table (movement_id uuid, movement_full_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type treasury_movement_type;
  v_amount numeric(14,2);
  v_sum numeric(14,2);
  v_positives numeric(14,2);
  v_negatives numeric(14,2);
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  v_type := (p_header->>'movement_type')::treasury_movement_type;
  v_amount := (p_header->>'amount')::numeric;

  if v_amount is null or v_amount <= 0 then
    raise exception 'El importe del movimiento tiene que ser mayor a cero.';
  end if;

  if p_legs is null or jsonb_array_length(p_legs) = 0 then
    raise exception 'El movimiento no tiene medios de pago cargados.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_legs) as leg
     where not exists (
       select 1 from payment_methods pm
        where pm.id = nullif(leg->>'payment_method_id', '')::uuid and pm.active
     )
  ) then
    raise exception 'Alguna partida apunta a un medio de pago que no existe o está inactivo.';
  end if;

  -- La cartera no se mueve a mano: sus partidas las generan las operaciones
  -- de cheques, que además mantienen el estado de cada valor. Una partida
  -- suelta acá dejaría el saldo sin ningún cheque que lo respalde.
  if exists (
    select 1 from jsonb_array_elements(p_legs) as leg
     join payment_methods pm on pm.id = (leg->>'payment_method_id')::uuid
    where pm.kind = 'CARTERA_CHEQUES'
  ) then
    raise exception 'La cartera de cheques se mueve desde la pantalla de Cheques: recibir, depositar, acreditar o endosar.';
  end if;

  select
    coalesce(sum(round((leg->>'amount')::numeric, 2)), 0),
    coalesce(sum(round((leg->>'amount')::numeric, 2))
             filter (where round((leg->>'amount')::numeric, 2) > 0), 0),
    coalesce(sum(round((leg->>'amount')::numeric, 2))
             filter (where round((leg->>'amount')::numeric, 2) < 0), 0)
  into v_sum, v_positives, v_negatives
  from jsonb_array_elements(p_legs) as leg;

  if v_type = 'EGRESO' then
    if v_positives <> 0 then
      raise exception 'Un egreso no puede tener partidas que sumen a un medio de pago.';
    end if;
    if v_sum <> -v_amount then
      raise exception 'Las partidas suman $ % y el egreso dice $ %.', abs(v_sum), v_amount;
    end if;

  elsif v_type = 'INGRESO' then
    if v_negatives <> 0 then
      raise exception 'Un ingreso no puede tener partidas que resten de un medio de pago.';
    end if;
    if v_sum <> v_amount then
      raise exception 'Las partidas suman $ % y el ingreso dice $ %.', v_sum, v_amount;
    end if;

  else -- TRANSFERENCIA
    if jsonb_array_length(p_legs) < 2 then
      raise exception 'Una transferencia necesita al menos un origen y un destino.';
    end if;
    if v_sum <> 0 then
      raise exception 'Una transferencia tiene que sumar cero: lo que sale de un medio entra en otro.';
    end if;
    if v_positives <> v_amount then
      raise exception 'La transferencia mueve $ % pero dice $ %.', v_positives, v_amount;
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_legs) as leg
      group by leg->>'payment_method_id'
      having count(*) > 1
    ) then
      raise exception 'Una transferencia no puede repetir el mismo medio de pago en dos partidas.';
    end if;
  end if;

  return query
  select m.movement_id, m.movement_full_number
    from public.post_treasury_movement(
      v_type,
      coalesce((p_header->>'movement_date')::date, current_date),
      nullif(p_header->>'concept_id', '')::uuid,
      p_header->>'description',
      p_header->>'payee',
      v_amount,
      p_legs,
      p_header->>'notes'
    ) as m;
end;
$$;

revoke all on function public.save_treasury_movement(jsonb, jsonb) from public, anon;
grant execute on function public.save_treasury_movement(jsonb, jsonb) to authenticated;
