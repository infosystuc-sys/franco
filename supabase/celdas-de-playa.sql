-- ===========================================================================
-- La playa se mide en celdas
-- ===========================================================================
-- Migración: celdas_de_playa
--
-- Los tres cupos por tamaño modelaban un taller con tres playas separadas, una
-- por tamaño. Hay una sola, y lo que entra depende de cómo se combinan los
-- vehículos: una celda admite un grande o hasta tres medianos.
--
-- Ver el diseño completo en:
--   docs/superpowers/specs/2026-09-06-celdas-de-playa-design.md

-- ── 1) El tamaño queda en dos valores ──────────────────────────────────────
-- No se reasigna nada: hoy ningún vehículo es CHICO. Si apareciera uno, este
-- ALTER falla y la migración se detiene, que es lo que se busca — el tamaño
-- decide cuánto lugar ocupa el vehículo, y adivinarlo es exactamente lo que
-- este diseño viene a evitar. Si falla, hay que corregir esas filas a mano
-- sabiendo cuál es cada vehículo.
alter table public.vehicles drop constraint vehicles_size_class_check;
alter table public.vehicles add constraint vehicles_size_class_check
  check (size_class = any (array['MEDIANO'::text, 'GRANDE'::text]));

-- ── 2) La cantidad de celdas ───────────────────────────────────────────────
-- Va a app_settings, que es donde ya viven los escalares de configuración del
-- taller (default_markup_percent sigue el mismo patrón). yard_capacity existía
-- solo porque había tres valores indexados por tamaño; con un único número deja
-- de tener sentido.
--
-- 10 es un punto de partida configurable, no una medición: hay que revisarlo en
-- Configuración.
insert into public.app_settings (key, value)
values ('yard_cells', '10')
on conflict (key) do nothing;

drop table if exists public.yard_capacity;

-- ── 3) El margen de retiro se elimina ──────────────────────────────────────
-- La celda ya no se libera porque venza una fecha, sino cuando la orden pasa a
-- Retirado. El margen quedaba prometiendo lugar por una fecha que no manda.
alter table public.company_settings drop column if exists yard_pickup_grace_days;
