-- El importe del renglón, tal como lo imprimió el proveedor.
--
-- El neto de un renglón se calculaba cantidad × precio × (1 − bonificación).
-- Muchos proveedores redondean en el medio —el precio bonificado a tres
-- decimales— y su importe no da lo mismo: Núcleo Encendido factura 250 ×
-- 1190,45 con 14,5% como 254.458,50 (1017,834 × 250) y la cuenta da
-- 254.458,69. Manda el papel: el renglón puede traer "net_amount", el importe
-- ya bonificado, y entonces ese es su neto (la bonificación general, si hay,
-- se aplica encima igual que antes). Sin net_amount, todo sigue como estaba.
--
-- De paso, el IVA de cada renglón se calcula sobre el neto ya redondeado,
-- igual que el pie: antes se calculaba sobre el neto sin redondear y la suma
-- de los renglones podía no dar el IVA del comprobante por un centavo.

do $$
declare
  v_def text;
  v_nuevo text;
  v_paso text;
begin
  select pg_get_functiondef('public.save_purchase_invoice'::regproc) into v_def;
  v_def := replace(v_def, chr(13), '');
  if position('net_override' in v_def) > 0 then
    return;
  end if;
  v_nuevo := v_def;

  v_paso := replace(v_nuevo,
'      (item->>''vat_rate_id'')::uuid                       as vat_rate_id
    from jsonb_array_elements(p_items) as item',
'      (item->>''vat_rate_id'')::uuid                       as vat_rate_id,
      nullif(item->>''net_amount'', '''')::numeric           as net_override
    from jsonb_array_elements(p_items) as item');
  if v_paso = v_nuevo then raise exception 'paso 1'; end if;
  v_nuevo := v_paso;

  v_paso := replace(v_nuevo,
'      round((l.quantity * l.unit_price) * (1 - l.discount_percent / 100)
        * (1 - v_general_discount / 100), 2)                                 as net,',
'      round(coalesce(l.net_override, (l.quantity * l.unit_price) * (1 - l.discount_percent / 100))
        * (1 - v_general_discount / 100), 2)                                 as net,');
  if v_paso = v_nuevo then raise exception 'paso 2'; end if;
  v_nuevo := v_paso;

  v_paso := replace(v_nuevo,
'    round((item->>''quantity'')::numeric * (item->>''unit_price'')::numeric
      * (1 - coalesce((item->>''discount_percent'')::numeric, 0) / 100)
      * (1 - v_general_discount / 100), 2),
    r.id, r.rate, r.vat_treatment,
    case when r.vat_treatment = ''GRAVADO'' then
      round((item->>''quantity'')::numeric * (item->>''unit_price'')::numeric
        * (1 - coalesce((item->>''discount_percent'')::numeric, 0) / 100)
        * (1 - v_general_discount / 100) * r.rate / 100, 2)
    else 0 end',
'    round(coalesce(nullif(item->>''net_amount'', '''')::numeric,
        (item->>''quantity'')::numeric * (item->>''unit_price'')::numeric
        * (1 - coalesce((item->>''discount_percent'')::numeric, 0) / 100))
      * (1 - v_general_discount / 100), 2),
    r.id, r.rate, r.vat_treatment,
    case when r.vat_treatment = ''GRAVADO'' then
      round(round(coalesce(nullif(item->>''net_amount'', '''')::numeric,
          (item->>''quantity'')::numeric * (item->>''unit_price'')::numeric
          * (1 - coalesce((item->>''discount_percent'')::numeric, 0) / 100))
        * (1 - v_general_discount / 100), 2) * r.rate / 100, 2)
    else 0 end');
  if v_paso = v_nuevo then raise exception 'paso 3'; end if;
  v_nuevo := v_paso;

  -- El costo unitario que queda como precio de compra: con importe impreso,
  -- sale de ese importe dividido la cantidad.
  v_paso := replace(v_nuevo,
'        round((v_item->>''unit_price'')::numeric
          * (1 - coalesce((v_item->>''discount_percent'')::numeric, 0) / 100)
          * (1 - v_general_discount / 100), 4),',
'        round(coalesce(
            nullif(v_item->>''net_amount'', '''')::numeric / nullif((v_item->>''quantity'')::numeric, 0),
            (v_item->>''unit_price'')::numeric
              * (1 - coalesce((v_item->>''discount_percent'')::numeric, 0) / 100))
          * (1 - v_general_discount / 100), 4),');
  if v_paso = v_nuevo then raise exception 'paso 4'; end if;
  v_nuevo := v_paso;

  execute v_nuevo;
end $$;
