CREATE TABLE public.ai_credentials (
  provider text NOT NULL,
  api_key text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

CREATE TABLE public.app_settings (
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.arca_credentials (
  proposito text NOT NULL,
  cuit text NOT NULL,
  cert_pem text NOT NULL,
  key_pem text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

CREATE TABLE public.arca_tickets (
  servicio text NOT NULL,
  token text NOT NULL,
  sign text NOT NULL,
  expira timestamp with time zone NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.article_code_sequences (
  code_prefix text NOT NULL,
  last_number integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.article_components (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  combo_article_id uuid NOT NULL,
  component_article_id uuid NOT NULL,
  quantity integer DEFAULT 1 NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.article_suppliers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  article_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_code text NOT NULL,
  supplier_description text,
  purchase_price numeric DEFAULT 0 NOT NULL,
  is_preferred boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.articles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  code text NOT NULL,
  description text NOT NULL,
  unit_price numeric DEFAULT 0 NOT NULL,
  tracks_stock boolean DEFAULT false NOT NULL,
  stock_quantity numeric DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  markup_percent numeric,
  brand text,
  price_updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.banks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.company_settings (
  id boolean DEFAULT true NOT NULL,
  legal_name text NOT NULL,
  trade_name text,
  tax_id text,
  tax_condition text DEFAULT 'RESPONSABLE_INSCRIPTO'::text NOT NULL,
  sales_point integer DEFAULT 1 NOT NULL,
  gross_income text,
  activity_start_date date,
  address_street text,
  address_city text,
  address_state text,
  address_zip text,
  phone text,
  email text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.customers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  email text,
  phone text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  legal_name text,
  tax_id text,
  tax_condition text DEFAULT 'CONSUMIDOR_FINAL'::text NOT NULL,
  address_street text,
  address_city text,
  address_state text,
  address_zip text,
  notes text,
  active boolean DEFAULT true NOT NULL,
  phone_e164 text,
  whatsapp_opt_out boolean DEFAULT false NOT NULL
);

CREATE TABLE public.employees (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  role text,
  phone text,
  active boolean DEFAULT true NOT NULL,
  profile_id uuid,
  workplace text,
  hourly_cost numeric
);

CREATE TABLE public.expense_concepts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.invoice_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_id uuid NOT NULL,
  article_id uuid,
  code text,
  description text NOT NULL,
  quantity numeric NOT NULL,
  unit_price numeric NOT NULL,
  subtotal numeric NOT NULL,
  line_number integer NOT NULL
);

CREATE TABLE public.invoice_sequences (
  invoice_type invoice_type NOT NULL,
  sales_point integer NOT NULL,
  last_number integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_type invoice_type NOT NULL,
  sales_point integer NOT NULL,
  number integer NOT NULL,
  full_number text DEFAULT ((lpad((sales_point)::text, 4, '0'::text) || '-'::text) || lpad((number)::text, 8, '0'::text)),
  status invoice_status DEFAULT 'EMITIDA'::invoice_status NOT NULL,
  work_order_id uuid,
  customer_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_legal_name text,
  customer_tax_id text,
  customer_tax_condition text NOT NULL,
  customer_address text,
  issuer_legal_name text NOT NULL,
  issuer_tax_id text,
  issuer_tax_condition text NOT NULL,
  issuer_address text,
  issuer_gross_income text,
  issuer_activity_start_date date,
  issue_date date DEFAULT CURRENT_DATE NOT NULL,
  due_date date NOT NULL,
  payment_terms_days integer DEFAULT 7 NOT NULL,
  net_amount numeric(14,2) NOT NULL,
  vat_amount numeric(14,2) NOT NULL,
  total_amount numeric(14,2) NOT NULL,
  paid_amount numeric(14,2) DEFAULT 0 NOT NULL,
  notes text,
  voided_at timestamp with time zone,
  voided_reason text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.notification_templates (
  body text NOT NULL,
  status_id uuid NOT NULL
);

CREATE TABLE public.notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  kind notification_kind NOT NULL,
  status notification_status DEFAULT 'PENDIENTE'::notification_status NOT NULL,
  work_order_id uuid,
  quotation_id uuid,
  customer_id uuid,
  to_phone text,
  body text NOT NULL,
  media_url text,
  attempts integer DEFAULT 0 NOT NULL,
  last_error text,
  dedupe_key text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  sent_at timestamp with time zone,
  receipt_value_id uuid
);

CREATE TABLE public.payment_methods (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  kind payment_method_kind NOT NULL,
  name text NOT NULL,
  bank_name text,
  account_number text,
  cbu text,
  opening_balance numeric(14,2) DEFAULT 0 NOT NULL,
  opening_date date DEFAULT CURRENT_DATE NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.payment_order_allocations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  payment_order_id uuid NOT NULL,
  purchase_invoice_id uuid,
  amount numeric(14,2) NOT NULL,
  provisional_credit_note_id uuid
);

CREATE TABLE public.payment_order_sequence (
  id boolean DEFAULT true NOT NULL,
  last_number integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.payment_order_values (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  payment_order_id uuid NOT NULL,
  kind payment_value_kind NOT NULL,
  amount numeric(14,2) NOT NULL,
  payment_method_id uuid,
  check_id uuid,
  tax_rate_id uuid,
  certificate_number text
);

CREATE TABLE public.payment_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  number integer NOT NULL,
  full_number text NOT NULL,
  status payment_order_status DEFAULT 'REGISTRADA'::payment_order_status NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_name text NOT NULL,
  payment_date date DEFAULT CURRENT_DATE NOT NULL,
  total_amount numeric(14,2) NOT NULL,
  applied_amount numeric(14,2) DEFAULT 0 NOT NULL,
  on_account_amount numeric(14,2) DEFAULT (total_amount - applied_amount),
  notes text,
  treasury_movement_id uuid,
  voided_at timestamp with time zone,
  voided_reason text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.price_imports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  supplier_id uuid NOT NULL,
  file_name text,
  total_rows integer DEFAULT 0 NOT NULL,
  matched_rows integer DEFAULT 0 NOT NULL,
  unmatched_rows integer DEFAULT 0 NOT NULL,
  imported_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.profiles (
  id uuid NOT NULL,
  email text,
  role text DEFAULT 'operario'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  can_view_history boolean DEFAULT true NOT NULL,
  "position" text DEFAULT 'operario'::text NOT NULL,
  must_change_password boolean DEFAULT true NOT NULL
);

CREATE TABLE public.provisional_credit_note_sequence (
  id boolean DEFAULT true NOT NULL,
  last_number integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.provisional_credit_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  number integer NOT NULL,
  full_number text DEFAULT ('NCP-'::text || lpad((number)::text, 8, '0'::text)),
  status provisional_credit_note_status DEFAULT 'PENDIENTE'::provisional_credit_note_status NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_name text NOT NULL,
  description text NOT NULL,
  amount numeric(14,2) NOT NULL,
  settled_amount numeric(14,2) DEFAULT 0 NOT NULL,
  matched_invoice_id uuid,
  matched_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.purchase_invoice_extractions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  kind text NOT NULL,
  supplier_id uuid,
  attachment_storage_path text NOT NULL,
  attachment_mime_type text NOT NULL,
  raw_extraction jsonb,
  status purchase_extraction_status DEFAULT 'EXTRAIDO'::purchase_extraction_status NOT NULL,
  error_message text,
  purchase_invoice_id uuid,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  ai_provider text
);

CREATE TABLE public.purchase_invoice_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  purchase_invoice_id uuid NOT NULL,
  line_number integer NOT NULL,
  article_id uuid,
  concept_id uuid,
  code text,
  description text NOT NULL,
  quantity numeric NOT NULL,
  unit_price numeric NOT NULL,
  discount_percent numeric(5,2) DEFAULT 0 NOT NULL,
  net_amount numeric(14,2) NOT NULL,
  vat_rate_id uuid NOT NULL,
  vat_rate numeric(6,3) NOT NULL,
  vat_treatment text NOT NULL,
  vat_amount numeric(14,2) NOT NULL
);

CREATE TABLE public.purchase_invoice_taxes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  purchase_invoice_id uuid NOT NULL,
  tax_rate_id uuid NOT NULL,
  name text NOT NULL,
  kind tax_kind NOT NULL,
  rate numeric(6,3) NOT NULL,
  base_amount numeric(14,2) NOT NULL,
  amount numeric(14,2) NOT NULL
);

CREATE TABLE public.purchase_invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  kind purchase_kind NOT NULL,
  doc_type purchase_doc_type NOT NULL,
  letter purchase_letter NOT NULL,
  sales_point integer NOT NULL,
  number integer NOT NULL,
  full_number text DEFAULT ((lpad((sales_point)::text, 4, '0'::text) || '-'::text) || lpad((number)::text, 8, '0'::text)),
  status purchase_status DEFAULT 'REGISTRADA'::purchase_status NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_name text NOT NULL,
  supplier_legal_name text,
  supplier_tax_id text,
  supplier_tax_condition text NOT NULL,
  issue_date date NOT NULL,
  received_date date DEFAULT CURRENT_DATE NOT NULL,
  due_date date NOT NULL,
  payment_terms_days integer NOT NULL,
  moves_stock boolean DEFAULT false NOT NULL,
  gross_amount numeric(14,2) NOT NULL,
  line_discount_amount numeric(14,2) DEFAULT 0 NOT NULL,
  general_discount_percent numeric(5,2) DEFAULT 0 NOT NULL,
  general_discount_amount numeric(14,2) DEFAULT 0 NOT NULL,
  net_taxed numeric(14,2) DEFAULT 0 NOT NULL,
  net_exempt numeric(14,2) DEFAULT 0 NOT NULL,
  net_untaxed numeric(14,2) DEFAULT 0 NOT NULL,
  vat_amount numeric(14,2) DEFAULT 0 NOT NULL,
  other_taxes_amount numeric(14,2) DEFAULT 0 NOT NULL,
  total_amount numeric(14,2) NOT NULL,
  settled_amount numeric(14,2) DEFAULT 0 NOT NULL,
  signed_total numeric(14,2) DEFAULT
CASE
    WHEN (doc_type = 'NOTA_CREDITO'::purchase_doc_type) THEN (- total_amount)
    ELSE total_amount
END,
  notes text,
  voided_at timestamp with time zone,
  voided_reason text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.quotation_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  quotation_id uuid NOT NULL,
  article_id uuid,
  code text,
  description text NOT NULL,
  quantity numeric DEFAULT 1 NOT NULL,
  unit_price numeric DEFAULT 0 NOT NULL,
  subtotal numeric DEFAULT 0 NOT NULL
);

CREATE TABLE public.quotations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  number text DEFAULT ('COT-'::text || (nextval('quotation_number_seq'::regclass))::text) NOT NULL,
  status quotation_status DEFAULT 'EMITIDA'::quotation_status NOT NULL,
  customer_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  component text,
  notes text,
  valid_until date,
  work_order_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  public_token uuid DEFAULT gen_random_uuid() NOT NULL,
  decided_at timestamp with time zone,
  decided_by_client boolean DEFAULT false NOT NULL,
  rejection_reason text
);

CREATE TABLE public.receipt_allocations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  receipt_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL
);

CREATE TABLE public.receipt_changes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  receipt_id uuid NOT NULL,
  kind receipt_change_kind NOT NULL,
  amount numeric(14,2) NOT NULL,
  payment_method_id uuid,
  treasury_movement_id uuid,
  note text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  check_id uuid
);

