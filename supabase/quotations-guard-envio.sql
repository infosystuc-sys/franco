-- DieselPro ERP — cotizaciones: no se envía una cotización sin renglones
--
-- Aplicar en el SQL Editor de Supabase, DESPUÉS de quotations.sql.
-- Este archivo queda además como registro del esquema.
--
-- Por qué en dos lugares y no solo en la pantalla:
--   La app es un sitio estático y cualquiera puede llamar a la API con la
--   anon key, así que el botón deshabilitado en QuotationDetails.tsx es
--   comodidad, no la garantía. La garantía tiene que vivir en la base.
--
--   Y tiene que vivir en DOS puntos, no uno: si solo se bloqueara al pasar a
--   ENVIADA, alcanzaría con enviarla primero y borrar los renglones después
--   —el editor de ítems sigue habilitado con la cotización ya enviada— para
--   terminar en el mismo estado inválido por la puerta de al lado.


-- ===========================================================================
-- 1) replace_quotation_items: no puede vaciar una cotización ya enviada
-- ===========================================================================
create or replace function public.replace_quotation_items(
  p_quotation_id uuid,
  p_items jsonb
)
returns void
language plpgsql
as $$
declare
  v_status quotation_status;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select status into v_status from quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'La cotización no existe.';
  end if;
  if v_status in ('ACEPTADA', 'RECHAZADA') then
    raise exception 'La cotización está % y no puede modificarse.', lower(v_status::text);
  end if;

  -- Ya enviada: no se puede dejar sin renglones. Antes de enviarla (EMITIDA)
  -- sí se permite guardarla vacía, es un borrador en construcción.
  if v_status = 'ENVIADA' and jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'No se puede dejar sin renglones una cotización ya enviada.';
  end if;

  delete from quotation_items where quotation_id = p_quotation_id;

  insert into quotation_items (quotation_id, article_id, code, description, quantity, unit_price, subtotal)
  select
    p_quotation_id,
    nullif(item->>'article_id', '')::uuid,
    item->>'code',
    item->>'description',
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'quantity')::numeric * (item->>'unit_price')::numeric
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item;
end;
$$;


-- ===========================================================================
-- 2) No se puede ENVIAR una cotización sin renglones
-- ===========================================================================
-- A propósito, solo mira la transición EMITIDA → ENVIADA: es la del botón
-- "Marcar enviada", que es lo que se pidió bloquear.
--
-- NO se extiende a reabrir una rechazada (RECHAZADA → ENVIADA): una
-- cotización se puede rechazar sin haber tenido renglones nunca (se puede
-- rechazar desde EMITIDA, antes de cargar nada), y si el reabrir exigiera
-- renglones, esa cotización quedaría sin salida — no se puede reabrir
-- (bloqueada) ni editar (congelada fuera de EMITIDA/ENVIADA). Reabrir la
-- deja en ENVIADA con los renglones que tenía, y desde ahí el editor de
-- ítems sigue disponible para cargarlos.
create or replace function public.quotations_require_items_to_send()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'ENVIADA' and old.status = 'EMITIDA' and not exists (
    select 1 from quotation_items where quotation_id = new.id
  ) then
    raise exception 'No se puede enviar una cotización sin renglones cargados.';
  end if;
  return new;
end;
$$;

drop trigger if exists quotations_send_requires_items on quotations;
create trigger quotations_send_requires_items
before update on quotations
for each row execute function public.quotations_require_items_to_send();

comment on function public.quotations_require_items_to_send() is
  'Bloquea el botón "Marcar enviada" (EMITIDA → ENVIADA) sin renglones. No '
  'alcanza a reabrir una rechazada, a propósito: ver el comentario junto al '
  'trigger. replace_quotation_items impide vaciar una cotización que ya '
  'está ENVIADA, así que una vez que tiene contenido no se puede perder por '
  'ese otro camino.';
