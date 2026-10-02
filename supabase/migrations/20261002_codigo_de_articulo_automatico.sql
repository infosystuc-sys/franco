-- Nuestro código de artículo lo pone siempre el sistema, con la secuencia del
-- catálogo, y una vez puesto no se cambia. Antes la columna tenía ese valor
-- por defecto, pero el alta desde la pantalla exigía escribirlo a mano y
-- también se podía editar: quedaban códigos salteados, repetidos con otro
-- formato o cambiados después de haberse usado en facturas y órdenes.
--
-- Se hace en la base y no solo en la pantalla para que valga desde cualquier
-- lado: la ficha del artículo, la importación de listas, la carga de compras.

create or replace function public.asignar_codigo_de_articulo()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- Lo que venga escrito se ignora: el código es el siguiente de la secuencia.
    new.code := lpad(nextval('public.articles_code_seq')::text, 6, '0');
  elsif new.code is distinct from old.code then
    raise exception 'El código del artículo (%) lo asigna el sistema y no se puede modificar.', old.code;
  end if;
  return new;
end;
$$;

drop trigger if exists articles_codigo_automatico on public.articles;
create trigger articles_codigo_automatico
  before insert or update of code on public.articles
  for each row execute function public.asignar_codigo_de_articulo();
