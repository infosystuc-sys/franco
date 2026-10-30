-- Los bancos de Argentina, ya cargados para la carga de cheques.
--
-- El catálogo arrancaba vacío y cada banco se daba de alta la primera vez que
-- llegaba un cheque suyo. Acá van los bancos con su código de entidad del
-- BCRA (los tres dígitos que trae impresos el cheque). No pisa nada: si el
-- código ya está cargado, o ya hay un banco con el mismo nombre, se saltea.
-- Desde Tesorería → Bancos se pueden corregir o desactivar.

insert into public.banks (code, name)
select v.code, v.name
from (values
  ('007', 'Banco de Galicia y Buenos Aires'),
  ('011', 'Banco de la Nación Argentina'),
  ('014', 'Banco de la Provincia de Buenos Aires'),
  ('015', 'ICBC (Industrial and Commercial Bank of China)'),
  ('016', 'Citibank'),
  ('017', 'BBVA Argentina'),
  ('020', 'Banco de la Provincia de Córdoba'),
  ('027', 'Banco Supervielle'),
  ('029', 'Banco de la Ciudad de Buenos Aires'),
  ('034', 'Banco Patagonia'),
  ('044', 'Banco Hipotecario'),
  ('045', 'Banco de San Juan'),
  ('060', 'Banco del Tucumán'),
  ('065', 'Banco Municipal de Rosario'),
  ('072', 'Banco Santander Argentina'),
  ('083', 'Banco del Chubut'),
  ('086', 'Banco de Santa Cruz'),
  ('093', 'Banco de La Pampa'),
  ('094', 'Banco de Corrientes'),
  ('097', 'Banco Provincia del Neuquén'),
  ('143', 'Brubank'),
  ('147', 'Banco Interfinanzas'),
  ('150', 'HSBC Bank Argentina'),
  ('165', 'JPMorgan Chase Bank'),
  ('191', 'Banco Credicoop'),
  ('198', 'Banco de Valores'),
  ('247', 'Banco Roela'),
  ('254', 'Banco Mariva'),
  ('266', 'BNP Paribas'),
  ('268', 'Banco Provincia de Tierra del Fuego'),
  ('269', 'Banco de la República Oriental del Uruguay'),
  ('277', 'Banco Sáenz'),
  ('281', 'Banco Meridian'),
  ('285', 'Banco Macro'),
  ('299', 'Banco Comafi'),
  ('300', 'Banco de Inversión y Comercio Exterior (BICE)'),
  ('301', 'Banco Piano'),
  ('305', 'Banco Julio'),
  ('309', 'Banco Rioja'),
  ('310', 'Banco del Sol'),
  ('311', 'Nuevo Banco del Chaco'),
  ('312', 'Banco Voii'),
  ('315', 'Banco de Formosa'),
  ('319', 'Banco CMF'),
  ('321', 'Banco de Santiago del Estero'),
  ('322', 'Banco Industrial (BIND)'),
  ('330', 'Nuevo Banco de Santa Fe'),
  ('331', 'Banco Cetelem Argentina'),
  ('332', 'Banco de Servicios Financieros'),
  ('338', 'Banco de Servicios y Transacciones'),
  ('339', 'RCI Banque'),
  ('340', 'BACS Banco de Crédito y Securitización'),
  ('341', 'Banco Masventas'),
  ('384', 'Wilobank'),
  ('386', 'Nuevo Banco de Entre Ríos'),
  ('389', 'Banco Columbia'),
  ('426', 'Banco Bica'),
  ('431', 'Banco Coinag'),
  ('432', 'Banco de Comercio'),
  ('448', 'Banco Dino')
) as v(code, name)
where not exists (
  select 1 from public.banks b
   where b.code = v.code
      or lower(b.name) = lower(v.name)
);
