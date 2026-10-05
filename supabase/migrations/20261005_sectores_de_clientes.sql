-- Sectores de un cliente: compras, administración, taller... cada uno con su
-- propio teléfono y mail de contacto. Una OT, una cotización o una factura
-- pueden quedar asignadas a un sector, y entonces los envíos (mail, WhatsApp,
-- avisos de la orden) van a ese contacto en vez de al general del cliente.

create table if not exists public.customer_sectors (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  phone text,
  -- El mismo número normalizado que customers.phone_e164, que es el que
  -- entiende WhatsApp. Lo completa el disparador de abajo.
  phone_e164 text,
  email text,
  created_at timestamptz not null default now()
);

create index if not exists customer_sectors_customer_idx on public.customer_sectors(customer_id);

drop trigger if exists customer_sectors_sync_phone on public.customer_sectors;
create trigger customer_sectors_sync_phone
  before insert or update of phone on public.customer_sectors
  for each row execute function public.sync_customer_phone();

alter table public.customer_sectors enable row level security;

-- Lo ve quien ve al cliente (admin, o el operario con una OT de ese cliente);
-- lo cambia solo un admin. Igual que los vehículos.
drop policy if exists "lectura segun rol" on public.customer_sectors;
create policy "lectura segun rol" on public.customer_sectors
  for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1 from public.work_orders w
      where w.customer_id = customer_sectors.customer_id
        and w.employee_id = (select public.current_employee_id())
    )
  );
drop policy if exists "admin insert" on public.customer_sectors;
create policy "admin insert" on public.customer_sectors
  for insert with check ((select public.is_admin()));
drop policy if exists "admin update" on public.customer_sectors;
create policy "admin update" on public.customer_sectors
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "admin delete" on public.customer_sectors;
create policy "admin delete" on public.customer_sectors
  for delete using ((select public.is_admin()));

alter table public.work_orders add column if not exists customer_sector_id uuid references public.customer_sectors(id) on delete set null;
alter table public.quotations  add column if not exists customer_sector_id uuid references public.customer_sectors(id) on delete set null;
alter table public.invoices    add column if not exists customer_sector_id uuid references public.customer_sectors(id) on delete set null;

-- Una cotización o una factura que sale de una OT hereda su sector, salvo que
-- se le haya elegido otro.
create or replace function public.heredar_sector_de_la_orden()
returns trigger
language plpgsql
as $$
begin
  if new.customer_sector_id is null and new.work_order_id is not null then
    select w.customer_sector_id into new.customer_sector_id
    from public.work_orders w
    where w.id = new.work_order_id and w.customer_id = new.customer_id;
  end if;
  return new;
end;
$$;

drop trigger if exists quotations_heredar_sector on public.quotations;
create trigger quotations_heredar_sector
  before insert on public.quotations
  for each row execute function public.heredar_sector_de_la_orden();

drop trigger if exists invoices_heredar_sector on public.invoices;
create trigger invoices_heredar_sector
  before insert on public.invoices
  for each row execute function public.heredar_sector_de_la_orden();

-- Los avisos por WhatsApp de una OT o una cotización van al teléfono de su
-- sector, si tiene uno; si no, al del cliente, como hasta ahora.
create or replace function public.enqueue_notification(
  p_kind notification_kind,
  p_dedupe_key text,
  p_body text,
  p_customer_id uuid,
  p_work_order_id uuid default null,
  p_quotation_id uuid default null,
  p_media_url text default null,
  p_receipt_value_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_phone text;
  v_sector_phone text;
  v_opt_out boolean;
  v_status notification_status;
  v_error text;
  v_id uuid;
begin
  select phone_e164, whatsapp_opt_out into v_phone, v_opt_out
  from customers where id = p_customer_id;

  select s.phone_e164 into v_sector_phone
  from customer_sectors s
  where s.customer_id = p_customer_id
    and s.id = coalesce(
      (select q.customer_sector_id from quotations q where q.id = p_quotation_id),
      (select w.customer_sector_id from work_orders w where w.id = p_work_order_id)
    );
  v_phone := coalesce(v_sector_phone, v_phone);

  if v_opt_out then
    v_status := 'DESCARTADO';
    v_error := 'El cliente pidió no recibir mensajes.';
  elsif v_phone is null then
    v_status := 'DESCARTADO';
    v_error := 'El cliente no tiene un teléfono válido cargado.';
  else
    v_status := 'PENDIENTE';
  end if;

  insert into notifications (
    kind, status, work_order_id, quotation_id, customer_id,
    to_phone, body, media_url, dedupe_key, last_error, receipt_value_id
  )
  values (
    p_kind, v_status, p_work_order_id, p_quotation_id, p_customer_id,
    v_phone, p_body, p_media_url, p_dedupe_key, v_error, p_receipt_value_id
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- Si a una OT o cotización se le cambia el cliente, el sector del anterior
-- deja de valer: queda en el contacto general del nuevo.
create or replace function public.soltar_sector_de_otro_cliente()
returns trigger
language plpgsql
as $$
begin
  if new.customer_sector_id is not null and not exists (
    select 1 from public.customer_sectors s
    where s.id = new.customer_sector_id and s.customer_id = new.customer_id
  ) then
    new.customer_sector_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists work_orders_soltar_sector on public.work_orders;
create trigger work_orders_soltar_sector
  before insert or update of customer_id, customer_sector_id on public.work_orders
  for each row execute function public.soltar_sector_de_otro_cliente();

drop trigger if exists quotations_soltar_sector on public.quotations;
create trigger quotations_soltar_sector
  before update of customer_id, customer_sector_id on public.quotations
  for each row execute function public.soltar_sector_de_otro_cliente();

drop trigger if exists invoices_soltar_sector on public.invoices;
create trigger invoices_soltar_sector
  before update of customer_sector_id on public.invoices
  for each row execute function public.soltar_sector_de_otro_cliente();

-- El responsable del sector: con quién se habla en Compras, Administración…
alter table public.customer_sectors add column if not exists responsable text;
