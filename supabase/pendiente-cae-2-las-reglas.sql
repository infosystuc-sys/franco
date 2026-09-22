-- ===========================================================================
-- El estado PENDIENTE_CAE — paso 2 de 2: las reglas que lo hacen posible
-- ===========================================================================
-- Migración sugerida: pendiente_cae_las_reglas
--
-- Correr DESPUÉS de pendiente-cae-1-el-estado.sql, en una corrida aparte (ver
-- allá por qué). Si este script se corre antes, falla en el primer `check`.
--
-- Fase 2 del plan de facturación con ARCA: pedir el CAE es una llamada externa
-- que no puede vivir adentro de una transacción, así que la emisión se parte:
--
--     fase 1 (transacción)   reservar el número, estado PENDIENTE_CAE
--     fase 2 (afuera)        llamar a ARCA — puede fallar, tardar o cortarse
--     fase 3 (transacción)   guardar el CAE, estado EMITIDA
--
-- Acá va lo que no depende de ARCA: que la base admita ese estado intermedio
-- sin dejar agujeros. La llamada al web service es la fase 3 del plan.
--
-- Agregar el valor al enum NO alcanza, y esa es la trampa de esta migración:
-- la tabla tiene un check y un índice único que nombran 'EMITIDA' a mano, y
-- los dos rechazarían una factura pendiente. Con el enum solo, la primera
-- factura en PENDIENTE_CAE fallaría al insertarse.
--
-- No lleva begin/commit a mano: Postgres envuelve en una sola transacción
-- implícita todas las sentencias que le llegan juntas, que es como las manda
-- el SQL Editor. O entra todo o no entra nada. Un `begin` explícito acá solo
-- agregaría el aviso de transacción anidada.

-- ---------------------------------------------------------------------------
-- 1. El check que bloqueaba el estado nuevo
-- ---------------------------------------------------------------------------
-- invoices_anulada_con_motivo dice hoy: o es ANULADA y tiene motivo, o es
-- EMITIDA y no lo tiene. Escrito así, cualquier otro estado es falso y el
-- insert se rechaza. Se amplía para que una pendiente valga lo mismo que una
-- emitida: todavía no hay nada que anular, así que tampoco hay motivo.
alter table public.invoices
  drop constraint invoices_anulada_con_motivo;

alter table public.invoices
  add constraint invoices_anulada_con_motivo check (
    (status = 'ANULADA' and voided_at is not null and voided_reason is not null)
    or (status in ('PENDIENTE_CAE', 'EMITIDA') and voided_at is null and voided_reason is null)
  );

-- ---------------------------------------------------------------------------
-- 2. Una pendiente no tiene CAE, por definición
-- ---------------------------------------------------------------------------
-- Es la invariante que separa los dos estados. Sin esto, una factura podría
-- quedar en PENDIENTE_CAE con un CAE guardado, que es exactamente el caso que
-- después nadie sabe leer: ¿ARCA lo dio o no?
--
-- Al revés no se puede exigir: la serie interna X queda EMITIDA y nunca tiene
-- CAE, porque no es fiscal y no va a ARCA.
alter table public.invoices
  add constraint invoices_pendiente_sin_cae check (
    status <> 'PENDIENTE_CAE' or (cae is null and cae_due_date is null)
  );

-- ---------------------------------------------------------------------------
-- 3. "Una OT, una factura" tiene que contar también las pendientes
-- ---------------------------------------------------------------------------
-- El índice parcial dice hoy `where status = 'EMITIDA'`. Con el estado nuevo
-- eso se abre solo: una factura pendiente no entra en el índice, la OT queda
-- libre a los ojos de la base, y se podría facturar la misma orden dos veces
-- mientras la primera espera el CAE de ARCA. Justo el momento en que alguien
-- impaciente vuelve a apretar el botón.
--
-- Pasa a `<> 'ANULADA'`: cuenta las vigentes y las pendientes, y sigue
-- liberando la OT cuando se anula, que es para lo que el índice era parcial.
drop index public.invoices_una_activa_por_ot;

create unique index invoices_una_activa_por_ot
  on public.invoices (work_order_id) where status <> 'ANULADA';

-- (work_order_id es nullable desde que existen las facturas sin OT. Los NULL
-- no chocan entre sí en un índice único, así que esas siguen sin restricción,
-- igual que hasta ahora.)

