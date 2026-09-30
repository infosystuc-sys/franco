-- ===========================================================================
-- Saldos iniciales de clientes, importados desde Excel
-- ===========================================================================
-- Migración sugerida: saldos_iniciales_clientes
--
-- Al empezar a usar la app, cada cliente ya trae deudas del sistema anterior
-- (y alguno, plata a favor). Hay que cargarlas para poder cobrarlas.
--
-- Cada deuda entra como una factura marcada saldo_inicial: así se cobra con
-- un recibo común, se imputa, suma al saldo, a la composición y a la
-- antigüedad, sin ningún camino aparte. Lo que NO puede hacer es contar como
-- venta: no es una venta de este sistema ni de este período. Por eso los
-- informes de ventas, el ranking, los artículos vendidos y el Libro IVA la
-- dejan afuera.
--
-- Va en la serie interna X con punto de venta 0, que no usa nadie: no
-- consume la numeración de la X real ni de ninguna fiscal. El número del
-- sistema anterior se guarda en referencia_anterior, y es lo que se muestra.
--
-- La plata a favor entra como un recibo marcado saldo_inicial, a cuenta y sin
-- valores: no movió caja (esa plata ya se cobró en el sistema anterior).

alter table invoices add column if not exists saldo_inicial boolean not null default false;
alter table receipts add column if not exists saldo_inicial boolean not null default false;
alter table invoices add column if not exists referencia_anterior text;

-- ---------------------------------------------------------------------------
-- Ventas e IVA: sin saldos iniciales
-- ---------------------------------------------------------------------------
-- Se regeneran desde la definición vigente con un reemplazo exacto, en vez de
-- reescribirlas a mano: son largas y un error de transcripción cambiaría
-- números del Libro IVA sin que se note.
do $$
declare
  f text;
  def text;
  nueva text;
begin
  foreach f in array array[
    'report_sales_by_period', 'report_monthly_sales', 'report_customer_ranking',
    'report_top_articles', 'report_vat_sales'
  ] loop
    select pg_get_functiondef(p.oid) into def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f;

    if def like '%saldo_inicial%' then
      continue;
    end if;

    nueva := replace(def, 'i.status = ''EMITIDA''', 'i.status = ''EMITIDA'' and not i.saldo_inicial');
    if nueva = def then
      raise exception 'No encontré el filtro de facturas en %', f;
    end if;
    execute nueva;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Cómo se nombra un saldo inicial donde se lista el comprobante
-- ---------------------------------------------------------------------------
-- En la composición de saldos y en la cuenta del cliente (imputación) se ve
-- "Saldo inicial" y el número del sistema anterior, no "X 0000-00000001".
do $$
declare
  def text;
  nueva text;
