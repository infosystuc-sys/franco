-- La Factura A solo se le hace a un cliente Responsable Inscripto: a cualquier
-- otro (consumidor final, monotributo, exento) corresponde B. Antes solo la
-- pantalla sugería la letra y la base aceptaba cualquiera.
do $$
declare
  v_def text;
  v_nuevo text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = '_create_invoice';

  v_def := replace(v_def, chr(13), '');
  if position('solo se le hace a un cliente Responsable Inscripto' in v_def) > 0 then
    return;
  end if;

  v_nuevo := replace(
    v_def,
    '  if p_link_remito_id is not null then
    select * into v_link_remito',
    '  if v_type = ''A'' and v_customer.tax_condition <> ''RESPONSABLE_INSCRIPTO'' then
    raise exception ''La Factura A solo se le hace a un cliente Responsable Inscripto; % es %. Corresponde Factura B.'',
      v_customer.name, v_customer.tax_condition;
  end if;

  if p_link_remito_id is not null then
    select * into v_link_remito'
  );
  if v_nuevo = v_def then
    raise exception 'No se encontró dónde validar la letra en _create_invoice';
  end if;
  execute v_nuevo;
end $$;
