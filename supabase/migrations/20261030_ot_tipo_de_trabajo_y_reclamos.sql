-- Órdenes de trabajo: tipo de trabajo (electrónico / mecánico) y reclamos.
--
-- · work_type: qué clase de trabajo es, para filtrar el listado. Se elige al
--   recibir y se puede cambiar desde la ficha. Null = sin definir (todas las
--   órdenes cargadas antes de este cambio).
-- · claim_of_id: un reclamo del cliente abre una OT nueva que apunta a la
--   original. La original figura como "Reclamada" mientras tenga un reclamo
--   (se calcula: no hay una marca que se pueda desincronizar).

alter table public.work_orders
  add column if not exists work_type text
    check (work_type is null or work_type in ('ELECTRONICO', 'MECANICO', 'AMBOS')),
  add column if not exists claim_of_id uuid references public.work_orders(id) on delete set null,
  add column if not exists claim_reason text;

comment on column public.work_orders.work_type is
  'Tipo de trabajo: ELECTRONICO, MECANICO o AMBOS. Null = sin definir.';
comment on column public.work_orders.claim_of_id is
  'Reclamo: la orden original que el cliente reclamó.';
comment on column public.work_orders.claim_reason is
  'Reclamo: qué reclamó el cliente.';

create index if not exists work_orders_claim_of_idx
  on public.work_orders (claim_of_id)
  where claim_of_id is not null;

notify pgrst, 'reload schema';