CREATE TABLE public.receipt_sequence (
  id boolean DEFAULT true NOT NULL,
  last_number integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.receipt_values (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  receipt_id uuid NOT NULL,
  kind receipt_value_kind NOT NULL,
  amount numeric(14,2) NOT NULL,
  payment_method_id uuid,
  check_id uuid,
  tax_rate_id uuid,
  certificate_number text
);

CREATE TABLE public.receipts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  number integer NOT NULL,
  full_number text NOT NULL,
  status receipt_status DEFAULT 'REGISTRADO'::receipt_status NOT NULL,
  customer_id uuid NOT NULL,
  customer_name text NOT NULL,
  receipt_date date DEFAULT CURRENT_DATE NOT NULL,
  total_amount numeric(14,2) NOT NULL,
  applied_amount numeric(14,2) DEFAULT 0 NOT NULL,
  on_account_amount numeric(14,2) DEFAULT (total_amount - applied_amount),
  notes text,
  treasury_movement_id uuid,
  voided_at timestamp with time zone,
  voided_reason text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.remito_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  remito_id uuid NOT NULL,
  code text,
  description text NOT NULL,
  quantity numeric NOT NULL,
  line_number integer NOT NULL,
  article_id uuid
);

CREATE TABLE public.remito_sequences (
  sales_point integer NOT NULL,
  last_number integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.remitos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  sales_point integer NOT NULL,
  number integer NOT NULL,
  full_number text DEFAULT ((lpad((sales_point)::text, 4, '0'::text) || '-'::text) || lpad((number)::text, 8, '0'::text)),
  status text DEFAULT 'EMITIDO'::text NOT NULL,
  invoice_id uuid,
  customer_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_legal_name text,
  customer_tax_id text,
  customer_address text,
  issue_date date DEFAULT CURRENT_DATE NOT NULL,
  notes text,
  voided_at timestamp with time zone,
  voided_reason text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.supplier_import_profiles (
  supplier_id uuid NOT NULL,
  code_column integer NOT NULL,
  description_column integer,
  brand_column integer,
  price_column integer NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.suppliers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  legal_name text,
  tax_id text,
  tax_condition text DEFAULT 'RESPONSABLE_INSCRIPTO'::text NOT NULL,
  email text,
  phone text,
  address_street text,
  address_city text,
  address_state text,
  address_zip text,
  notes text,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  payment_terms_days integer DEFAULT 30 NOT NULL,
  code_prefix text
);

CREATE TABLE public.tax_rates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  kind tax_kind NOT NULL,
  name text NOT NULL,
  rate numeric(6,3) NOT NULL,
  base tax_base DEFAULT 'NETO'::tax_base NOT NULL,
  jurisdiction text,
  vat_treatment text,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.third_party_checks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  number text NOT NULL,
  bank_name text NOT NULL,
  drawer text,
  issue_date date,
  due_date date NOT NULL,
  amount numeric(14,2) NOT NULL,
  status check_status DEFAULT 'EN_CARTERA'::check_status NOT NULL,
  received_movement_id uuid,
  deposited_to_id uuid,
  deposited_at date,
  endorsed_to_supplier_id uuid,
  rejected_reason text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  endorsed_to_customer_id uuid
);

