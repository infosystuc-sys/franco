-- ===========================================================================
-- Saldos iniciales: el número del comprobante con el formato de la app
-- ===========================================================================
-- Migración sugerida: saldos_iniciales_formato
--
-- Las facturas traídas del sistema anterior se veían con todo el texto de la
-- planilla: "Saldo inicial Factura de venta A 00001-00001651". Ahora se ven
-- como cualquier factura emitida por la app: "A 0001-00001651" (letra, punto
-- de venta de 4 dígitos y número de 8).
--
-- La referencia se normaliza al importar y se corrigen las ya importadas. Si
-- una referencia no tiene la forma letra + punto de venta-número, queda tal
-- cual: mejor el texto original que un número inventado.

create or replace function public.formato_comprobante_anterior(p_ref text)
returns text
language sql
immutable
as $$
  select case
    when m is null then p_ref
    else m[1] || ' ' ||
         case when length(ltrim(m[2], '0')) > 4 then ltrim(m[2], '0') else lpad(ltrim(m[2], '0'), 4, '0') end ||
         '-' ||
         lpad(ltrim(m[3], '0'), 8, '0')
  end
  from (select regexp_match(p_ref, '\m([ABCMX])\s+(\d{1,5})-(\d{1,8})\M') as m) x
$$;

-- Las ya importadas.
update invoice_items ii
   set description = 'Saldo inicial — ' || formato_comprobante_anterior(i.referencia_anterior)
  from invoices i
 where ii.invoice_id = i.id and i.saldo_inicial and i.referencia_anterior is not null;

update invoices
   set referencia_anterior = formato_comprobante_anterior(referencia_anterior)
 where saldo_inicial and referencia_anterior is not null;

-- Las que se importen de acá en más, y sin el "Saldo inicial" delante donde
-- se lista el comprobante (la composición y la cuenta del cliente).
do $$
declare
  def text;
  nueva text;
begin
  select pg_get_functiondef('public.importar_saldos_iniciales_clientes'::regproc) into def;
  if def not like '%formato_comprobante_anterior%' then
    nueva := replace(def,
      'v_ref := nullif(btrim(v_fila->>''comprobante''), '''');',
      'v_ref := formato_comprobante_anterior(nullif(btrim(v_fila->>''comprobante''), ''''));');
    if nueva = def then raise exception 'No encontré la referencia en importar_saldos_iniciales_clientes'; end if;
    execute nueva;
  end if;

  select pg_get_functiondef('public.report_customer_balances'::regproc) into def;
  nueva := replace(def, '''Saldo inicial '' || coalesce(i.referencia_anterior', 'coalesce(i.referencia_anterior');
  if nueva <> def then execute nueva; end if;

  select pg_get_functiondef('public.cuenta_del_cliente'::regproc) into def;
  nueva := replace(def, '''Saldo inicial '' || coalesce(i.referencia_anterior', 'coalesce(i.referencia_anterior');
  if nueva <> def then execute nueva; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  formato_comprobante_anterior('Factura de venta A 00001-00001651') as ejemplo,
  (select count(*) from invoices where saldo_inicial and referencia_anterior !~ '^[ABCMX] \d{4,5}-\d{8}$') as sin_formato,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('report_customer_balances', 'cuenta_del_cliente')
      and p.prosrc like '%Saldo inicial ''%') as todavia_con_prefijo;
