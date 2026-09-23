-- ===========================================================================
-- El logo que va impreso en el comprobante
-- ===========================================================================
-- Migración sugerida: logo_del_comprobante
--
-- Se guarda como data URL adentro de la fila del taller, no como archivo en
-- un bucket, y la razón es el PDF.
--
-- El comprobante se convierte a PDF en el navegador con html2canvas. Una
-- imagen traída de otro origen "mancha" el canvas: el navegador se niega a
-- exportarlo y el PDF sale vacío o directamente falla, sin decir que la culpa
-- fue del logo. Un data URL es del mismo documento y nunca lo mancha.
--
-- Encima los cuatro buckets del proyecto son privados y se leen con URL
-- firmada a una hora. Para una imagen que se muestra en cada impresión, eso
-- significa pedir una firma nueva cada vez y que el papel dependa de que esa
-- firma no haya expirado.
--
-- El costo es que la fila pesa más. Por eso el límite: 400.000 caracteres de
-- base64 son unos 300 KB de imagen, de sobra para un logo y poco para que
-- moleste en una tabla de una sola fila.

alter table company_settings
  add column if not exists logo text;

alter table company_settings
  drop constraint if exists company_settings_logo_razonable;

alter table company_settings
  add constraint company_settings_logo_razonable check (
    logo is null or (logo like 'data:image/%' and length(logo) <= 400000)
  );

comment on column company_settings.logo is
  'Logo del comprobante, como data URL. No es un dato fiscal: se lee en vivo, '
  'así que cambiarlo cambia también la reimpresión de comprobantes viejos.';

-- Verificación
select
  logo is null as sin_logo,
  (select count(*) from pg_constraint
    where conrelid = 'public.company_settings'::regclass
      and conname = 'company_settings_logo_razonable') as constraint_puesto
from company_settings where id;
