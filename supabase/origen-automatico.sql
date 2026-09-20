-- ===========================================================================
-- El origen se deduce solo: Bosch es original, el mismo número con otra marca
-- es reemplazo
-- ===========================================================================
-- Migración: origen_automatico
--
-- Correr DESPUÉS de ficha-de-articulo.sql.
--
-- La regla del taller es:
--   * marca BOSCH                      -> ORIGINAL, siempre;
--   * código de Bosch con otra marca   -> REEMPLAZO.
--
-- La primera mitad es directa. La segunda tiene una trampa: hay que saber que
-- ESE número es de Bosch, y eso no se puede deducir de su forma. 0934008230 es
-- Denso, 1050155810 es Zexel, y los tres se escriben igual —diez dígitos—. Con
-- la regla ingenua ("tiene código de fábrica y no es Bosch, entonces es
-- reemplazo") quedarían marcados como reemplazo los ~3.400 artículos Denso,
-- Delphi y Zexel que son el original de su propia marca.
--
-- Así que el padrón es el catálogo: un número ES de Bosch cuando algún
-- artículo con marca BOSCH lo tiene. Eso es exacto, y se va afinando solo a
-- medida que entra la lista del distribuidor oficial.
--
-- Lo que no encaja en ninguna de las dos reglas —un Denso con número Denso—
-- se deja como está: nulo, o lo que se haya puesto a mano. No se inventa.

-- ---------------------------------------------------------------------------
-- 1. Clasificar el artículo que entra o cambia
-- ---------------------------------------------------------------------------
create or replace function public.clasificar_origen_de_articulo()
returns trigger
language plpgsql
as $fn$
begin
  if upper(trim(coalesce(new.brand, ''))) = 'BOSCH' then
    new.part_kind := 'ORIGINAL';

  elsif new.factory_code is not null and exists (
    select 1 from articles a
    where a.factory_code = new.factory_code
      and a.id <> new.id
      and upper(trim(coalesce(a.brand, ''))) = 'BOSCH'
  ) then
    new.part_kind := 'REEMPLAZO';
  end if;

  return new;
end;
$fn$;

drop trigger if exists articles_clasificar_origen on public.articles;
create trigger articles_clasificar_origen
before insert or update of brand, factory_code on public.articles
for each row execute function public.clasificar_origen_de_articulo();

-- ---------------------------------------------------------------------------
-- 2. Y al revés: cuando aparece el Bosch, marcar a sus reemplazos
-- ---------------------------------------------------------------------------
-- El orden de importación no se puede controlar. Si el NORK entra antes que el
-- Bosch, al momento de entrar todavía no había con qué compararlo y quedó
-- nulo. Cuando después aparece el Bosch con ese número, los alcanza.
--
-- No entra en bucle: el update de abajo toca part_kind, y el disparador de
-- arriba está declarado "update OF brand, factory_code", así que no se dispara.
-- Este de acá solo actúa cuando la fila ES Bosch, y las que actualiza no lo
-- son, con lo cual tampoco se vuelve a llamar.
create or replace function public.marcar_reemplazos_del_bosch()
returns trigger
language plpgsql
as $fn$
begin
  if new.factory_code is null then
    return null;
  end if;

  update articles
     set part_kind = 'REEMPLAZO'
   where factory_code = new.factory_code
     and id <> new.id
     and upper(trim(coalesce(brand, ''))) <> 'BOSCH'
     and part_kind is distinct from 'REEMPLAZO';

  return null;
end;
$fn$;

drop trigger if exists articles_marcar_reemplazos on public.articles;
create trigger articles_marcar_reemplazos
after insert or update of brand, factory_code on public.articles
for each row
when (upper(trim(coalesce(new.brand, ''))) = 'BOSCH')
execute function public.marcar_reemplazos_del_bosch();

-- ---------------------------------------------------------------------------
-- 3. Lo que ya está cargado
-- ---------------------------------------------------------------------------
update articles
   set part_kind = 'ORIGINAL'
 where upper(trim(coalesce(brand, ''))) = 'BOSCH'
   and part_kind is distinct from 'ORIGINAL';

update articles a
   set part_kind = 'REEMPLAZO'
 where a.factory_code is not null
   and upper(trim(coalesce(a.brand, ''))) <> 'BOSCH'
   and a.part_kind is distinct from 'REEMPLAZO'
   and exists (
     select 1 from articles b
     where b.factory_code = a.factory_code
       and b.id <> a.id
       and upper(trim(coalesce(b.brand, ''))) = 'BOSCH'
   );
