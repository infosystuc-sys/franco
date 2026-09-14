-- ===========================================================================
-- Combos de artículos, y facturar sin esperar a que la orden cierre
-- ===========================================================================
-- Migración: combos_y_factura_anticipada
--
-- ── Facturar en cualquier momento ─────────────────────────────────────────
-- issue_invoice exigía que la orden estuviera en un estado terminal. Pero hay
-- clientes que piden la factura antes para ir tramitando el pago, y el taller
-- no puede decirles que esperen a que el trabajo cierre.
--
-- Lo que sí se conserva es el freno que importa: una orden no puede tener dos
-- facturas vivas.
--
-- ── Combos ───────────────────────────────────────────────────────────────
-- Un combo es un artículo que contiene otros: el kit de reparación de una VP44
-- son cuatro repuestos que siempre salen juntos. Hasta ahora había que cargar
-- los cuatro renglones a mano en cada orden.
--
-- El combo entra como UN renglón, con su propio precio de venta: el cliente ve
-- "Kit reparación VP44" y no la lista de partes. Pero el stock que sale del
-- estante es el de los componentes, no el del combo —el combo no existe como
-- cosa física—, y de eso se encarga el trigger de abajo.

-- ── Composición ───────────────────────────────────────────────────────────
create table public.article_components (
  id uuid primary key default gen_random_uuid(),
  combo_article_id uuid not null references public.articles(id) on delete cascade,
  -- restrict: sacar del catálogo un artículo que forma parte de un combo
  -- dejaría al combo prometiendo algo que ya no existe.
  component_article_id uuid not null references public.articles(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (combo_article_id, component_article_id),
  -- Un combo que se contiene a sí mismo descontaría stock sin fin.
  check (combo_article_id <> component_article_id)
);

create index article_components_combo_idx
  on public.article_components (combo_article_id, position);

alter table public.article_components enable row level security;

create policy "lectura autenticada" on public.article_components
  for select to authenticated using (true);
create policy "admin escribe" on public.article_components
  for insert to authenticated with check (is_admin());
create policy "admin actualiza" on public.article_components
  for update to authenticated using (is_admin());
create policy "admin borra" on public.article_components
  for delete to authenticated using (is_admin());

-- ── Un solo nivel ─────────────────────────────────────────────────────────
-- Combos dentro de combos abren la puerta a ciclos (A trae B, B trae A) y a
-- explosiones de stock difíciles de leer. Un nivel alcanza para el caso real
-- —un kit de repuestos— y se puede explicar en una frase.
create or replace function public.article_components_un_solo_nivel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from article_components where combo_article_id = new.component_article_id) then
    raise exception 'Ese artículo ya es un combo: no se puede meter un combo adentro de otro.';
  end if;
  if exists (select 1 from article_components where component_article_id = new.combo_article_id) then
    raise exception 'Ese artículo ya forma parte de otro combo: no puede ser combo a la vez.';
  end if;
  return new;
end;
$$;

create trigger article_components_un_solo_nivel
before insert or update on public.article_components
for each row execute function public.article_components_un_solo_nivel();

-- ── El stock sale de los componentes ──────────────────────────────────────
-- El trigger de renglones de OT movía el stock del artículo del renglón. Con
-- un combo eso no mueve nada —el combo no lleva stock propio— y las piezas se
-- iban del taller sin descontarse de ningún lado.
create or replace function public.mover_stock_de_renglon(p_article_id uuid, p_delta numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_es_combo boolean;
begin
  if p_article_id is null then
    return;
  end if;

  select exists (select 1 from article_components where combo_article_id = p_article_id)
    into v_es_combo;

  if v_es_combo then
    -- Cada componente se mueve por su propia cantidad dentro del combo.
    perform public.adjust_article_stock(c.component_article_id, p_delta * c.quantity)
    from article_components c
    where c.combo_article_id = p_article_id;
  else
    perform public.adjust_article_stock(p_article_id, p_delta);
  end if;
end;
$$;

create or replace function public.work_order_items_stock_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.mover_stock_de_renglon(new.article_id, -new.quantity);
    return new;

  elsif tg_op = 'DELETE' then
    perform public.mover_stock_de_renglon(old.article_id, old.quantity);
    return old;

  else
    if old.article_id is distinct from new.article_id then
      perform public.mover_stock_de_renglon(old.article_id, old.quantity);
      perform public.mover_stock_de_renglon(new.article_id, -new.quantity);
    elsif old.quantity is distinct from new.quantity then
      perform public.mover_stock_de_renglon(new.article_id, old.quantity - new.quantity);
    end if;
    return new;
  end if;
end;
$$;

-- ── Facturar sin esperar el cierre ────────────────────────────────────────
create or replace function public.issue_invoice(
  p_work_order_id uuid,
  p_items jsonb,
  p_notes text default null,
  p_emit_remito boolean default false
)
returns table (invoice_id uuid, invoice_full_number text, invoice_letter invoice_type, remito_full_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wo work_orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  -- for update: es lo que impide que un doble clic emita dos facturas.
  select * into v_wo from work_orders where work_orders.id = p_work_order_id for update;
  if not found then
    raise exception 'La orden de trabajo no existe.';
  end if;

  -- Ya no se exige que la orden esté terminada. Hay clientes que piden la
  -- factura antes para ir tramitando el pago, y hacerlos esperar al cierre del
  -- trabajo les traba el circuito administrativo por algo que al taller no le
  -- cuesta nada.
  if exists (
    select 1 from invoices
    where invoices.work_order_id = p_work_order_id and invoices.status = 'EMITIDA'
  ) then
    raise exception 'La orden % ya tiene una factura emitida.', v_wo.number;
  end if;

  return query
  select * from public._create_invoice(p_work_order_id, v_wo.customer_id, p_items, p_notes, p_emit_remito);
end;
$$;
