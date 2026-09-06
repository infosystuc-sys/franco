-- ===========================================================================
-- Eliminar órdenes de trabajo desde el listado
-- ===========================================================================
-- Migración: eliminar_ot
--
-- Casi todo lo que cuelga de una orden se va solo en cascada: renglones,
-- historial, etapas, piezas recibidas, fotos y avisos. Y el stock que la
-- orden había descontado vuelve al inventario por el disparador de sus
-- renglones (work_order_items_stock). Nada de eso hace falta escribirlo acá.
--
-- Lo que sí hace falta es resolver dos cosas que la cascada no cubre:
--
--   * La FACTURA retiene la orden (invoices.work_order_id en RESTRICT) y debe
--     seguir reteniéndola: es un comprobante fiscal. Sin este chequeo el
--     borrado falla igual, pero con un error de clave foránea que no le dice
--     nada a nadie. Acá se convierte en una frase que nombra la factura.
--
--   * La COTIZACIÓN se borra junto con la orden, y eso son tres pasos:
--     work_orders.quotation_id y quotations.work_order_id se apuntan entre sí
--     en RESTRICT, así que hay que soltar el lado de la orden antes de poder
--     borrar cualquiera de las dos.
--
-- Por qué vive en la base y no en el cliente: esos tres pasos tienen que pasar
-- todos o ninguno. Hechos desde el navegador, una caída en el medio deja la
-- cotización borrada y la orden viva —el peor resultado posible, porque no
-- queda rastro de qué se había presupuestado—. Adentro de una función es una
-- transacción.
--
-- Soltar quotation_id no despierta ningún aviso: los disparadores de WhatsApp
-- están acotados a UPDATE OF status_id.

create or replace function public.delete_work_orders(p_ids uuid[])
returns table (order_number text, was_deleted boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_numero text;
  v_factura text;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  foreach v_id in array coalesce(p_ids, '{}'::uuid[]) loop
    select w.number into v_numero from work_orders w where w.id = v_id for update;

    -- Ya no está. Alguien la borró entre que se armó la lista y se confirmó;
    -- el resultado que se buscaba ya está, así que no es un error.
    if v_numero is null then
      continue;
    end if;

    -- Una factura anulada retiene igual: la fila sigue existiendo y sigue
    -- siendo el respaldo de un número que se emitió.
    select coalesce(i.full_number, 'N° ' || i.number::text) into v_factura
      from invoices i where i.work_order_id = v_id limit 1;

    if v_factura is not null then
      order_number := v_numero;
      was_deleted  := false;
      reason       := 'la factura ' || v_factura || ' la retiene';
      return next;
      continue;
    end if;

    update work_orders set quotation_id = null where id = v_id;
    delete from quotations where work_order_id = v_id;
    delete from work_orders where id = v_id;

    order_number := v_numero;
    was_deleted  := true;
    reason       := null;
    return next;
  end loop;
end;
$$;

comment on function public.delete_work_orders(uuid[]) is
  'Borra órdenes de trabajo con su cotización, en una sola transacción. '
  'Devuelve una fila por orden pedida diciendo si se borró y, si no, por qué. '
  'Las órdenes facturadas se rechazan sin cortar el resto del lote.';

grant execute on function public.delete_work_orders(uuid[]) to authenticated;