CREATE TABLE public.treasury_movement_legs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  movement_id uuid NOT NULL,
  payment_method_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL
);

CREATE TABLE public.treasury_movements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  movement_type treasury_movement_type NOT NULL,
  number integer NOT NULL,
  full_number text NOT NULL,
  status treasury_status DEFAULT 'REGISTRADO'::treasury_status NOT NULL,
  movement_date date DEFAULT CURRENT_DATE NOT NULL,
  concept_id uuid,
  description text NOT NULL,
  payee text,
  amount numeric(14,2) NOT NULL,
  notes text,
  voided_at timestamp with time zone,
  voided_reason text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.treasury_sequences (
  movement_type treasury_movement_type NOT NULL,
  last_number integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.vehicle_brands (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_intake_parts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  intake_id uuid NOT NULL,
  name text NOT NULL,
  serial_number text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_intake_photos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  intake_id uuid NOT NULL,
  storage_path text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_intakes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  number text DEFAULT ('ING-'::text || (nextval('vehicle_intake_number_seq'::regclass))::text) NOT NULL,
  status vehicle_intake_status DEFAULT 'PENDIENTE'::vehicle_intake_status NOT NULL,
  customer_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  observations text,
  quotation_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_models (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  brand_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  size_class text
);

CREATE TABLE public.vehicle_part_types (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_parts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  vehicle_id uuid NOT NULL,
  part_type text NOT NULL,
  brand text,
  model text,
  reference_number text,
  quantity integer DEFAULT 1 NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicle_photos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  vehicle_id uuid NOT NULL,
  storage_path text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vehicles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  model text NOT NULL,
  license_plate text,
  year integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  brand text,
  vehicle_type text DEFAULT 'CAMION'::text NOT NULL,
  vin text,
  engine_brand text,
  engine_model text,
  engine_number text,
  injection_system text,
  odometer numeric,
  odometer_unit text DEFAULT 'KM'::text NOT NULL,
  notes text,
  active boolean DEFAULT true NOT NULL,
  size_class text DEFAULT 'MEDIANO'::text NOT NULL,
  kind text DEFAULT 'VEHICULO'::text NOT NULL,
  reference_number text,
  has_injectors boolean,
  injector_count integer
);

CREATE TABLE public.work_order_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  code text,
  description text NOT NULL,
  quantity numeric DEFAULT 1 NOT NULL,
  unit_price numeric DEFAULT 0 NOT NULL,
  subtotal numeric DEFAULT 0 NOT NULL,
  article_id uuid,
  unit_cost numeric
);

CREATE TABLE public.work_order_photos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  storage_path text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.work_order_received_parts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  name text NOT NULL,
  serial_number text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.work_order_stage_assignments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  employee_id uuid,
  status_id uuid NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  ended_at timestamp with time zone
);

