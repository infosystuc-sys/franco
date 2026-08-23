-- DieselPro ERP — tesorería, fase 2: movimientos y saldos
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de treasury-methods.sql.
-- Este archivo queda además como registro del esquema.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-08-23-tesoreria-design.md
--
-- Modelo:
--   Un movimiento tiene una cabecera y UNA O MÁS PARTIDAS, cada una con su
--   medio de pago y su importe con signo. Un gasto tiene una partida
--   negativa; una transferencia tiene dos que suman cero.
--
--   Se eligió sobre columnas fijas de origen y destino por dos razones: el
--   saldo de cualquier medio pasa a ser "saldo inicial + suma de sus
--   partidas", sin casos especiales; y cuando llegue pagos, un pago con parte
--   en efectivo y parte en cheque entra sin tocar el modelo.
--
--   Esta fase todavía NO permite mover la cartera de cheques: un cheque es un
--   objeto con ciclo de vida y llega en la fase 3. Hasta entonces la función
--   lo rechaza, para que la cartera no muestre un saldo que no se corresponde
--   con ningún valor real.


-- ===========================================================================
-- 1) Tipos
-- ===========================================================================
create type treasury_movement_type as enum ('EGRESO', 'INGRESO', 'TRANSFERENCIA');
create type treasury_status as enum ('REGISTRADO', 'ANULADO');


-- ===========================================================================
-- 2) Numeración
-- ===========================================================================
-- Serie propia por tipo de movimiento. Tabla y no sequence de Postgres por lo
-- mismo que en facturación: una fila se deja corregir y una secuencia no.
create table treasury_sequences (
  movement_type treasury_movement_type primary key,
  last_number int not null default 0 check (last_number >= 0)
);

alter table treasury_sequences enable row level security;
create policy "solo admin" on treasury_sequences for select to authenticated using (is_admin());
-- Sin políticas de escritura: solo la escribe save_treasury_movement.


-- ===========================================================================
-- 3) La cabecera
-- ===========================================================================
create table treasury_movements (
  id uuid primary key default gen_random_uuid(),

  movement_type treasury_movement_type not null,
  number int not null check (number > 0),
  -- Columna comun y no generada: una generada tendria que basarse en un CASE
  -- sobre el enum, y la inmutabilidad de esa expresion depende de la version
  -- de Postgres. La escribe la RPC, que es la unica que puede insertar aca.
  full_number text not null,
  status treasury_status not null default 'REGISTRADO',

  movement_date date not null default current_date,

  -- Opcional a propósito: tesorería es el libro único de caja, y cuando
  -- llegue pagos un pago de factura va a crear su movimiento acá. Un pago de
  -- factura no es un gasto de librería y no necesita clasificarse como tal.
  concept_id uuid references expense_concepts(id) on delete restrict,
  description text not null,
  -- Texto libre: el gasto sin factura es justamente el del remisero o el
  -- gomero, que no están en el padrón de proveedores.
  payee text,

  amount numeric(14,2) not null check (amount > 0),
  notes text,

  voided_at timestamptz,
  voided_reason text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (movement_type, number),

  constraint treasury_anulado_con_motivo check (
    (status = 'ANULADO' and voided_at is not null and voided_reason is not null)
    or (status = 'REGISTRADO' and voided_at is null and voided_reason is null)
  )
);

create index treasury_movements_date_idx on treasury_movements (movement_date desc);
create index treasury_movements_concept_idx on treasury_movements (concept_id);

create trigger treasury_movements_set_updated_at
before update on treasury_movements
for each row execute function set_updated_at();


-- ===========================================================================
-- 4) Las partidas
-- ===========================================================================
create table treasury_movement_legs (
  id uuid primary key default gen_random_uuid(),
  movement_id uuid not null references treasury_movements(id) on delete cascade,
  payment_method_id uuid not null references payment_methods(id) on delete restrict,
  -- Con signo: negativo saca del medio, positivo entra.
  amount numeric(14,2) not null check (amount <> 0)
);

create index treasury_legs_movement_idx on treasury_movement_legs (movement_id);
create index treasury_legs_method_idx on treasury_movement_legs (payment_method_id);


-- ===========================================================================
-- 5) RLS
-- ===========================================================================
alter table treasury_movements enable row level security;
alter table treasury_movement_legs enable row level security;

create policy "solo admin" on treasury_movements for select to authenticated using (is_admin());
create policy "solo admin" on treasury_movement_legs for select to authenticated using (is_admin());
-- Sin políticas de escritura: se escribe solo por las RPC de abajo, que son
-- las que validan que las partidas cuadren.


-- ===========================================================================
-- 6) Saldos
-- ===========================================================================
-- El saldo NO se guarda: se calcula. Un saldo en columna miente en cuanto
-- algo falla a mitad de camino, y después nadie sabe cuál de los dos números
-- es el bueno.
--
-- security_invoker: la vista aplica las políticas RLS de quien consulta, no
-- las del dueño. Sin esto, cualquier usuario autenticado vería los saldos.
create view payment_method_balances with (security_invoker = on) as
select
  m.id           as payment_method_id,
  m.name,
  m.kind,
  m.active,
  m.opening_balance,
  m.opening_balance + coalesce((
    select sum(l.amount)
      from treasury_movement_legs l
      join treasury_movements mv on mv.id = l.movement_id
     where l.payment_method_id = m.id
       and mv.status = 'REGISTRADO'
  ), 0) as balance
from payment_methods m;


