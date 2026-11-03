-- Saldos iniciales de proveedores.
--
-- Lo que se le debía a cada proveedor al empezar a usar la app. Cada deuda
-- entra como un comprobante de compra marcado saldo_inicial: así figura en la
-- cuenta corriente del proveedor y en Pagos como pendiente, y se cancela con
-- una orden de pago como cualquier factura (en efectivo, transferencia o
-- endosando cheques de la cartera).
--
-- No es una compra de este sistema: no tiene renglones, no mueve stock y no
-- entra al Libro IVA Compras. Mientras no tenga pagos se puede borrar desde
-- la pantalla de carga (usa eliminar_comprobante_de_compra).

alter table public.purchase_invoices
  add column if not exists saldo_inicial boolean not null default false;

-- ---------------------------------------------------------------------------
-- Libro IVA Compras: sin saldos iniciales
-- ---------------------------------------------------------------------------
-- Se regenera desde la definición vigente con un reemplazo exacto, igual que
-- se hizo con las ventas en saldos-iniciales-clientes.sql.
do $$
declare
  def text;
  nueva text;
begin
  select pg_get_functiondef('public.report_vat_purchases(date, date)'::regprocedure) into def;
  if def not like '%saldo_inicial%' then
    nueva := replace(def, 'p.status = ''REGISTRADA''', 'p.status = ''REGISTRADA'' and not p.saldo_inicial');
    if nueva = def then
      raise exception 'No encontré el filtro de comprobantes en report_vat_purchases';
    end if;
    execute nueva;
  end if;
end $$;

-- En la composición de saldos de proveedores, "Saldo inicial" en vez de "Factura".
-- Si la función cambió y no se encuentra el texto, queda como está: es solo el nombre.
do $$
declare
  def text;
  nueva text;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cuenta_corriente_proveedores'
   limit 1;
  if def is not null and def not like '%saldo_inicial%' then
    nueva := replace(def,
      'when ''FACTURA'' then ''Factura ''',
      'when ''FACTURA'' then case when pi.saldo_inicial then ''Saldo inicial '' else ''Factura '' end');
    if nueva <> def then
      execute nueva;
    else
      raise notice 'No encontré el nombre del comprobante en cuenta_corriente_proveedores: queda como "Factura".';
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- La carga
-- ---------------------------------------------------------------------------
-- p_filas: [{ supplier_id, comprobante, fecha, vencimiento, importe }, ...]
--
-- comprobante: "A 0001-00001234" (o "FC A 0001-00001234") se guarda con esa
-- letra y ese número, así el día que se cargue de nuevo por error rebota como
-- duplicado. Cualquier otra cosa ("Saldo", "Remito 45", vacío) entra como X
-- 0000 con el número siguiente del proveedor, y el texto queda en notas.
--
-- Todo o nada: si una fila falla, no se carga ninguna.
create or replace function public.cargar_saldos_iniciales_proveedores(p_filas jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fila jsonb;
  v_supplier suppliers%rowtype;
  v_importe numeric(14,2);
  v_fecha date;
  v_vence date;
  v_texto text;
  v_match text[];
  v_letra purchase_letter;
  v_pv int;
  v_numero int;
  v_cantidad integer := 0;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if coalesce(jsonb_array_length(p_filas), 0) = 0 then
    raise exception 'No hay saldos para cargar.';
  end if;

  for v_fila in select * from jsonb_array_elements(p_filas) loop
    select * into v_supplier from suppliers where id = nullif(v_fila->>'supplier_id', '')::uuid;
    if not found then
      raise exception 'Hay una fila sin proveedor.';
    end if;

    v_importe := round((v_fila->>'importe')::numeric, 2);
    if v_importe is null or v_importe <= 0 then
      raise exception 'El importe de % tiene que ser mayor a cero.', v_supplier.name;
    end if;

    v_fecha := nullif(v_fila->>'fecha', '')::date;
    if v_fecha is null then
      raise exception 'Falta la fecha del saldo de %.', v_supplier.name;
    end if;
    v_vence := coalesce(nullif(v_fila->>'vencimiento', '')::date, v_fecha);
    if v_vence < v_fecha then
      raise exception 'El saldo de % vence antes de su fecha.', v_supplier.name;
    end if;

    v_texto := trim(coalesce(v_fila->>'comprobante', ''));
    v_match := regexp_match(
      upper(v_texto),
      '^(?:FC|FAC|FACT|FACTURA)?\s*([ABCMX])\s*-?\s*(\d{1,5})\s*-\s*(\d{1,8})$'
    );
    if v_match is not null and v_match[3]::int > 0 then
      v_letra := v_match[1]::purchase_letter;
      v_pv := v_match[2]::int;
      v_numero := v_match[3]::int;
    else
      v_letra := 'X';
      v_pv := 0;
      select coalesce(max(number), 0) + 1 into v_numero
        from purchase_invoices
       where supplier_id = v_supplier.id and letter = 'X' and sales_point = 0 and doc_type = 'FACTURA';
    end if;

    if exists (
      select 1 from purchase_invoices
       where supplier_id = v_supplier.id and doc_type = 'FACTURA' and letter = v_letra
         and sales_point = v_pv and number = v_numero and status = 'REGISTRADA'
    ) then
      raise exception 'El comprobante % de % ya está cargado.', v_texto, v_supplier.name;
    end if;

    insert into purchase_invoices (
      kind, doc_type, letter, sales_point, number, status,
      supplier_id, supplier_name, supplier_legal_name, supplier_tax_id, supplier_tax_condition,
      issue_date, received_date, due_date, payment_terms_days,
      gross_amount, net_untaxed, total_amount,
      notes, created_by, saldo_inicial
    )
    values (
      'CONCEPTOS', 'FACTURA', v_letra, v_pv, v_numero, 'REGISTRADA',
      v_supplier.id, v_supplier.name, v_supplier.legal_name, v_supplier.tax_id, v_supplier.tax_condition,
      v_fecha, v_fecha, v_vence, v_vence - v_fecha,
      v_importe, v_importe, v_importe,
      'Saldo inicial' || case when v_texto <> '' then ' — ' || v_texto else '' end,
      auth.uid(), true
    );

    v_cantidad := v_cantidad + 1;
  end loop;

  return v_cantidad;
end;
$$;

revoke all on function public.cargar_saldos_iniciales_proveedores(jsonb) from public, anon;
grant execute on function public.cargar_saldos_iniciales_proveedores(jsonb) to authenticated;

notify pgrst, 'reload schema';