begin
  select pg_get_functiondef('public.report_customer_balances'::regproc) into def;
  if def not like '%saldo_inicial%' then
    nueva := replace(def,
      'i.invoice_type::text || '' '' || i.full_number,',
      'case when i.saldo_inicial then ''Saldo inicial '' || coalesce(i.referencia_anterior, i.full_number) else i.invoice_type::text || '' '' || i.full_number end,');
    if nueva = def then raise exception 'No encontré el nombre del comprobante en report_customer_balances'; end if;
    def := nueva;
    nueva := replace(def,
      'r.full_number || '' (a cuenta)''',
      'case when r.saldo_inicial then ''Saldo inicial a favor '' || r.full_number else r.full_number || '' (a cuenta)'' end');
    if nueva = def then raise exception 'No encontré el recibo a cuenta en report_customer_balances'; end if;
    execute nueva;
  end if;

  select pg_get_functiondef('public.cuenta_del_cliente'::regproc) into def;
  if def not like '%saldo_inicial%' then
    nueva := replace(def,
      '''full_number'', i.invoice_type::text || '' '' || i.full_number,',
      '''full_number'', case when i.saldo_inicial then ''Saldo inicial '' || coalesce(i.referencia_anterior, i.full_number) else i.invoice_type::text || '' '' || i.full_number end,');
    if nueva = def then raise exception 'No encontré el nombre del comprobante en cuenta_del_cliente'; end if;
    execute nueva;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- La importación
-- ---------------------------------------------------------------------------
-- p_filas: [{ cliente, cuit, comprobante, fecha, vencimiento, importe, condicion_iva }]
-- Importe positivo, el cliente debe; negativo, tiene a favor.
--
-- El cliente se busca por CUIT y, si no trae, por nombre exacto (sin
-- distinguir mayúsculas). Si no existe, se crea. Todo va en una sola
-- transacción: o entra la planilla entera, o nada.
create or replace function public.importar_saldos_iniciales_clientes(p_filas jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_fila jsonb;
  v_idx int := 0;
  v_empresa company_settings%rowtype;
  v_cliente customers%rowtype;
  v_cuit text;
  v_nombre text;
  v_importe numeric;
  v_fecha date;
  v_vence date;
  v_ref text;
  v_iva text;
  v_numero int;
  v_factura uuid;
  v_recibo int;
  v_creados int := 0;
  v_deudas int := 0;
  v_favor int := 0;
  v_total_deuda numeric := 0;
  v_total_favor numeric := 0;
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select * into v_empresa from company_settings limit 1;
  if not found or v_empresa.legal_name is null then
    raise exception 'Faltan los datos del taller en Configuración.';
  end if;

  select coalesce(max(number), 0) into v_numero
    from invoices where invoice_type = 'X' and sales_point = 0;

  for v_fila in select * from jsonb_array_elements(p_filas) loop
    v_idx := v_idx + 1;
    v_nombre := nullif(btrim(v_fila->>'cliente'), '');
    v_cuit := nullif(regexp_replace(coalesce(v_fila->>'cuit', ''), '\D', '', 'g'), '');
    v_importe := round((v_fila->>'importe')::numeric, 2);
    v_fecha := coalesce((v_fila->>'fecha')::date, current_date);
    v_vence := coalesce((v_fila->>'vencimiento')::date, v_fecha);
    v_ref := nullif(btrim(v_fila->>'comprobante'), '');
    -- La app la deduce de los comprobantes (a quien se le hizo factura A es
    -- inscripto). Solo se usa al crear el cliente.
    v_iva := nullif(v_fila->>'condicion_iva', '');
    if v_iva is not null and v_iva not in ('RESPONSABLE_INSCRIPTO','MONOTRIBUTO','EXENTO','CONSUMIDOR_FINAL') then
      raise exception 'Fila %: condición de IVA inválida (%).', v_idx, v_iva;
    end if;

    if v_nombre is null and v_cuit is null then
      raise exception 'Fila %: falta el cliente.', v_idx;
    end if;
    if v_importe is null or v_importe = 0 then
      raise exception 'Fila %: el importe tiene que ser distinto de cero.', v_idx;
    end if;
    if v_vence < v_fecha then
      raise exception 'Fila %: el vencimiento es anterior a la fecha.', v_idx;
    end if;

    v_cliente := null;
    if v_cuit is not null then
      select * into v_cliente from customers where tax_id = v_cuit;
    end if;
    if v_cliente.id is null and v_nombre is not null then
      select * into v_cliente from customers where lower(name) = lower(v_nombre)
       order by created_at limit 1;
    end if;
    if v_cliente.id is null then
      insert into customers (name, legal_name, tax_id, tax_condition, condicion_venta)
      values (
        coalesce(v_nombre, v_cuit), v_nombre, v_cuit,
        -- Sin factura A no se sabe la condición: queda Consumidor Final y la
        -- confirma quien completa la ficha.
        coalesce(v_iva, 'CONSUMIDOR_FINAL'), 'CUENTA_CORRIENTE'
      )
      returning * into v_cliente;
      v_creados := v_creados + 1;
    end if;

    if v_importe > 0 then
      v_numero := v_numero + 1;
      insert into invoices (
        invoice_type, sales_point, number, referencia_anterior, status, saldo_inicial,
        customer_id, customer_name, customer_legal_name, customer_tax_id,
        customer_tax_condition, customer_address,
        issuer_legal_name, issuer_tax_id, issuer_tax_condition,
        issue_date, due_date, payment_terms_days,
        net_amount, vat_amount, total_amount, paid_amount, notes, created_by
      ) values (
        'X', 0, v_numero, v_ref, 'EMITIDA', true,
        v_cliente.id, v_cliente.name, v_cliente.legal_name, v_cliente.tax_id,
        v_cliente.tax_condition, null,
        v_empresa.legal_name, v_empresa.tax_id, v_empresa.tax_condition,
        v_fecha, v_vence, v_vence - v_fecha,
        v_importe, 0, v_importe, 0,
        'Saldo inicial importado' || coalesce(' — ' || v_ref, ''), auth.uid()
      )
      returning id into v_factura;

      insert into invoice_items (invoice_id, code, description, quantity, unit_price, subtotal, line_number)
      values (v_factura, null, 'Saldo inicial' || coalesce(' — ' || v_ref, ''), 1, v_importe, v_importe, 1);

      v_deudas := v_deudas + 1;
      v_total_deuda := v_total_deuda + v_importe;
    else
      -- Numeración propia (SI-…), fuera del rango de los recibos reales: si
      -- tomara de receipt_sequence, el primer recibo verdadero no sería el 1.
      select coalesce(max(number), 900000000) + 1 into v_recibo
        from receipts where number > 900000000;
      insert into receipts (
        number, full_number, status, saldo_inicial, customer_id, customer_name, receipt_date,
        total_amount, applied_amount, notes, created_by
      ) values (
        v_recibo, 'SI-' || lpad((v_recibo - 900000000)::text, 8, '0'), 'REGISTRADO', true,
        v_cliente.id, v_cliente.name, v_fecha,
        -v_importe, 0,
        'Saldo inicial a favor importado' || coalesce(' — ' || v_ref, ''), auth.uid()
      );
      v_favor := v_favor + 1;
      v_total_favor := v_total_favor - v_importe;
    end if;
  end loop;

  return jsonb_build_object(
    'clientes_creados', v_creados,
    'deudas', v_deudas,
    'total_deuda', v_total_deuda,
    'a_favor', v_favor,
    'total_a_favor', v_total_favor
  );
end;
$$;

revoke all on function public.importar_saldos_iniciales_clientes(jsonb) from public, anon;
grant execute on function public.importar_saldos_iniciales_clientes(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('report_sales_by_period','report_monthly_sales','report_customer_ranking',
                        'report_top_articles','report_vat_sales')
      and p.prosrc like '%saldo_inicial%') as informes_sin_saldos_iniciales,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'importar_saldos_iniciales_clientes') as funcion;
