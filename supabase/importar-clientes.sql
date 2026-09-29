-- ===========================================================================
-- Importación masiva de clientes desde Excel
-- ===========================================================================
-- Migración sugerida: importar_clientes
--
-- p_filas: [{ nombre, razon_social, cuit, condicion_iva, condicion_venta,
--             email, telefono, domicilio, localidad, provincia, cp, notas }]
--
-- Cada fila se busca por CUIT y, si no trae, por el nombre exacto (sin
-- distinguir mayúsculas), el mismo criterio que la importación de saldos
-- iniciales. Si existe, se completa con lo que la planilla trae y nada más:
-- una celda vacía no borra el dato que ya estaba cargado. Si no existe, se
-- crea. Todo en una transacción: o entra la planilla entera, o nada.
--
-- La condición de IVA y la de venta llegan ya traducidas por la app a los
-- valores de la base; acá se validan igual, porque la función la puede
-- llamar cualquiera con la anon key.

create or replace function public.importar_clientes(p_filas jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_fila jsonb;
  v_idx int := 0;
  v_id uuid;
  v_nombre text;
  v_cuit text;
  v_iva text;
  v_venta text;
  v_creados int := 0;
  v_actualizados int := 0;
begin
  if not is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  for v_fila in select * from jsonb_array_elements(p_filas) loop
    v_idx := v_idx + 1;
    v_nombre := nullif(btrim(coalesce(v_fila->>'nombre', v_fila->>'razon_social')), '');
    v_cuit := nullif(regexp_replace(coalesce(v_fila->>'cuit', ''), '\D', '', 'g'), '');
    v_iva := nullif(v_fila->>'condicion_iva', '');
    v_venta := nullif(v_fila->>'condicion_venta', '');

    if v_nombre is null then
      raise exception 'Fila %: falta el nombre del cliente.', v_idx;
    end if;
    if v_iva is not null and v_iva not in ('RESPONSABLE_INSCRIPTO','MONOTRIBUTO','EXENTO','CONSUMIDOR_FINAL') then
      raise exception 'Fila %: condición de IVA inválida (%).', v_idx, v_iva;
    end if;
    if v_venta is not null and v_venta not in ('CONTADO','CUENTA_CORRIENTE') then
      raise exception 'Fila %: condición de venta inválida (%).', v_idx, v_venta;
    end if;

    v_id := null;
    if v_cuit is not null then
      select id into v_id from customers where tax_id = v_cuit;
    end if;
    if v_id is null then
      select id into v_id from customers where lower(name) = lower(v_nombre)
       order by created_at limit 1;
    end if;

    if v_id is null then
      insert into customers (
        name, legal_name, tax_id, tax_condition, condicion_venta, email, phone,
        address_street, address_city, address_state, address_zip, notes
      ) values (
        v_nombre,
        nullif(btrim(v_fila->>'razon_social'), ''),
        v_cuit,
        coalesce(v_iva, 'CONSUMIDOR_FINAL'),
        v_venta,
        nullif(btrim(v_fila->>'email'), ''),
        nullif(btrim(v_fila->>'telefono'), ''),
        nullif(btrim(v_fila->>'domicilio'), ''),
        nullif(btrim(v_fila->>'localidad'), ''),
        nullif(btrim(v_fila->>'provincia'), ''),
        nullif(btrim(v_fila->>'cp'), ''),
        nullif(btrim(v_fila->>'notas'), '')
      );
      v_creados := v_creados + 1;
    else
      -- El nombre no se toca: es con lo que se lo encontró (o su CUIT, que
      -- manda sobre el nombre), y renombrarlo desde una planilla sorprende.
      update customers set
        legal_name     = coalesce(nullif(btrim(v_fila->>'razon_social'), ''), legal_name),
        tax_id         = coalesce(tax_id, v_cuit),
        tax_condition  = coalesce(v_iva, tax_condition),
        condicion_venta = coalesce(v_venta, condicion_venta),
        email          = coalesce(nullif(btrim(v_fila->>'email'), ''), email),
        phone          = coalesce(nullif(btrim(v_fila->>'telefono'), ''), phone),
        address_street = coalesce(nullif(btrim(v_fila->>'domicilio'), ''), address_street),
        address_city   = coalesce(nullif(btrim(v_fila->>'localidad'), ''), address_city),
        address_state  = coalesce(nullif(btrim(v_fila->>'provincia'), ''), address_state),
        address_zip    = coalesce(nullif(btrim(v_fila->>'cp'), ''), address_zip),
        notes          = coalesce(nullif(btrim(v_fila->>'notas'), ''), notes)
      where id = v_id;
      v_actualizados := v_actualizados + 1;
    end if;
  end loop;

  return jsonb_build_object('creados', v_creados, 'actualizados', v_actualizados);
end;
$$;

revoke all on function public.importar_clientes(jsonb) from public, anon;
grant execute on function public.importar_clientes(jsonb) to authenticated;

select count(*) as funcion from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'importar_clientes';
