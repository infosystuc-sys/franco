-- ===========================================================================
-- Fotos en la Orden de Trabajo (estado de las piezas durante la reparación)
-- ===========================================================================
-- Migración: work_order_photos
--
-- Mismo esquema que vehicle_intake_photos (ver vehicle-intakes.sql), pero
-- con una diferencia obligada: work_orders ya tiene una regla de lectura
-- más fina que "admin o nada" — un operario ve las OT que tiene asignadas
-- (policy "lectura segun rol": is_admin() or employee_id = current_employee_id()),
-- no todas. Las fotos tienen que respetar exactamente esa misma frontera,
-- así que la lectura acá —de la fila y del archivo— se resuelve mirando el
-- work_order al que pertenece la foto, no un simple "true".
--
-- Subir y borrar sigue siendo admin-only, igual que el resto de la ficha.

create table public.work_order_photos (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index work_order_photos_work_order_id_idx on public.work_order_photos(work_order_id);

alter table public.work_order_photos enable row level security;

create policy "lectura segun rol" on public.work_order_photos for select
  to authenticated
  using (
    exists (
      select 1 from public.work_orders wo
      where wo.id = work_order_photos.work_order_id
        and (is_admin() or wo.employee_id = current_employee_id())
    )
  );

create policy "admin insert" on public.work_order_photos for insert with check (is_admin());
create policy "admin delete" on public.work_order_photos for delete using (is_admin());

-- Bucket privado, URL firmada (createSignedUrl), nunca getPublicUrl. El
-- archivo se guarda como "<work_order_id>/<uuid>.<ext>" — igual convención
-- que vehicle-intakes — para que la política de storage.objects pueda mirar
-- el primer segmento del path y aplicar la misma regla de arriba sin
-- depender de la tabla work_order_photos.
insert into storage.buckets (id, name, public) values ('work-order-photos', 'work-order-photos', false);

create policy "lectura segun rol" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'work-order-photos'
    and exists (
      select 1 from public.work_orders wo
      where wo.id::text = (storage.foldername(name))[1]
        and (is_admin() or wo.employee_id = current_employee_id())
    )
  );
create policy "admin upload work order photos" on storage.objects for insert
  with check (bucket_id = 'work-order-photos' and is_admin());
create policy "admin delete work order photos" on storage.objects for delete
  using (bucket_id = 'work-order-photos' and is_admin());
