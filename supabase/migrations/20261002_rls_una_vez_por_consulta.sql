-- Las políticas de lectura llamaban a is_admin() (y a is_contador() y
-- current_employee_id()) una vez POR FILA: cada artículo, cliente o factura
-- que se leía volvía a consultar profiles para saber si quien pregunta es
-- admin. Con ~20.000 artículos eso hacía cada tanda de 1000 seis veces más
-- lenta (1,1 s contra 0,19 s sin RLS) y, con las tandas pedidas en paralelo,
-- la pantalla de facturar pasaba el límite de 8 s de la base: quedaba en
-- "Cargando…" y terminaba diciendo que faltaban los datos fiscales.
--
-- Envueltas en (select ...), Postgres las evalúa una sola vez por consulta
-- (InitPlan) en vez de una por fila. Quién puede ver qué no cambia.
do $$
declare
  p record;
  nuevo_using text;
  nuevo_check text;
  sentencia text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ~ '(is_admin|is_contador|current_employee_id)\(\)'
        or coalesce(with_check, '') ~ '(is_admin|is_contador|current_employee_id)\(\)')
  loop
    nuevo_using := p.qual;
    nuevo_check := p.with_check;
    if nuevo_using is not null then
      nuevo_using := regexp_replace(nuevo_using, '(?<![Ss][Ee][Ll][Ee][Cc][Tt] )(is_admin|is_contador|current_employee_id)\(\)', '(select \1())', 'g');
    end if;
    if nuevo_check is not null then
      nuevo_check := regexp_replace(nuevo_check, '(?<![Ss][Ee][Ll][Ee][Cc][Tt] )(is_admin|is_contador|current_employee_id)\(\)', '(select \1())', 'g');
    end if;
    sentencia := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if nuevo_using is not null then sentencia := sentencia || format(' using (%s)', nuevo_using); end if;
    if nuevo_check is not null then sentencia := sentencia || format(' with check (%s)', nuevo_check); end if;
    execute sentencia;
  end loop;
end $$;
