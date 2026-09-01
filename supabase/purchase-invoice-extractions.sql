-- Borrador de una factura de compra leída por IA: desde que se sube el
-- archivo hasta que se confirma (o se descarta). Ver
-- docs/superpowers/specs/2026-09-01-carga-facturas-compra-ia-design.md.

create type purchase_extraction_status as enum ('EXTRAIDO', 'CONFIRMADO', 'DESCARTADO', 'ERROR');

create table purchase_invoice_extractions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('ARTICULOS', 'CONCEPTOS')),
  supplier_id uuid references suppliers(id) on delete set null,
  attachment_storage_path text not null,
  attachment_mime_type text not null,
  raw_extraction jsonb,
  status purchase_extraction_status not null default 'EXTRAIDO',
  error_message text,
  purchase_invoice_id uuid references purchase_invoices(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index purchase_invoice_extractions_status_idx
  on purchase_invoice_extractions (status) where status = 'EXTRAIDO';

alter table purchase_invoice_extractions enable row level security;

create policy "admin select" on purchase_invoice_extractions for select using (is_admin());
create policy "admin insert" on purchase_invoice_extractions for insert with check (is_admin());
create policy "admin update" on purchase_invoice_extractions for update using (is_admin());
-- Sin policy de delete: un borrador descartado queda con status = DESCARTADO,
-- no se borra (auditoría de qué leyó la IA y qué se decidió hacer con eso).

-- Bucket privado, mismo criterio que vehicle-intakes y work-order-photos: se
-- lee con URL firmada desde la sesión del admin, nunca con getPublicUrl.
insert into storage.buckets (id, name, public) values ('purchase-invoice-drafts', 'purchase-invoice-drafts', false);

create policy "admin read purchase drafts" on storage.objects for select
  using (bucket_id = 'purchase-invoice-drafts' and is_admin());
create policy "admin upload purchase drafts" on storage.objects for insert
  with check (bucket_id = 'purchase-invoice-drafts' and is_admin());
create policy "admin delete purchase drafts" on storage.objects for delete
  using (bucket_id = 'purchase-invoice-drafts' and is_admin());