-- ---------------------------------------------------------------------------
-- 4. Por dónde puede moverse una factura
-- ---------------------------------------------------------------------------
-- Con tres estados las transacciones posibles dejan de ser obvias, y algunas
-- son corrupción fiscal lisa y llana: volver a EMITIDA una anulada, o
-- "despegarle" el CAE a una emitida para pedirlo de nuevo. ARCA ya la conoce;
-- lo único que revierte una factura con CAE es una nota de crédito.
--
-- Permitidas:  PENDIENTE_CAE → EMITIDA    (ARCA otorgó el CAE)
--              PENDIENTE_CAE → ANULADA    (ARCA nunca la conoció; se abandona)
--              EMITIDA       → ANULADA    (lo de siempre)
-- Prohibidas:  todo lo que salga de ANULADA, y EMITIDA → PENDIENTE_CAE.
create or replace function public._invoices_guardar_transicion()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Un update que no toca el estado no es asunto de este disparador: cobrar
  -- una factura le mueve paid_amount y nada más.
  if new.status is not distinct from old.status then
    return new;
  end if;

  if old.status = 'ANULADA' then
    raise exception 'Una factura anulada no vuelve atrás. Para rehacerla se emite una nueva.';
  end if;

  if old.status = 'EMITIDA' and new.status = 'PENDIENTE_CAE' then
    raise exception 'Una factura emitida no puede volver a quedar pendiente de CAE: ARCA ya la tiene.';
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_guardar_transicion on public.invoices;

create trigger invoices_guardar_transicion
before update on public.invoices
for each row execute function public._invoices_guardar_transicion();

-- ---------------------------------------------------------------------------
-- 5. El paso de pendiente a emitida
-- ---------------------------------------------------------------------------
-- La fase 3 del circuito, como función: recibe el CAE y cierra la factura.
-- Hoy la llama una persona desde Configuración para probar la máquina de
-- estados sin ARCA de por medio; cuando exista FECAESolicitar, la va a llamar
-- la Edge Function con lo que devuelva el organismo. La firma no cambia,
-- porque lo que entra es lo mismo: un CAE y su vencimiento.
--
-- p_simulado queda para poder distinguir después, de un vistazo, cuáles
-- nunca estuvieron autorizadas de verdad. Es el mismo cae_simulated que ya
-- existe.
--
-- OJO: el `if not is_admin()` de acá abajo quedó mal y lo corrige
-- pendiente-cae-3-confirmar-cae-desde-arca.sql. La llave de servicio no lleva
-- usuario, así que is_admin() da falso y la Edge Function no podía llamarla.
-- Esta versión queda como registro de lo que se aplicó, no para copiar.
create or replace function public.confirmar_cae(
  p_invoice_id uuid,
  p_cae text,
  p_cae_due_date date,
  p_simulado boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status invoice_status;
  v_cae text := trim(coalesce(p_cae, ''));
begin
  if not is_admin() then
    raise exception 'Solo un administrador puede confirmar el CAE de una factura.';
  end if;

  -- El CAE de ARCA son 14 dígitos. Validarlo acá evita guardar un pegado a
  -- medias, que después se imprime en el comprobante y en el QR.
  if v_cae !~ '^\d{14}$' then
    raise exception 'El CAE tiene que ser de 14 dígitos.';
  end if;

  if p_cae_due_date is null then
    raise exception 'El CAE tiene que venir con su fecha de vencimiento.';
  end if;

  -- El for update cierra la ventana entre leer el estado y escribirlo: dos
  -- confirmaciones a la vez no pueden pasar las dos por el chequeo.
  select status into v_status
    from invoices
   where id = p_invoice_id
   for update;

  if not found then
    raise exception 'La factura no existe.';
  end if;

  if v_status <> 'PENDIENTE_CAE' then
    raise exception 'La factura no está esperando un CAE: está %.', v_status;
  end if;

  update invoices
     set status       = 'EMITIDA',
         cae          = v_cae,
         cae_due_date = p_cae_due_date,
         cae_simulated = coalesce(p_simulado, false)
   where id = p_invoice_id;
end;
$$;

revoke all on function public.confirmar_cae(uuid, text, date, boolean) from public, anon;
grant execute on function public.confirmar_cae(uuid, text, date, boolean) to authenticated;

comment on function public.confirmar_cae(uuid, text, date, boolean) is
  'Fase 3 de la emisión: guarda el CAE y pasa la factura de PENDIENTE_CAE a EMITIDA.';

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
-- Nada debería haber cambiado de estado: todavía no hay quien cree facturas
-- pendientes. Eso llega cuando se toque _create_invoice().
select status, count(*) from public.invoices group by status order by status;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.invoices'::regclass
  and conname in ('invoices_anulada_con_motivo', 'invoices_pendiente_sin_cae');

select indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'invoices_una_activa_por_ot';