-- ===========================================================================
-- 7) Registrar un movimiento
-- ===========================================================================
-- Una sola transacción. La cabecera viaja como jsonb para no arrastrar una
-- firma de diez parámetros.
--
-- Las partidas las manda el cliente, pero la base verifica que CUADREN: es lo
-- único que impide que un movimiento diga $10.000 y mueva $1.000.
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
  v_number int;
  v_new_id uuid;
  v_full_number text;
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

  -- Los medios tienen que existir y estar activos. Sin esta guarda, el insert
  -- de las partidas fallaría con un error de clave foránea que no dice nada.
  if exists (
    select 1 from jsonb_array_elements(p_legs) as leg
     where not exists (
       select 1 from payment_methods pm
        where pm.id = nullif(leg->>'payment_method_id', '')::uuid and pm.active
     )
  ) then
    raise exception 'Alguna partida apunta a un medio de pago que no existe o está inactivo.';
  end if;

  -- Fase 2: la cartera de cheques todavía no se mueve. Un cheque es un objeto
  -- con ciclo de vida y llega en la fase 3; permitir partidas sueltas acá
  -- dejaría la cartera con un saldo que no se corresponde con ningún valor.
  if exists (
    select 1 from jsonb_array_elements(p_legs) as leg
     join payment_methods pm on pm.id = (leg->>'payment_method_id')::uuid
    where pm.kind = 'CARTERA_CHEQUES'
  ) then
    raise exception 'Los movimientos sobre la cartera de cheques se registran desde el módulo de cheques, que todavía no está habilitado.';
  end if;

  -- Se redondea a dos decimales antes de validar, con el mismo criterio con
  -- que se van a guardar. Si se validara sin redondear, un importe con tres
  -- decimales podria pasar el control y guardarse distinto.
  select
    coalesce(sum(round((leg->>'amount')::numeric, 2)), 0),
    coalesce(sum(round((leg->>'amount')::numeric, 2))
             filter (where round((leg->>'amount')::numeric, 2) > 0), 0),
    coalesce(sum(round((leg->>'amount')::numeric, 2))
             filter (where round((leg->>'amount')::numeric, 2) < 0), 0)
  into v_sum, v_positives, v_negatives
  from jsonb_array_elements(p_legs) as leg;

  -- Que las partidas cuadren con la cabecera. Es la validación que hace que
  -- el saldo de cada medio sea confiable: si esto no se cumple, el libro de
  -- caja deja de decir la verdad y no hay forma de darse cuenta después.
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
    -- Transferir a la misma caja no mueve nada y solo ensucia el libro.
    if exists (
      select 1 from jsonb_array_elements(p_legs) as leg
      group by leg->>'payment_method_id'
      having count(*) > 1
    ) then
      raise exception 'Una transferencia no puede repetir el mismo medio de pago en dos partidas.';
    end if;
  end if;

  -- Correlativo. El insert ... on conflict crea la fila la primera vez que se
  -- usa ese tipo, y en ambos caminos la deja bloqueada hasta el commit: es lo
  -- que impide que un doble clic consuma dos números.
  insert into treasury_sequences (movement_type, last_number)
  values (v_type, 1)
  on conflict (movement_type)
    do update set last_number = treasury_sequences.last_number + 1
  returning treasury_sequences.last_number into v_number;

  insert into treasury_movements (
    movement_type, number, full_number, status, movement_date,
    concept_id, description, payee, amount, notes, created_by
  )
  values (
    v_type, v_number,
    case v_type
      when 'EGRESO' then 'EG-'
      when 'INGRESO' then 'IN-'
      else 'TR-'
    end || lpad(v_number::text, 8, '0'),
    'REGISTRADO',
    coalesce((p_header->>'movement_date')::date, current_date),
    nullif(p_header->>'concept_id', '')::uuid,
    p_header->>'description',
    nullif(trim(coalesce(p_header->>'payee', '')), ''),
    v_amount,
    nullif(trim(coalesce(p_header->>'notes', '')), ''),
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

revoke all on function public.save_treasury_movement(jsonb, jsonb) from public, anon;
grant execute on function public.save_treasury_movement(jsonb, jsonb) to authenticated;


-- ===========================================================================
-- 8) Anular
-- ===========================================================================
-- No se borran las partidas: el movimiento anulado queda como registro de que
-- existió, y la vista de saldos lo excluye por su estado. Borrarlo dejaría un
-- hueco en la numeración sin explicación.
create or replace function public.void_treasury_movement(
  p_movement_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement treasury_movements%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indicá el motivo de la anulación.';
  end if;

  select * into v_movement from treasury_movements
   where treasury_movements.id = p_movement_id for update;
  if not found then
    raise exception 'El movimiento no existe.';
  end if;
  if v_movement.status = 'ANULADO' then
    raise exception 'El movimiento % ya está anulado.', v_movement.full_number;
  end if;

  update treasury_movements
     set status = 'ANULADO',
         voided_at = now(),
         voided_reason = trim(p_reason)
   where treasury_movements.id = p_movement_id;
end;
$$;

revoke all on function public.void_treasury_movement(uuid, text) from public, anon;
grant execute on function public.void_treasury_movement(uuid, text) to authenticated;


comment on view payment_method_balances is
  'Saldo de cada medio: saldo inicial más la suma de las partidas de los '
  'movimientos vigentes. No se guarda en ninguna columna para que no pueda '
  'desincronizarse.';

comment on column treasury_movement_legs.amount is
  'Con signo: negativo saca del medio, positivo entra. La suma de las '
  'partidas tiene que cuadrar con el importe de la cabecera, y eso lo valida '
  'save_treasury_movement.';
