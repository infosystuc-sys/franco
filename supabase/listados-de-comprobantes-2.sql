-- ===========================================================================
-- Listados estilo Tango, segunda tanda: órdenes de trabajo, compras y pagos
-- ===========================================================================
-- Migración sugerida: listados_de_comprobantes_2
--
-- Sigue a listados-de-comprobantes.sql. Las tres pantallas que faltaban pasan
-- al mismo listado, con "Etiquetar" en las tres y "Enviado" en las órdenes de
-- pago, que son las únicas de estas que se mandan (al proveedor).

alter table work_orders       add column if not exists etiquetas text[] not null default '{}';
alter table purchase_invoices add column if not exists etiquetas text[] not null default '{}';
alter table payment_orders    add column if not exists etiquetas text[] not null default '{}';
alter table payment_orders    add column if not exists enviado_at timestamptz;

create or replace function public._tabla_de_comprobante(p_tipo text)
returns text
language sql
immutable
as $$
  select case p_tipo
    when 'factura'       then 'invoices'
    when 'nota_credito'  then 'credit_notes'
    when 'recibo'        then 'receipts'
    when 'presupuesto'   then 'quotations'
    when 'remito'        then 'remitos'
    when 'orden_trabajo' then 'work_orders'
    when 'compra'        then 'purchase_invoices'
    when 'orden_pago'    then 'payment_orders'
  end
$$;

-- Una orden de trabajo o una compra no se mandan: pedir marcarlas como
-- enviadas es un error de la app, no algo que haya que guardar.
create or replace function public.marcar_comprobante_enviado(p_tipo text, p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tabla text := _tabla_de_comprobante(p_tipo);
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;
  if v_tabla is null or v_tabla in ('work_orders', 'purchase_invoices') then
    raise exception 'Ese tipo de comprobante no se envía: %', p_tipo;
  end if;

  execute format('update %I set enviado_at = now() where id = $1', v_tabla) using p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Verificación
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'etiquetas'
      and table_name in ('work_orders','purchase_invoices','payment_orders')) as columnas_etiquetas,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'enviado_at'
      and table_name = 'payment_orders') as columna_enviado,
  _tabla_de_comprobante('compra') as compra_resuelve_a;