CREATE TABLE public.work_order_status_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  work_order_id uuid NOT NULL,
  changed_by uuid,
  changed_by_email text,
  changed_at timestamp with time zone DEFAULT now() NOT NULL,
  from_status_id uuid,
  to_status_id uuid NOT NULL
);

CREATE TABLE public.work_order_statuses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  label text NOT NULL,
  client_description text DEFAULT ''::text NOT NULL,
  color text DEFAULT '#9a9a9a'::text NOT NULL,
  sort_order integer NOT NULL,
  active boolean DEFAULT true NOT NULL,
  is_initial boolean DEFAULT false NOT NULL,
  is_terminal boolean DEFAULT false NOT NULL,
  notifies_client boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  frees_yard boolean DEFAULT false NOT NULL,
  system_key text
);

CREATE TABLE public.work_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  number text DEFAULT ('OT-'::text || (nextval('work_order_number_seq'::regclass))::text) NOT NULL,
  customer_id uuid NOT NULL,
  vehicle_id uuid,
  employee_id uuid,
  component text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  quotation_id uuid,
  public_token uuid DEFAULT gen_random_uuid() NOT NULL,
  status_id uuid NOT NULL,
  price_auth_status text,
  price_auth_requested_total numeric,
  price_auth_requested_at timestamp with time zone,
  price_auth_decided_at timestamp with time zone,
  price_auth_reason text,
  estimated_delivery_date date,
  reception_kind text DEFAULT 'VEHICULO'::text NOT NULL,
  observations text
);

CREATE TABLE public.workplace_capacity (
  workplace text NOT NULL,
  capacity integer DEFAULT 1 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.yard_reservations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  vehicle_id uuid,
  license_plate text NOT NULL,
  size_class text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid DEFAULT auth.uid()
);
