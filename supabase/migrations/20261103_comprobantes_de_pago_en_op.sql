-- Comprobantes del banco en las órdenes de pago.
--
-- La constancia de la transferencia (o del eCheq) que emite el banco, en PDF,
-- se sube a la orden de pago y viaja adjunta cuando la orden se manda al
-- proveedor por mail o WhatsApp. Puede haber más de una: una orden pagada con
-- dos transferencias tiene dos constancias.
--
-- Los archivos van a un bucket privado, como las fotos y los borradores de
-- compras: se leen con URL firmada desde la sesión del admin.

create table if not exists public.payment_order_attachments (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid not null references public.payment_orders(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  size_bytes integer,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists payment_order_attachments_order_idx
  on public.payment_order_attachments (payment_order_id);

alter table public.payment_order_attachments enable row level security;

drop policy if exists "admin lee comprobantes de pago" on public.payment_order_attachments;
drop policy if exists "admin sube comprobantes de pago" on public.payment_order_attachments;
drop policy if exists "admin borra comprobantes de pago" on public.payment_order_attachments;
create policy "admin lee comprobantes de pago" on public.payment_order_attachments
  for select to authenticated using (public.is_admin());
create policy "admin sube comprobantes de pago" on public.payment_order_attachments
  for insert to authenticated with check (public.is_admin());
create policy "admin borra comprobantes de pago" on public.payment_order_attachments
  for delete to authenticated using (public.is_admin());

grant select, insert, delete on public.payment_order_attachments to authenticated;

insert into storage.buckets (id, name, public)
values ('payment-order-attachments', 'payment-order-attachments', false)
on conflict (id) do nothing;

drop policy if exists "admin read payment order attachments" on storage.objects;
drop policy if exists "admin upload payment order attachments" on storage.objects;
drop policy if exists "admin delete payment order attachments" on storage.objects;
create policy "admin read payment order attachments" on storage.objects for select
  using (bucket_id = 'payment-order-attachments' and public.is_admin());
create policy "admin upload payment order attachments" on storage.objects for insert
  with check (bucket_id = 'payment-order-attachments' and public.is_admin());
create policy "admin delete payment order attachments" on storage.objects for delete
  using (bucket_id = 'payment-order-attachments' and public.is_admin());

notify pgrst, 'reload schema';
