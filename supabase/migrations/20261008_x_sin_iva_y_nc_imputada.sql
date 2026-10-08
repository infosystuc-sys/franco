-- 1) La serie X es interna y no es fiscal: no lleva IVA. Hasta ahora la base le
--    sumaba el 21% como a una A o una B; ahora el total de una X es el neto.
--    (Las X ya emitidas se dejan como están.)
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = '_create_invoice';

  v_def := replace(v_def, chr(13), '');
  if position('when v_type in (''C'', ''X'') then 0' in v_def) = 0 then
    v_def := replace(
      v_def,
      'v_vat := case when v_type = ''C'' then 0 else round(v_net * 0.21, 2) end;',
      'v_vat := case when v_type in (''C'', ''X'') then 0 else round(v_net * 0.21, 2) end;'
    );
    if position('when v_type in (''C'', ''X'') then 0' in v_def) = 0 then
      raise exception 'No se encontró el cálculo del IVA en _create_invoice';
    end if;
    execute v_def;
  end if;
end $$;

-- 2) Una nota de crédito emitida contra una factura se imputa sola a esa
--    factura: le baja el saldo (hasta lo que debía) y la factura deja de figurar
--    como impaga. Antes había que ir a Imputación de comprobantes a mano.
--    Si la nota devuelve fondos (la factura ya estaba cobrada) no se imputa:
--    lo que se devuelve es plata, no saldo.
create or replace function public._imputar_nc_a_su_factura()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv invoices%rowtype;
  v_libre numeric;
  v_monto numeric;
begin
  -- Una nota anulada deja libre lo que había imputado.
  if new.status = 'ANULADA' then
    delete from credit_note_allocations where credit_note_id = new.id;
    return null;
  end if;

  if new.status <> 'EMITIDA' or new.invoice_id is null or coalesce(new.devuelve_fondos, false) then
    return null;
  end if;

  -- Ya imputada (a mano o por un paso anterior): no se toca.
  if exists (select 1 from credit_note_allocations where credit_note_id = new.id) then
    return null;
  end if;

  select * into v_inv from invoices where id = new.invoice_id for update;
  if not found then
    return null;
  end if;

  v_libre := v_inv.total_amount - v_inv.paid_amount - coalesce(v_inv.credited_amount, 0);
  v_monto := least(new.total_amount, v_libre);

  if v_monto > 0 then
    insert into credit_note_allocations (credit_note_id, invoice_id, amount)
    values (new.id, new.invoice_id, v_monto);
  end if;

  return null;
end;
$$;

drop trigger if exists credit_notes_imputar_a_factura on public.credit_notes;
create trigger credit_notes_imputar_a_factura
  after insert or update of status on public.credit_notes
  for each row execute function public._imputar_nc_a_su_factura();

-- Las notas ya emitidas que quedaron sin imputar.
update public.credit_notes set status = status where status = 'EMITIDA' and invoice_id is not null;
