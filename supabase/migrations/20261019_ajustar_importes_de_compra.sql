-- Importes ajustados a mano en un comprobante de compra.
--
-- Al cargar una factura leída por IA, la cuenta de los renglones a veces no
-- da lo mismo que el papel: el proveedor redondea el IVA sobre el total y no
-- renglón por renglón, o la IA leyó mal un precio y no hay forma de saber
-- cuál. Manda el papel: quien revisa puede escribir el neto y el IVA de cada
-- alícuota, y el exento y el no gravado, tal como figuran impresos.
--
-- save_purchase_invoice recibe esos importes en p_header.ajustes:
--   { "por_alicuota": [{ "rate": 21, "net": 1000.00, "vat": 210.01 }],
--     "net_exempt": 0, "net_untaxed": 0 }
-- Cada clave es opcional. La diferencia se carga en el renglón más grande de
-- esa alícuota, así los renglones siguen sumando el pie, y el pie del
-- comprobante (que es lo que lee el Libro IVA Compras) se recalcula.

create or replace function public.aplicar_ajustes_de_compra(p_id uuid, p_ajustes jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_aj jsonb;
  v_rate numeric;
  v_item uuid;
  v_trat text;
  v_clave text;
  v_net numeric(14,2);
  v_exempt numeric(14,2);
  v_untaxed numeric(14,2);
  v_vat numeric(14,2);
  v_other numeric(14,2);
begin
  for v_aj in select * from jsonb_array_elements(coalesce(p_ajustes->'por_alicuota', '[]'::jsonb)) loop
    v_rate := (v_aj->>'rate')::numeric;

    select i.id into v_item
      from purchase_invoice_items i
     where i.purchase_invoice_id = p_id and i.vat_treatment = 'GRAVADO' and i.vat_rate = v_rate
     order by i.net_amount desc, i.line_number
     limit 1;
    if v_item is null then
      raise exception '%', format('No hay renglones al %s%% para ajustar.', v_rate);
    end if;

    if v_aj ? 'net' and v_aj->>'net' is not null then
      update purchase_invoice_items
         set net_amount = net_amount + round((v_aj->>'net')::numeric, 2) - (
           select sum(net_amount) from purchase_invoice_items
            where purchase_invoice_id = p_id and vat_treatment = 'GRAVADO' and vat_rate = v_rate)
       where id = v_item;
    end if;

    if v_aj ? 'vat' and v_aj->>'vat' is not null then
      update purchase_invoice_items
         set vat_amount = vat_amount + round((v_aj->>'vat')::numeric, 2) - (
           select sum(vat_amount) from purchase_invoice_items
            where purchase_invoice_id = p_id and vat_treatment = 'GRAVADO' and vat_rate = v_rate)
       where id = v_item;
    end if;
  end loop;

  -- Exento y no gravado: un solo importe cada uno, sin IVA.
  foreach v_clave in array array['net_exempt', 'net_untaxed'] loop
    if p_ajustes ? v_clave and p_ajustes->>v_clave is not null then
      v_trat := case v_clave when 'net_exempt' then 'EXENTO' else 'NO_GRAVADO' end;
      select i.id into v_item
        from purchase_invoice_items i
       where i.purchase_invoice_id = p_id and i.vat_treatment = v_trat
       order by i.net_amount desc, i.line_number
       limit 1;
      if v_item is null then
        raise exception 'No hay renglones % para ajustar.', lower(replace(v_trat, '_', ' '));
      end if;
      update purchase_invoice_items
         set net_amount = net_amount + round((p_ajustes->>v_clave)::numeric, 2) - (
           select sum(net_amount) from purchase_invoice_items
            where purchase_invoice_id = p_id and vat_treatment = v_trat)
       where id = v_item;
    end if;
  end loop;

  if exists (
    select 1 from purchase_invoice_items
     where purchase_invoice_id = p_id and (net_amount < 0 or vat_amount < 0)
  ) then
    raise exception 'El ajuste deja un renglón en negativo: revisá los importes escritos a mano.';
  end if;

  select
    coalesce(sum(net_amount) filter (where vat_treatment = 'GRAVADO'), 0),
    coalesce(sum(net_amount) filter (where vat_treatment = 'EXENTO'), 0),
    coalesce(sum(net_amount) filter (where vat_treatment = 'NO_GRAVADO'), 0),
    coalesce(sum(vat_amount), 0)
  into v_net, v_exempt, v_untaxed, v_vat
  from purchase_invoice_items
  where purchase_invoice_id = p_id;

  select other_taxes_amount into v_other from purchase_invoices where id = p_id;

  if v_net + v_exempt + v_untaxed + v_vat + v_other <= 0 then
    raise exception 'El total del comprobante tiene que ser mayor a cero.';
  end if;

  update purchase_invoices
     set net_taxed = v_net,
         net_exempt = v_exempt,
         net_untaxed = v_untaxed,
         vat_amount = v_vat,
         total_amount = v_net + v_exempt + v_untaxed + v_vat + v_other
   where id = p_id;

  -- La base informada de cada percepción sigue al neto ajustado.
  update purchase_invoice_taxes t
     set base_amount = case when r.base = 'TOTAL' then v_net + v_exempt + v_untaxed + v_vat
                            else v_net + v_exempt + v_untaxed end
    from tax_rates r
   where r.id = t.tax_rate_id and t.purchase_invoice_id = p_id;
end;
$$;

-- Solo la llama save_purchase_invoice (que ya validó que es un admin).
revoke all on function public.aplicar_ajustes_de_compra(uuid, jsonb) from public, anon, authenticated;

do $$
declare
  v_def text;
  v_nuevo text;
begin
  select pg_get_functiondef('public.save_purchase_invoice'::regproc) into v_def;
  v_def := replace(v_def, chr(13), '');
  if position('aplicar_ajustes_de_compra' in v_def) > 0 then
    return;
  end if;
  v_nuevo := replace(v_def,
    '  -- ── Inventario.',
    '  -- ── Importes ajustados a mano para que coincidan con el papel.
  if jsonb_typeof(p_header->''ajustes'') = ''object'' then
    perform public.aplicar_ajustes_de_compra(v_new_id, p_header->''ajustes'');
  end if;

  -- ── Inventario.');
  if v_nuevo = v_def then
    raise exception 'No se encontró dónde enganchar los ajustes en save_purchase_invoice';
  end if;
  execute v_nuevo;
end $$;
