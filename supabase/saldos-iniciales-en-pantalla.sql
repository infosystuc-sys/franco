-- ===========================================================================
-- Saldos iniciales cargados en pantalla
-- ===========================================================================
-- Migración sugerida: saldos_iniciales_en_pantalla
--
-- Además de la planilla, los saldos iniciales se pueden cargar a mano, un
-- cliente a la vez. Ahí el cliente ya está elegido en la pantalla: se manda su
-- id y la función lo usa directo, en vez de buscarlo por CUIT o por nombre
-- (dos clientes con el mismo nombre y sin CUIT se confundirían).

do $$
declare
  def text;
  nueva text;
begin
  -- La función se aplicó desde un archivo con saltos de línea de Windows: se
  -- normalizan para que el reemplazo encuentre el texto.
  select replace(pg_get_functiondef('public.importar_saldos_iniciales_clientes'::regproc), chr(13), '') into def;
  if def like '%customer_id''%' then
    return;
  end if;
  nueva := replace(def,
    '    v_cliente := null;
    if v_cuit is not null then',
    '    v_cliente := null;
    if nullif(v_fila->>''customer_id'', '''') is not null then
      select * into v_cliente from customers where id = (v_fila->>''customer_id'')::uuid;
      if v_cliente.id is null then
        raise exception ''Fila %: el cliente elegido no existe.'', v_idx;
      end if;
    elsif v_cuit is not null then');
  if nueva = def then
    raise exception 'No encontré la búsqueda del cliente en importar_saldos_iniciales_clientes';
  end if;
  execute nueva;
end $$;

-- El cliente elegido no necesita nombre ni CUIT en la fila.
do $$
declare
  def text;
  nueva text;
begin
  select replace(pg_get_functiondef('public.importar_saldos_iniciales_clientes'::regproc), chr(13), '') into def;
  nueva := replace(def,
    'if v_nombre is null and v_cuit is null then',
    'if v_nombre is null and v_cuit is null and nullif(v_fila->>''customer_id'', '''') is null then');
  if nueva <> def then
    execute nueva;
  end if;
end $$;

select count(*) as funcion_con_cliente_elegido
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'importar_saldos_iniciales_clientes'
   and p.prosrc like '%customer_id%';
