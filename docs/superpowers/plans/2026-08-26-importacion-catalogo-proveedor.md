# Importación de catálogo de proveedor — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extender "Listas de precios" para importar el Excel tal como lo manda cada proveedor (mapeo de columnas guardado por proveedor) y dar de alta automáticamente los artículos cuyo código no tiene sinónimo todavía, con código secuencial propio, marca y precio.

**Architecture:** Mismo módulo existente (`PriceLists.tsx` / `priceLists.ts` / `article_suppliers`), sin sistema paralelo. Se agregan dos tablas chicas (`supplier_import_profiles` para el mapeo, `article_code_sequences` para la numeración por prefijo) y dos columnas (`suppliers.code_prefix`, `articles.brand`). El parseo de Excel deja de adivinar columnas por nombre de encabezado y pasa a aplicar índices de columna elegidos a mano una vez por proveedor. La cola manual de códigos sin vincular (`unmatched_supplier_prices`, vacía en producción) se elimina.

**Tech Stack:** React 19 + TypeScript + Vite, Supabase Postgres (RPC `plpgsql`), SheetJS (`xlsx`) ya instalado. Sin framework de tests en el repo — la verificación de cada tarea es `npx tsc --noEmit`, `npm run build`, y para el backend, consultas SQL directas contra la base viva vía MCP de Supabase (mismo método usado en todo el proyecto).

**Spec:** [docs/superpowers/specs/2026-08-26-importacion-catalogo-proveedor-design.md](../specs/2026-08-26-importacion-catalogo-proveedor-design.md)

## Global Constraints

- Proyecto id de Supabase: `mnoqdqjhsylohlvuekfh` ("Ludiesel"). Todas las migraciones se aplican con `mcp__plugin_supabase_supabase__apply_migration` y además quedan como archivo `.sql` documentado en `supabase/`, igual que el resto del repo.
- Numeración de documentos: tabla de secuencia propia (`last_number int`, tomada con `for update` / `insert ... on conflict do update` dentro de la misma transacción), nunca `sequence` nativa de Postgres — mismo patrón que `invoice_sequences`.
- Guardas viven en la base, no solo en la pantalla: cualquier validación de negocio (prefijo obligatorio, columnas mapeadas, etc.) tiene que sobrevivir aunque alguien llame la RPC directo con la anon key.
- Funciones que escriben una tabla de secuencia sin política de escritura (`article_code_sequences`, igual que `invoice_sequences`) tienen que ser `security definer`, y deben seguir revisando `is_admin()` como primera línea.
- Sin test runner en el repo (`package.json` no tiene `jest`/`vitest`). Cada tarea se verifica con `npx tsc --noEmit`, y las que tocan UI además con `npm run build`. Las tareas de base se verifican con `select` contra la base viva.
- Estilo de commit: mensaje corto explicando el *por qué*, en español, sin `--no-verify`. Push con el workaround ya documentado: `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git push origin main` en background, confirmado con `git ls-remote origin main` contra `git rev-parse --short main`.
- No se introduce ningún framework de tests nuevo: sería una decisión de alcance mayor a esta feature y no la pidió el spec.

---

## File Structure

```
supabase/
  supplier-catalog-import.sql          (nuevo) — migración completa de esta feature

src/lib/
  suppliers.ts                          (modificar) — code_prefix
  articles.ts                           (modificar) — brand
  priceLists.ts                         (modificar) — ColumnMapping, perfil guardado, alta automática
  excelImport.ts                        (reescribir) — grilla cruda + parseo por mapeo, sin heurística de encabezado

src/components/
  SupplierColumnMapper.tsx              (nuevo) — grilla de columnas + 4 desplegables de mapeo

src/pages/
  Suppliers.tsx                         (modificar) — campo Prefijo en el ABM
  Inventory.tsx                         (modificar) — campo Marca en el ABM
  PriceLists.tsx                        (reescribir) — flujo de importación con mapeo, sin cola manual
```

---

### Task 1: Migración de base — prefijo, marca, mapeo guardado, alta automática

**Files:**
- Create: `supabase/supplier-catalog-import.sql`

**Interfaces:**
- Produces: columna `suppliers.code_prefix text` (2 chars, único, normalizado a mayúsculas); columna `articles.brand text`; tabla `supplier_import_profiles(supplier_id pk, code_column int, description_column int null, brand_column int null, price_column int)`; tabla `article_code_sequences(code_prefix pk, last_number int)`; RPC `import_supplier_prices(p_supplier_id uuid, p_file_name text, p_rows jsonb) returns table(total_rows int, matched_rows int, unmatched_rows int, import_id uuid)` — misma firma que hoy, ahora con alta automática y `security definer`.

- [ ] **Step 1: Confirmar que la cola manual sigue vacía antes de borrarla**

Run (vía MCP `execute_sql`, project `mnoqdqjhsylohlvuekfh`):

```sql
select count(*) from unmatched_supplier_prices;
```

Expected: `0`. Si diera más de 0, PARAR y avisar — hay datos reales para decidir qué hacer antes de borrar la tabla (no asumido en este plan).

- [ ] **Step 2: Escribir la migración completa**

Crear `supabase/supplier-catalog-import.sql`:

```sql
-- DieselPro ERP — Importación de catálogo de proveedor
--
-- Implementa docs/superpowers/specs/2026-08-26-importacion-catalogo-proveedor-design.md.
-- Se aplica directo contra Supabase (Ludiesel) vía MCP; este archivo queda
-- como registro del esquema.

-- ===========================================================================
-- Prefijo de código por proveedor
-- ===========================================================================

alter table suppliers add column code_prefix text;

alter table suppliers
  add constraint suppliers_code_prefix_length check (code_prefix is null or length(code_prefix) = 2);

-- Uppercase y trim antes de guardar: "de" y "DE" no pueden ser dos prefijos
-- distintos, porque después se usan tal cual para armar el código del artículo.
create or replace function public.normalize_supplier_code_prefix()
returns trigger
language plpgsql
as $$
begin
  new.code_prefix := nullif(upper(trim(new.code_prefix)), '');
  return new;
end;
$$;

create trigger suppliers_normalize_code_prefix
before insert or update of code_prefix on suppliers
for each row execute function public.normalize_supplier_code_prefix();

alter table suppliers add constraint suppliers_code_prefix_key unique (code_prefix);

-- ===========================================================================
-- Marca en artículos
-- ===========================================================================

alter table articles add column brand text;

-- ===========================================================================
-- Mapeo de columnas guardado por proveedor
-- ===========================================================================
-- Índices de columna 0-based (0 = columna A del Excel). Sin "fila de inicio
-- de datos": una fila de título o separadora no tiene a la vez código y
-- precio numérico válido en las columnas mapeadas, así que cae sola en el
-- mismo descarte que ya existe para esos casos.

create table supplier_import_profiles (
  supplier_id uuid primary key references suppliers(id) on delete cascade,
  code_column int not null,
  description_column int,
  brand_column int,
  price_column int not null,
  updated_at timestamptz not null default now()
);

alter table supplier_import_profiles enable row level security;
create policy "admin select" on supplier_import_profiles for select to authenticated using (is_admin());
create policy "admin insert" on supplier_import_profiles for insert to authenticated with check (is_admin());
create policy "admin update" on supplier_import_profiles for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin delete" on supplier_import_profiles for delete to authenticated using (is_admin());

-- ===========================================================================
-- Secuencia de código de artículo, por prefijo de proveedor
-- ===========================================================================

create table article_code_sequences (
  code_prefix text primary key,
  last_number int not null default 0 check (last_number >= 0)
);

alter table article_code_sequences enable row level security;
create policy "solo admin" on article_code_sequences for select to authenticated using (is_admin());
-- Sin políticas de escritura: solo la escribe import_supplier_prices, que es security definer.

-- ===========================================================================
-- Se elimina la cola manual de códigos sin vincular
-- ===========================================================================
-- Vacía en producción al momento de este cambio (verificado antes de
-- aplicar esta migración) — no hay datos que migrar.

drop function if exists public.link_unmatched_price(uuid, uuid);
drop table if exists unmatched_supplier_prices;

-- ===========================================================================
-- import_supplier_prices: alta automática en vez de cola manual
-- ===========================================================================
-- Pasa a ser security definer porque ahora escribe article_code_sequences,
-- que no tiene política de escritura (mismo motivo que invoice_sequences).
-- Sigue revisando is_admin() como primera línea, igual que antes.

create or replace function public.import_supplier_prices(p_supplier_id uuid, p_file_name text, p_rows jsonb)
returns table(total_rows int, matched_rows int, unmatched_rows int, import_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_total int := 0;
  v_matched int := 0;
  v_created int := 0;
  v_import_id uuid;
  v_prefix text;
  v_supplier_name text;
  v_markup numeric;
  r record;
  v_article_id uuid;
  v_number int;
  v_code text;
  v_description text;
  v_unit_price numeric;
begin
  if not public.is_admin() then
    raise exception 'No autorizado: se requiere rol admin.';
  end if;

  select code_prefix, name into v_prefix, v_supplier_name
  from suppliers where id = p_supplier_id;

  if not found then
    raise exception 'El proveedor indicado no existe.';
  end if;
  if v_prefix is null then
    raise exception 'Este proveedor no tiene prefijo de código configurado. Definilo en Proveedores antes de importar.';
  end if;

  select coalesce((value)::numeric, 0) into v_markup
  from app_settings where key = 'default_markup_percent';

  for r in
    select
      trim(item->>'code') as code,
      nullif(trim(coalesce(item->>'description', '')), '') as description,
      nullif(trim(coalesce(item->>'brand', '')), '') as brand,
      (item->>'price')::numeric as price
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as item
    where trim(coalesce(item->>'code', '')) <> ''
  loop
    v_total := v_total + 1;

    update article_suppliers
       set purchase_price = r.price,
           supplier_description = coalesce(r.description, supplier_description)
     where supplier_id = p_supplier_id
       and upper(supplier_code) = upper(r.code);

    if found then
      v_matched := v_matched + 1;
    else
      insert into article_code_sequences (code_prefix, last_number)
      values (v_prefix, 1)
      on conflict (code_prefix) do update
        set last_number = article_code_sequences.last_number + 1
      returning last_number into v_number;

      v_code := v_prefix || '-' || lpad(v_number::text, 8, '0');
      v_description := coalesce(r.description, 'Sin descripción — importado de ' || v_supplier_name);
      v_unit_price := round(r.price * (1 + v_markup / 100), 2);

      insert into articles (code, description, brand, unit_price, tracks_stock, stock_quantity, active)
      values (v_code, v_description, r.brand, v_unit_price, false, 0, true)
      returning id into v_article_id;

      insert into article_suppliers (article_id, supplier_id, supplier_code, supplier_description, purchase_price, is_preferred)
      values (v_article_id, p_supplier_id, r.code, r.description, r.price, true);

      v_created := v_created + 1;
    end if;
  end loop;

  insert into price_imports (supplier_id, file_name, total_rows, matched_rows, unmatched_rows)
  values (p_supplier_id, p_file_name, v_total, v_matched, v_created)
  returning id into v_import_id;

  return query select v_total, v_matched, v_created, v_import_id;
end;
$function$;

comment on column price_imports.unmatched_rows is
  'Antes: códigos sin vincular en la cola manual (eliminada). Ahora: artículos creados automáticamente durante la importación. Ver supplier-catalog-import.sql.';
```

- [ ] **Step 2: Aplicar la migración**

Vía MCP `mcp__plugin_supabase_supabase__apply_migration`, `project_id: mnoqdqjhsylohlvuekfh`, `name: supplier_catalog_import`, con el contenido completo de arriba como `query`.

- [ ] **Step 3: Verificar el esquema resultante**

Run:

```sql
select table_name, column_name, data_type
from information_schema.columns
where (table_name = 'suppliers' and column_name = 'code_prefix')
   or (table_name = 'articles' and column_name = 'brand')
order by table_name;
```

Expected: dos filas, `suppliers.code_prefix` (text) y `articles.brand` (text).

```sql
select conname from pg_constraint where conname in ('suppliers_code_prefix_key', 'suppliers_code_prefix_length');
```

Expected: las dos filas presentes.

```sql
select to_regclass('public.supplier_import_profiles') as t1, to_regclass('public.article_code_sequences') as t2, to_regclass('public.unmatched_supplier_prices') as gone;
```

Expected: `t1` y `t2` no nulos, `gone` es `null`.

```sql
select pg_get_functiondef('public.import_supplier_prices(uuid, text, jsonb)'::regprocedure) as def;
```

Expected: el `def` incluye `SECURITY DEFINER` y `article_code_sequences`.

- [ ] **Step 4: Commit**

```bash
git add supabase/supplier-catalog-import.sql
git commit -m "$(cat <<'EOF'
Importación de catálogo: prefijo por proveedor, marca, mapeo guardado

Base para importar el Excel tal como lo manda cada proveedor y dar de
alta artículos nuevos automáticamente en vez de la cola manual (vacía
en producción). Aplicado directo en Supabase vía MCP.
EOF
)"
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git push origin main
```

Confirmar con `git ls-remote origin main` contra `git rev-parse --short main`.

---

### Task 2: Prefijo de proveedor en el ABM

**Files:**
- Modify: `src/lib/suppliers.ts`
- Modify: `src/pages/Suppliers.tsx:206-211,266-288`

**Interfaces:**
- Consumes: tabla `suppliers.code_prefix` (Task 1).
- Produces: `Supplier.codePrefix: string | null`, `SupplierInput.codePrefix: string | null` — los consume Task 4 (`PriceLists.tsx` lee `supplier.codePrefix` para bloquear la importación si falta).

- [ ] **Step 1: Agregar `codePrefix` al modelo de proveedor**

En `src/lib/suppliers.ts`, reemplazar:

```ts
export interface Supplier extends FiscalEntity {
  articles: SupplierArticle[];
  /** Plazo de pago en dias. Propone el vencimiento al cargar una compra. 0 = contado. */
  paymentTermsDays: number;
}
```

por:

```ts
export interface Supplier extends FiscalEntity {
  articles: SupplierArticle[];
  /** Plazo de pago en dias. Propone el vencimiento al cargar una compra. 0 = contado. */
  paymentTermsDays: number;
  /** Prefijo de 2 letras para los artículos que se dan de alta solos al importar su lista. */
  codePrefix: string | null;
}
```

Reemplazar:

```ts
export interface SupplierInput extends FiscalEntityInput {
  paymentTermsDays: number;
}
```

por:

```ts
export interface SupplierInput extends FiscalEntityInput {
  paymentTermsDays: number;
  codePrefix: string | null;
}
```

Reemplazar:

```ts
function mapSupplier(row: any): Supplier {
  return {
    ...mapFiscalEntity(row),
    paymentTermsDays: Number(row.payment_terms_days ?? 30),
    articles: (row.links ?? []).map((link: any) => ({
```

por:

```ts
function mapSupplier(row: any): Supplier {
  return {
    ...mapFiscalEntity(row),
    paymentTermsDays: Number(row.payment_terms_days ?? 30),
    codePrefix: row.code_prefix ?? null,
    articles: (row.links ?? []).map((link: any) => ({
```

Reemplazar:

```ts
function toRow(input: SupplierInput) {
  return {
    ...fiscalEntityToRow(input),
    payment_terms_days: input.paymentTermsDays,
  };
}
```

por:

```ts
function toRow(input: SupplierInput) {
  return {
    ...fiscalEntityToRow(input),
    payment_terms_days: input.paymentTermsDays,
    code_prefix: input.codePrefix,
  };
}
```

Reemplazar:

```ts
export function describeSupplierError(message: string): string {
  if (message.includes('suppliers_tax_id_key') || message.includes('duplicate key')) {
    return 'Ya existe otro proveedor con ese CUIT/CUIL.';
  }
  return message;
}
```

por (el chequeo de `code_prefix` va antes del genérico `duplicate key`, si no ese lo intercepta primero y muestra el mensaje equivocado):

```ts
export function describeSupplierError(message: string): string {
  if (message.includes('suppliers_code_prefix_key')) {
    return 'Ya existe otro proveedor con ese prefijo de código.';
  }
  if (message.includes('suppliers_code_prefix_length')) {
    return 'El prefijo de código tiene que tener exactamente 2 caracteres.';
  }
  if (message.includes('suppliers_tax_id_key') || message.includes('duplicate key')) {
    return 'Ya existe otro proveedor con ese CUIT/CUIL.';
  }
  return message;
}
```

- [ ] **Step 2: Agregar el campo al formulario**

En `src/pages/Suppliers.tsx`, reemplazar la inicialización del form (líneas 206-211):

```tsx
  const [form, setForm] = React.useState<SupplierInput>(
    supplier
      ? { ...fiscalEntityToForm(supplier), paymentTermsDays: supplier.paymentTermsDays }
      // Un proveedor normalmente factura, así que por defecto es Resp. Inscripto.
      : { ...EMPTY_FISCAL_FORM, taxCondition: 'RESPONSABLE_INSCRIPTO', paymentTermsDays: 30 }
  );
```

por:

```tsx
  const [form, setForm] = React.useState<SupplierInput>(
    supplier
      ? {
          ...fiscalEntityToForm(supplier),
          paymentTermsDays: supplier.paymentTermsDays,
          codePrefix: supplier.codePrefix,
        }
      // Un proveedor normalmente factura, así que por defecto es Resp. Inscripto.
      : { ...EMPTY_FISCAL_FORM, taxCondition: 'RESPONSABLE_INSCRIPTO', paymentTermsDays: 30, codePrefix: null }
  );
```

Reemplazar el bloque "Condiciones comerciales" (líneas 266-288):

```tsx
          {/* Condiciones comerciales: de acá sale el vencimiento que se
              propone al cargar una factura de compra de este proveedor. */}
          <div className="space-y-3 border-t border-line pt-4">
            <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-accent-deep">
              <CalendarClock size={14} /> Condiciones comerciales
            </h3>
            <label className="block text-xs font-bold uppercase tracking-wider text-text-soft sm:w-1/2">
              Plazo de pago (días)
              <input
                type="number"
                min="0"
                max="365"
                value={form.paymentTermsDays}
                onChange={(e) => patch({ paymentTermsDays: Number(e.target.value) })}
                className="mt-1 w-full border border-line bg-panel px-3 py-2 font-mono text-sm normal-case focus:border-accent-deep focus:outline-none"
              />
              <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                {form.paymentTermsDays === 0
                  ? 'Contado: la factura vence el mismo día que se emite.'
                  : `Las facturas de este proveedor van a proponer vencimiento a ${form.paymentTermsDays} días.`}
              </span>
            </label>
          </div>
```

por:

```tsx
          {/* Condiciones comerciales: de acá sale el vencimiento que se
              propone al cargar una factura de compra, y el prefijo con el
              que se numeran los artículos que se dan de alta solos al
              importar la lista de precios de este proveedor. */}
          <div className="space-y-3 border-t border-line pt-4">
            <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-accent-deep">
              <CalendarClock size={14} /> Condiciones comerciales
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
                Plazo de pago (días)
                <input
                  type="number"
                  min="0"
                  max="365"
                  value={form.paymentTermsDays}
                  onChange={(e) => patch({ paymentTermsDays: Number(e.target.value) })}
                  className="mt-1 w-full border border-line bg-panel px-3 py-2 font-mono text-sm normal-case focus:border-accent-deep focus:outline-none"
                />
                <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                  {form.paymentTermsDays === 0
                    ? 'Contado: la factura vence el mismo día que se emite.'
                    : `Las facturas de este proveedor van a proponer vencimiento a ${form.paymentTermsDays} días.`}
                </span>
              </label>
              <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
                Prefijo de código
                <input
                  value={form.codePrefix ?? ''}
                  onChange={(e) => patch({ codePrefix: e.target.value.toUpperCase().slice(0, 2) || null })}
                  maxLength={2}
                  className="mt-1 w-full border border-line bg-panel px-3 py-2 font-mono text-sm uppercase normal-case focus:border-accent-deep focus:outline-none"
                  placeholder="DE"
                />
                <span className="mt-1 block text-[10px] font-normal normal-case text-text-soft">
                  {form.codePrefix
                    ? `Los artículos nuevos de este proveedor van a llevar el código ${form.codePrefix}-00000001, ${form.codePrefix}-00000002...`
                    : 'Sin prefijo no se puede importar el catálogo de este proveedor.'}
                </span>
              </label>
            </div>
          </div>
```

- [ ] **Step 3: Verificar que compila**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 4: Prueba manual**

`npm run dev`, entrar a Proveedores, editar uno existente, cargar prefijo "DE", guardar. Confirmar que aparece en el listado al reabrir el proveedor. Probar cargar un prefijo repetido en otro proveedor y confirmar que aparece "Ya existe otro proveedor con ese prefijo de código."

- [ ] **Step 5: Commit**

```bash
git add src/lib/suppliers.ts src/pages/Suppliers.tsx
git commit -m "$(cat <<'EOF'
Proveedores: prefijo de código para artículos importados

Cada proveedor define un prefijo de 2 letras. Es la base para que los
artículos que se den de alta automáticamente al importar su lista de
precios queden numerados como <PREFIJO>-00000001, sin chocar entre
proveedores (prefijo único).
EOF
)"
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git push origin main
```

Confirmar con `git ls-remote origin main` contra `git rev-parse --short main`.

---

### Task 3: Marca en el ABM de artículos

**Files:**
- Modify: `src/lib/articles.ts`
- Modify: `src/pages/Inventory.tsx:29-37,161-172,264-276,340-349`

**Interfaces:**
- Consumes: columna `articles.brand` (Task 1).
- Produces: `Article.brand: string | null`, `ArticleInput.brand: string | null` — los consume Task 4 (los artículos creados por importación llenan este campo).

- [ ] **Step 1: Agregar `brand` al modelo de artículo**

En `src/lib/articles.ts`, reemplazar:

```ts
export interface Article {
  id: string;
  code: string;
  description: string;
  /** Precio de VENTA neto. Lo calcula la base: compra del preferido + utilidad. */
  unitPrice: number;
```

por:

```ts
export interface Article {
  id: string;
  code: string;
  description: string;
  /** Marca del fabricante (DENSO, BOSCH...). No es el proveedor: es de quién es la pieza. */
  brand: string | null;
  /** Precio de VENTA neto. Lo calcula la base: compra del preferido + utilidad. */
  unitPrice: number;
```

Reemplazar:

```ts
export interface ArticleInput {
  code: string;
  description: string;
  tracksStock: boolean;
```

por:

```ts
export interface ArticleInput {
  code: string;
  description: string;
  brand: string | null;
  tracksStock: boolean;
```

Reemplazar:

```ts
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    unitPrice: Number(row.unit_price),
```

por:

```ts
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    brand: row.brand ?? null,
    unitPrice: Number(row.unit_price),
```

Reemplazar:

```ts
function toRow(input: ArticleInput) {
  return {
    code: input.code,
    description: input.description,
    tracks_stock: input.tracksStock,
```

por:

```ts
function toRow(input: ArticleInput) {
  return {
    code: input.code,
    description: input.description,
    brand: input.brand,
    tracks_stock: input.tracksStock,
```

- [ ] **Step 2: Agregar el campo a la lista y al formulario**

En `src/pages/Inventory.tsx`, reemplazar `EMPTY_FORM`:

```tsx
const EMPTY_FORM: ArticleInput = {
  code: '',
  description: '',
  tracksStock: false,
  stockQuantity: 0,
  active: true,
  markupPercent: null,
  unitPrice: 0,
};
```

por:

```tsx
const EMPTY_FORM: ArticleInput = {
  code: '',
  description: '',
  brand: null,
  tracksStock: false,
  stockQuantity: 0,
  active: true,
  markupPercent: null,
  unitPrice: 0,
};
```

Reemplazar la fila de la tabla (líneas 166-172):

```tsx
                  <td data-primary className="p-3 font-semibold">{article.code}</td>
                  <td data-label="Descripción" className="p-3">
                    {article.description}
                    {!article.active && (
                      <span className="ml-2 text-[9px] font-bold uppercase tracking-wider text-text-faint">Inactivo</span>
                    )}
                  </td>
```

por:

```tsx
                  <td data-primary className="p-3 font-semibold">{article.code}</td>
                  <td data-label="Descripción" className="p-3">
                    {article.description}
                    {article.brand && (
                      <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-text-soft">{article.brand}</span>
                    )}
                    {!article.active && (
                      <span className="ml-2 text-[9px] font-bold uppercase tracking-wider text-text-faint">Inactivo</span>
                    )}
                  </td>
```

Reemplazar la inicialización del form del modal (líneas 264-276):

```tsx
  const [form, setForm] = React.useState<ArticleInput>(
    article
      ? {
          code: article.code,
          description: article.description,
          tracksStock: article.tracksStock,
          stockQuantity: article.stockQuantity,
          active: article.active,
          markupPercent: article.markupPercent,
          unitPrice: article.unitPrice,
        }
      : EMPTY_FORM
  );
```

por:

```tsx
  const [form, setForm] = React.useState<ArticleInput>(
    article
      ? {
          code: article.code,
          description: article.description,
          brand: article.brand,
          tracksStock: article.tracksStock,
          stockQuantity: article.stockQuantity,
          active: article.active,
          markupPercent: article.markupPercent,
          unitPrice: article.unitPrice,
        }
      : EMPTY_FORM
  );
```

Reemplazar el grid de identificación (líneas 340-349):

```tsx
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
            <label className={cn(labelClass, 'col-span-2')}>
              Nuestro código
              <input value={form.code} onChange={(e) => patch({ code: e.target.value })} className={cn(inputClass, 'font-mono')} placeholder="BOS-093" />
            </label>
            <label className={cn(labelClass, 'col-span-4')}>
              Descripción
              <input value={form.description} onChange={(e) => patch({ description: e.target.value })} className={inputClass} placeholder="Tobera Inyector Common Rail" />
            </label>
          </div>
```

por:

```tsx
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
            <label className={cn(labelClass, 'col-span-2')}>
              Nuestro código
              <input value={form.code} onChange={(e) => patch({ code: e.target.value })} className={cn(inputClass, 'font-mono')} placeholder="BOS-093" />
            </label>
            <label className={cn(labelClass, 'col-span-2')}>
              Descripción
              <input value={form.description} onChange={(e) => patch({ description: e.target.value })} className={inputClass} placeholder="Tobera Inyector Common Rail" />
            </label>
            <label className={cn(labelClass, 'col-span-2')}>
              Marca
              <input
                value={form.brand ?? ''}
                onChange={(e) => patch({ brand: e.target.value.trim() === '' ? null : e.target.value })}
                className={inputClass}
                placeholder="DENSO"
              />
            </label>
          </div>
```

- [ ] **Step 3: Verificar que compila**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 4: Prueba manual**

`npm run dev`, crear o editar un artículo, cargar marca "DENSO", guardar. Confirmar que se ve como etiqueta junto a la descripción en el listado.

- [ ] **Step 5: Commit**

```bash
git add src/lib/articles.ts src/pages/Inventory.tsx
git commit -m "$(cat <<'EOF'
Artículos: campo marca

Se agrega para poder capturar la marca del fabricante al cargar un
artículo a mano o al crearse automáticamente desde la importación de
catálogo de un proveedor.
EOF
)"
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git push origin main
```

Confirmar con `git ls-remote origin main` contra `git rev-parse --short main`.

---

### Task 4: Flujo de importación con mapeo por columnas y alta automática

Esta tarea reescribe en conjunto `excelImport.ts`, `priceLists.ts`, el componente nuevo `SupplierColumnMapper.tsx` y `PriceLists.tsx`. No se puede dividir en tareas más chicas sin dejar el proyecto sin compilar a mitad de camino: `SupplierColumnMapper` depende de tipos que agrega `priceLists.ts`, y `PriceLists.tsx` depende de los tres.

**Files:**
- Modify: `src/lib/excelImport.ts` (reescribir completo)
- Modify: `src/lib/priceLists.ts`
- Create: `src/components/SupplierColumnMapper.tsx`
- Modify: `src/pages/PriceLists.tsx` (reescribir completo)

**Interfaces:**
- Consumes: `Supplier.codePrefix` (Task 2), `Article`/`ArticleInput.brand` (Task 3, no se usa acá directamente pero comparte `ImportRow.brand`), tablas `supplier_import_profiles` / `article_code_sequences` y la RPC `import_supplier_prices` (Task 1).
- Produces: `excelImport.ts` exporta `columnLetter(index): string`, `parsePrice(value): number | null`, `ExcelFormatError`, `previewSheet(file, maxRows?): Promise<RawGrid>`, `parseWithMapping(file, mapping): Promise<ParsedSheet>`, tipo `RawGrid = { sheetName: string; rows: string[][]; columnCount: number }`. `priceLists.ts` exporta el tipo `ColumnMapping = { codeColumn: number; priceColumn: number; descriptionColumn: number | null; brandColumn: number | null }`, `ImportRow` con `brand: string | null`, `fetchSupplierImportProfile(supplierId): Promise<ColumnMapping | null>`, `saveSupplierImportProfile(supplierId, mapping): Promise<void>`, y `PriceImport`/`ImportResult` con `createdRows` en vez de `unmatchedRows`.

- [ ] **Step 1: Reescribir `src/lib/excelImport.ts`**

Reemplazar el archivo completo por:

```ts
import * as XLSX from 'xlsx';
import type { ColumnMapping, ImportRow } from '@/src/lib/priceLists';

export interface ParsedSheet {
  rows: ImportRow[];
  /** Filas descartadas con el motivo, para mostrárselas al usuario. */
  skipped: { row: number; reason: string }[];
  sheetName: string;
}

/** Primeras filas del archivo, como texto, para elegir a mano qué columna es cada dato. */
export interface RawGrid {
  sheetName: string;
  rows: string[][];
  columnCount: number;
}

export class ExcelFormatError extends Error {}

/** 0 -> "A", 1 -> "B" ... 25 -> "Z", 26 -> "AA". Para rotular columnas en la grilla cruda. */
export function columnLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Convierte un valor de celda a número. Tolera formato argentino
 * ("1.234,56"), símbolo de moneda y espacios.
 */
export function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let text = String(value).trim().replace(/\s/g, '').replace(/[$â‚¬]/g, '').replace(/ARS/gi, '');
  if (text === '') return null;

  const hasComma = text.includes(',');
  const hasDot = text.includes('.');

  if (hasComma && hasDot) {
    // El último separador es el decimal: "1.234,56" o "1,234.56"
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (hasComma) {
    // Sola coma: decimal en formato argentino ("1234,56")
    text = text.replace(',', '.');
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readMatrix(file: File): Promise<{ sheetName: string; matrix: unknown[][] }> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new ExcelFormatError('El archivo no tiene ninguna hoja.');
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    defval: '',
  });

  if (matrix.length === 0) {
    throw new ExcelFormatError('El archivo está vacío.');
  }

  return { sheetName, matrix: matrix as unknown[][] };
}

/**
 * No asume encabezado en la fila 1: cada proveedor lo pone en una fila
 * distinta, o no lo pone. Devuelve las primeras filas tal cual están para
 * que el admin elija a mano qué columna es cada dato.
 */
export async function previewSheet(file: File, maxRows = 15): Promise<RawGrid> {
  const { sheetName, matrix } = await readMatrix(file);
  const columnCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const rows = matrix.slice(0, maxRows).map((row) =>
    Array.from({ length: columnCount }, (_, i) => String(row[i] ?? '').trim())
  );
  return { sheetName, rows, columnCount };
}

/**
 * Aplica el mapeo de columnas (guardado o recién definido) a todo el
 * archivo. Una fila de título o separadora no tiene a la vez código y
 * precio numérico válido en las columnas mapeadas, así que queda
 * descartada sola, sin necesidad de saber en qué fila empiezan los datos.
 */
export async function parseWithMapping(file: File, mapping: ColumnMapping): Promise<ParsedSheet> {
  const { sheetName, matrix } = await readMatrix(file);

  const rows: ImportRow[] = [];
  const skipped: ParsedSheet['skipped'] = [];
  const seen = new Set<string>();

  matrix.forEach((raw, i) => {
    const rowNumber = i + 1;
    const code = String(raw[mapping.codeColumn] ?? '').trim();
    const description = mapping.descriptionColumn === null
      ? ''
      : String(raw[mapping.descriptionColumn] ?? '').trim();
    const brand = mapping.brandColumn === null
      ? null
      : (String(raw[mapping.brandColumn] ?? '').trim() || null);
    const price = parsePrice(raw[mapping.priceColumn]);

    if (code === '') {
      skipped.push({ row: rowNumber, reason: 'sin código' });
      return;
    }
    if (price === null) {
      skipped.push({ row: rowNumber, reason: `precio ilegible ("${raw[mapping.priceColumn]}")` });
      return;
    }
    if (price < 0) {
      skipped.push({ row: rowNumber, reason: 'precio negativo' });
      return;
    }

    const key = code.toUpperCase();
    if (seen.has(key)) {
      skipped.push({ row: rowNumber, reason: `código repetido (${code})` });
      return;
    }
    seen.add(key);

    rows.push({ code, description, brand, price });
  });

  if (rows.length === 0) {
    throw new ExcelFormatError(
      'Ninguna fila tiene a la vez código y precio válidos con este mapeo. Revisá las columnas elegidas.'
    );
  }

  return { rows, skipped, sheetName };
}
```

- [ ] **Step 2: Actualizar `src/lib/priceLists.ts`**

Reemplazar el bloque de tipos de importación (desde `export interface UnmatchedPrice` hasta `export interface ImportResult`):

```ts
export interface UnmatchedPrice {
  id: string;
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  description: string | null;
  purchasePrice: number;
  importedAt: string;
}

export interface PriceImport {
  id: string;
  supplierId: string;
  supplierName: string;
  fileName: string | null;
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  importedAt: string;
}

/** Fila del Excel, ya normalizada. */
export interface ImportRow {
  code: string;
  description: string;
  price: number;
}

export interface ImportResult {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  importId: string;
}
```

por:

```ts
export interface PriceImport {
  id: string;
  supplierId: string;
  supplierName: string;
  fileName: string | null;
  totalRows: number;
  matchedRows: number;
  /** Artículos nuevos dados de alta en esta importación. */
  createdRows: number;
  importedAt: string;
}

/** Fila del Excel, ya normalizada. */
export interface ImportRow {
  code: string;
  description: string;
  brand: string | null;
  price: number;
}

export interface ImportResult {
  totalRows: number;
  matchedRows: number;
  /** Artículos nuevos dados de alta en esta importación. */
  createdRows: number;
  importId: string;
}

/** Mapeo de columnas del Excel de un proveedor, guardado para reusar. */
export interface ColumnMapping {
  codeColumn: number;
  priceColumn: number;
  descriptionColumn: number | null;
  brandColumn: number | null;
}
```

Reemplazar la sección `// ===== Importación =====` completa (desde `export async function importSupplierPrices` hasta el final del archivo, es decir hasta `describePriceError` inclusive) por:

```ts
// ===== Mapeo de columnas por proveedor =====

export async function fetchSupplierImportProfile(supplierId: string): Promise<ColumnMapping | null> {
  const { data, error } = await supabase
    .from('supplier_import_profiles')
    .select('code_column, description_column, brand_column, price_column')
    .eq('supplier_id', supplierId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    codeColumn: data.code_column,
    priceColumn: data.price_column,
    descriptionColumn: data.description_column,
    brandColumn: data.brand_column,
  };
}

export async function saveSupplierImportProfile(supplierId: string, mapping: ColumnMapping): Promise<void> {
  const { error } = await supabase.from('supplier_import_profiles').upsert({
    supplier_id: supplierId,
    code_column: mapping.codeColumn,
    price_column: mapping.priceColumn,
    description_column: mapping.descriptionColumn,
    brand_column: mapping.brandColumn,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// ===== Importación =====

export async function importSupplierPrices(
  supplierId: string,
  fileName: string,
  rows: ImportRow[]
): Promise<ImportResult> {
  const { data, error } = await supabase.rpc('import_supplier_prices', {
    p_supplier_id: supplierId,
    p_file_name: fileName,
    p_rows: rows,
  });
  if (error) throw error;
  const result: any = Array.isArray(data) ? data[0] : data;
  return {
    totalRows: Number(result.total_rows),
    matchedRows: Number(result.matched_rows),
    createdRows: Number(result.unmatched_rows),
    importId: result.import_id,
  };
}

export async function fetchPriceImports(limit = 20): Promise<PriceImport[]> {
  const { data, error } = await supabase
    .from('price_imports')
    .select('*, supplier:suppliers(name)')
    .order('imported_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier?.name ?? '—',
    fileName: row.file_name,
    totalRows: row.total_rows,
    matchedRows: row.matched_rows,
    createdRows: row.unmatched_rows,
    importedAt: row.imported_at,
  }));
}

/** Traduce errores de base a mensajes accionables. */
export function describePriceError(message: string): string {
  if (message.includes('article_suppliers_supplier_code_key')) {
    return 'Ese código ya está usado por otro artículo para el mismo proveedor.';
  }
  if (message.includes('article_suppliers_article_id_supplier_id_key')) {
    return 'Este proveedor ya está vinculado al artículo. Editá el vínculo existente.';
  }
  if (message.includes('article_suppliers_one_preferred')) {
    return 'El artículo ya tiene un proveedor preferido.';
  }
  return message;
}
```

- [ ] **Step 3: Crear `src/components/SupplierColumnMapper.tsx`**

```tsx
import React from 'react';
import { columnLetter, type RawGrid } from '@/src/lib/excelImport';
import type { ColumnMapping } from '@/src/lib/priceLists';

type Field = 'codeColumn' | 'priceColumn' | 'descriptionColumn' | 'brandColumn';

const REQUIRED_FIELDS: { field: 'codeColumn' | 'priceColumn'; label: string }[] = [
  { field: 'codeColumn', label: 'Código' },
  { field: 'priceColumn', label: 'Precio' },
];

const OPTIONAL_FIELDS: { field: 'descriptionColumn' | 'brandColumn'; label: string }[] = [
  { field: 'descriptionColumn', label: 'Descripción' },
  { field: 'brandColumn', label: 'Marca' },
];

/**
 * Grilla cruda del Excel para que el admin indique a mano qué columna es
 * cada dato. No se adivina por nombre de encabezado: cada proveedor arma
 * su lista distinto (encabezado en cualquier fila, títulos de sección,
 * columnas en otro orden).
 */
export function SupplierColumnMapper({
  grid,
  initialMapping,
  saving,
  onSave,
  onCancel,
}: {
  grid: RawGrid;
  initialMapping: ColumnMapping | null;
  saving: boolean;
  onSave: (mapping: ColumnMapping) => void;
  onCancel: () => void;
}) {
  const [codeColumn, setCodeColumn] = React.useState<number | null>(initialMapping?.codeColumn ?? null);
  const [priceColumn, setPriceColumn] = React.useState<number | null>(initialMapping?.priceColumn ?? null);
  const [descriptionColumn, setDescriptionColumn] = React.useState<number | null>(
    initialMapping?.descriptionColumn ?? null
  );
  const [brandColumn, setBrandColumn] = React.useState<number | null>(initialMapping?.brandColumn ?? null);

  // Fila más cercana al final de la vista previa: en un archivo real, las
  // primeras suelen ser título/encabezado y las últimas ya son datos.
  const sample = grid.rows[grid.rows.length - 1] ?? [];

  const values: Record<Field, number | null> = { codeColumn, priceColumn, descriptionColumn, brandColumn };
  const setters: Record<Field, (v: number | null) => void> = {
    codeColumn: setCodeColumn,
    priceColumn: setPriceColumn,
    descriptionColumn: setDescriptionColumn,
    brandColumn: setBrandColumn,
  };

  const chosen = [codeColumn, priceColumn, descriptionColumn, brandColumn].filter(
    (c): c is number => c !== null
  );
  const hasDuplicates = new Set(chosen).size !== chosen.length;
  const canSave = codeColumn !== null && priceColumn !== null && !hasDuplicates;

  function optionLabel(i: number) {
    const preview = sample[i] ? ` — "${sample[i]}"` : '';
    return `Columna ${columnLetter(i)}${preview}`;
  }

  function renderSelect(field: Field, required: boolean) {
    return (
      <select
        value={values[field] ?? ''}
        onChange={(e) => setters[field](e.target.value === '' ? null : Number(e.target.value))}
        className="mt-1 w-full border border-line bg-panel px-2 py-1.5 text-sm focus:border-accent-deep focus:outline-none"
      >
        <option value="">{required ? 'Elegí una columna...' : '— sin mapear —'}</option>
        {Array.from({ length: grid.columnCount }, (_, i) => (
          <option key={i} value={i}>{optionLabel(i)}</option>
        ))}
      </select>
    );
  }

  return (
    <div className="border border-line overflow-hidden">
      <div className="bg-panel-alt px-3 py-2 text-xs text-text-soft">
        Hoja <strong>{grid.sheetName}</strong> · indicá en qué columna está cada dato. Se guarda para
        que las próximas importaciones de este proveedor lo reconozcan solas.
      </div>

      <div className="overflow-x-auto max-h-64">
        <table className="w-full text-left text-[12px] font-mono">
          <thead className="bg-panel-head sticky top-0">
            <tr>
              {Array.from({ length: grid.columnCount }, (_, i) => (
                <th key={i} className="px-2 py-1 border-b border-line font-bold">{columnLetter(i)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, r) => (
              <tr key={r} className={r % 2 === 0 ? 'bg-panel-alt' : 'bg-panel'}>
                {Array.from({ length: grid.columnCount }, (_, i) => (
                  <td key={i} className="px-2 py-1 whitespace-nowrap">
                    {row[i] || <span className="text-text-faint">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 p-3 border-t border-line">
        {REQUIRED_FIELDS.map(({ field, label }) => (
          <label key={field} className="text-xs font-bold uppercase tracking-wider text-text-soft">
            {label} <span className="text-danger">*</span>
            {renderSelect(field, true)}
          </label>
        ))}
        {OPTIONAL_FIELDS.map(({ field, label }) => (
          <label key={field} className="text-xs font-bold uppercase tracking-wider text-text-soft">
            {label}
            {renderSelect(field, false)}
          </label>
        ))}
      </div>

      {hasDuplicates && (
        <div className="px-3 pb-2 text-[11px] text-danger">
          Cada campo tiene que apuntar a una columna distinta.
        </div>
      )}

      <div className="flex justify-end gap-2 p-3 border-t border-line">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={!canSave || saving}
          onClick={() =>
            canSave &&
            onSave({ codeColumn: codeColumn!, priceColumn: priceColumn!, descriptionColumn, brandColumn })
          }
          className="bg-accent text-accent-ink text-[11px] font-bold uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
        >
          {saving ? 'Guardando...' : 'Guardar mapeo y continuar'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Reescribir `src/pages/PriceLists.tsx`**

Reemplazar el archivo completo por:

```tsx
import React from 'react';
import { Upload, AlertTriangle, CheckCircle2, Percent, History } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { ExcelFormatError, parseWithMapping, previewSheet, type RawGrid } from '@/src/lib/excelImport';
import {
  describePriceError,
  fetchDefaultMarkup,
  fetchPriceImports,
  fetchSupplierImportProfile,
  importSupplierPrices,
  saveSupplierImportProfile,
  updateDefaultMarkup,
  type ColumnMapping,
  type ImportResult,
  type ParsedSheet,
  type PriceImport,
} from '@/src/lib/priceLists';
import { SupplierColumnMapper } from '@/src/components/SupplierColumnMapper';

export function PriceLists() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [imports, setImports] = React.useState<PriceImport[]>([]);
  const [markup, setMarkup] = React.useState(0);
  const [markupDraft, setMarkupDraft] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const loadAll = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [supplierRows, importRows, defaultMarkup] = await Promise.all([
        fetchSuppliers(true),
        fetchPriceImports(),
        fetchDefaultMarkup(),
      ]);
      setSuppliers(supplierRows);
      setImports(importRows);
      setMarkup(defaultMarkup);
      setMarkupDraft(String(defaultMarkup));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadAll();
  }, [isAdmin, loadAll]);

  async function handleSaveMarkup() {
    const value = Number(markupDraft);
    if (!Number.isFinite(value) || value < 0) {
      setError('La utilidad debe ser un número mayor o igual a 0.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateDefaultMarkup(value);
      setNotice(
        `Utilidad global actualizada a ${value}%. Se recalcularon ${updated} precio(s) de venta ` +
        'de los artículos que heredan este valor.'
      );
      await loadAll();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Listas de precios"
        subtitle="Importá la lista de compra de cada proveedor. El precio de venta se recalcula solo."
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}
      {notice && (
        <div className="bg-panel-alt border border-state-done/40 text-state-done text-sm px-4 py-3 flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* Utilidad global */}
      <section className="bg-panel border border-line p-5 space-y-3">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
          <Percent size={14} /> Utilidad por defecto
        </h2>
        <p className="text-xs text-text-soft">
          Se aplica a los artículos que no tienen una utilidad propia cargada.
          Al cambiarla se recalculan sus precios de venta.
        </p>
        <div className="flex items-end gap-2">
          <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
            Porcentaje
            <div className="mt-1 flex items-center">
              <input
                type="number"
                step="0.01"
                min="0"
                value={markupDraft}
                onChange={(e) => setMarkupDraft(e.target.value)}
                className="w-28 border border-line px-3 py-2 text-sm text-right"
              />
              <span className="bg-panel-head border border-l-0 border-line px-3 py-2 text-sm text-text-soft">%</span>
            </div>
          </label>
          <button
            onClick={handleSaveMarkup}
            disabled={busy || Number(markupDraft) === markup}
            className="bg-accent-deep text-white text-[11px] font-bold uppercase tracking-wider px-4 py-2 hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {busy ? 'Aplicando...' : 'Guardar y recalcular'}
          </button>
        </div>
      </section>

      {/* Importación */}
      <ImportSection
        suppliers={suppliers}
        onImported={async (result, supplierName) => {
          setNotice(
            `Lista de ${supplierName} importada: ${result.matchedRows} precio(s) actualizado(s)` +
            (result.createdRows > 0
              ? ` y ${result.createdRows} artículo(s) nuevo(s) dado(s) de alta.`
              : '. Todos los códigos ya eran conocidos.')
          );
          setError(null);
          await loadAll();
        }}
        onError={(message) => { setError(message); setNotice(null); }}
      />

      {/* Historial */}
      <section className="border border-line bg-panel">
        <div className="p-4 border-b border-line bg-panel-head">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
            <History size={14} /> Últimas importaciones
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table-stack w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[11px] uppercase tracking-[0.06em] text-text-soft">
                <th className="p-3 font-semibold w-40">Fecha</th>
                <th className="p-3 font-semibold">Proveedor</th>
                <th className="p-3 font-semibold">Archivo</th>
                <th className="p-3 font-semibold w-24 text-right">Filas</th>
                <th className="p-3 font-semibold w-28 text-right">Actualizadas</th>
                <th className="p-3 font-semibold w-28 text-right">Creados</th>
              </tr>
            </thead>
            <tbody>
              {imports.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-text-soft">Todavía no se importó ninguna lista.</td></tr>
              )}
              {imports.map((row) => (
                <tr key={row.id} className="border-b border-line">
                  <td data-primary className="p-3">{new Date(row.importedAt).toLocaleString('es-AR')}</td>
                  <td data-label="Proveedor" className="p-3 font-semibold">{row.supplierName}</td>
                  <td data-label="Archivo" className="p-3 text-text-soft">{row.fileName ?? '—'}</td>
                  <td data-label="Filas" className="p-3 text-right">{row.totalRows}</td>
                  <td data-label="Actualizadas" className="p-3 text-right text-state-done font-bold">{row.matchedRows}</td>
                  <td className={cn('p-3 text-right font-bold', row.createdRows > 0 ? 'text-accent-deep' : 'text-text-soft')}>
                    {row.createdRows}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ImportSection({
  suppliers,
  onImported,
  onError,
}: {
  suppliers: Supplier[];
  onImported: (result: ImportResult, supplierName: string) => void;
  onError: (message: string) => void;
}) {
  const [supplierId, setSupplierId] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [mapping, setMapping] = React.useState<ColumnMapping | null>(null);
  const [grid, setGrid] = React.useState<RawGrid | null>(null);
  const [parsed, setParsed] = React.useState<ParsedSheet | null>(null);
  const [savingMapping, setSavingMapping] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;

  async function loadForFile(selected: File, currentSupplierId: string) {
    setParsed(null);
    setGrid(null);
    setMapping(null);
    try {
      const profile = await fetchSupplierImportProfile(currentSupplierId);
      if (profile) {
        setMapping(profile);
        setParsed(await parseWithMapping(selected, profile));
      } else {
        setGrid(await previewSheet(selected));
      }
    } catch (err) {
      onError(
        err instanceof ExcelFormatError
          ? `No se pudo leer el archivo: ${err.message}`
          : getErrorMessage(err)
      );
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleFile(selected: File | null) {
    setFile(selected);
    setParsed(null);
    setGrid(null);
    setMapping(null);
    if (!selected || !supplierId) return;
    await loadForFile(selected, supplierId);
  }

  function handleSupplierChange(id: string) {
    setSupplierId(id);
    setParsed(null);
    setGrid(null);
    setMapping(null);
    if (file && id) loadForFile(file, id);
  }

  async function handleEditMapping() {
    if (!file) return;
    setParsed(null);
    try {
      setGrid(await previewSheet(file));
    } catch (err) {
      onError(getErrorMessage(err));
    }
  }

  async function handleSaveMapping(newMapping: ColumnMapping) {
    if (!file || !supplierId) return;
    setSavingMapping(true);
    try {
      await saveSupplierImportProfile(supplierId, newMapping);
      setMapping(newMapping);
      setGrid(null);
      setParsed(await parseWithMapping(file, newMapping));
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setSavingMapping(false);
    }
  }

  async function handleImport() {
    if (!supplierId || !parsed || !file) return;
    setImporting(true);
    try {
      const result = await importSupplierPrices(supplierId, file.name, parsed.rows);
      const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? 'proveedor';
      onImported(result, supplierName);
      setFile(null);
      setParsed(null);
      setGrid(null);
      setMapping(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      onError(describePriceError(getErrorMessage(err)));
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="bg-panel border border-line p-5 space-y-4">
      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
          <Upload size={14} /> Importar lista de compra
        </h2>
        <p className="text-xs text-text-soft mt-1">
          Subí el Excel tal como lo manda el proveedor. La primera vez se pide indicar en qué
          columna está cada dato; las próximas veces se recuerda solo.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
          Proveedor
          <select
            value={supplierId}
            onChange={(e) => handleSupplierChange(e.target.value)}
            className="mt-1 w-full border border-line px-3 py-2 text-sm font-normal normal-case bg-panel"
          >
            <option value="">Elegí el proveedor de esta lista...</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {supplier && !supplier.codePrefix && (
            <span className="mt-1 block text-[11px] font-normal normal-case text-danger">
              Este proveedor no tiene prefijo de código. Definilo en Proveedores antes de importar.
            </span>
          )}
        </label>

        <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
          Archivo Excel
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={!supplierId || !supplier?.codePrefix}
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            className="mt-1 w-full border border-line px-3 py-[7px] text-sm font-normal normal-case file:mr-3 file:border-0 file:bg-panel-head file:px-2 file:py-1 file:text-xs file:cursor-pointer disabled:opacity-50"
          />
        </label>
      </div>

      {grid && (
        <SupplierColumnMapper
          grid={grid}
          initialMapping={mapping}
          saving={savingMapping}
          onSave={handleSaveMapping}
          onCancel={() => {
            setGrid(null);
            if (!mapping) {
              setFile(null);
              if (inputRef.current) inputRef.current.value = '';
            }
          }}
        />
      )}

      {parsed && !grid && (
        <div className="border border-line overflow-hidden">
          <div className="bg-panel-alt px-3 py-2 text-xs text-text-soft flex items-center justify-between flex-wrap gap-2">
            <span>
              Hoja <strong>{parsed.sheetName}</strong> · <strong>{parsed.rows.length}</strong> fila(s) válidas
              {parsed.skipped.length > 0 && (
                <span className="text-state-wait"> · {parsed.skipped.length} descartada(s)</span>
              )}
            </span>
            <button
              type="button"
              onClick={handleEditMapping}
              className="text-accent-deep hover:underline font-semibold"
            >
              Editar mapeo
            </button>
          </div>
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="bg-panel-head text-text font-bold uppercase tracking-wider">
              <tr>
                <th className="px-3 py-1 w-32">Código prov.</th>
                <th className="px-3 py-1">Descripción</th>
                <th className="px-3 py-1 w-28">Marca</th>
                <th className="px-3 py-1 w-32 text-right">Precio compra</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.slice(0, 5).map((row, i) => (
                <tr key={i} className={cn('border-b border-line', i % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
                  <td className="px-3 py-1 font-mono font-bold">{row.code}</td>
                  <td className="px-3 py-1">{row.description || <span className="text-text-faint">—</span>}</td>
                  <td className="px-3 py-1">{row.brand || <span className="text-text-faint">—</span>}</td>
                  <td className="px-3 py-1 text-right">$ {row.price.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {parsed.skipped.length > 0 && (
            <div className="bg-orange-50 border-t border-orange-200 px-3 py-2 text-[11px] text-state-wait">
              <AlertTriangle size={12} className="inline mr-1" />
              Filas descartadas:{' '}
              {parsed.skipped.slice(0, 5).map((s) => `fila ${s.row} (${s.reason})`).join(', ')}
              {parsed.skipped.length > 5 && ` y ${parsed.skipped.length - 5} más`}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleImport}
          disabled={!supplierId || !parsed || !!grid || importing}
          className="bg-accent text-accent-ink text-[11px] font-bold uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
          <Upload size={16} />
          {importing ? 'Importando...' : 'Importar precios'}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Verificar que compila y buildea**

Run: `npx tsc --noEmit`
Expected: sin errores. Si aparece un import no usado (por ejemplo, si algo quedó referenciado de la versión vieja), corregirlo antes de seguir.

Run: `npm run build`
Expected: build exitoso (los warnings de tamaño de chunk pre-existentes son normales, no son de esta feature).

- [ ] **Step 6: Prueba manual con un archivo real**

`npm run dev`, ir a Listas de precios. Elegir un proveedor sin prefijo configurado: confirmar que el selector de archivo queda deshabilitado y se ve el aviso. Cargarle un prefijo en Proveedores (Task 2), volver.

Elegir el proveedor y subir el Excel real de Maximiliano Diesel S.A. (el de la captura del pedido original). Como es la primera vez, tiene que aparecer la grilla cruda. Mapear: Código = columna B, Descripción = columna C, Marca = columna D, Precio = columna G. Guardar mapeo.

Confirmar en la vista previa que:
- Las filas de título ("1-TOBERAS") y las separadoras (guiones) NO aparecen como filas válidas.
- Las primeras filas reales (código, descripción, marca, precio) se ven bien.

Importar. Confirmar el aviso de artículos creados, y en Inventario que aparecieron con código `<PREFIJO>-00000001` en adelante, con la marca cargada.

Repetir la importación del mismo archivo una segunda vez: confirmar que esta vez el mapeo se aplica solo (sin mostrar la grilla) y que el resultado dice 0 artículos nuevos (todos ya son sinónimos conocidos).

- [ ] **Step 7: Commit**

```bash
git add src/lib/excelImport.ts src/lib/priceLists.ts src/components/SupplierColumnMapper.tsx src/pages/PriceLists.tsx
git commit -m "$(cat <<'EOF'
Listas de precios: mapeo de columnas por proveedor y alta automática

Reemplaza la plantilla fija y la cola manual de códigos sin vincular:
ahora se sube el Excel tal como lo manda cada proveedor, se mapean sus
columnas una vez (queda guardado), y todo código nuevo se convierte
solo en un artículo nuestro con código secuencial por prefijo.
EOF
)"
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git push origin main
```

Confirmar con `git ls-remote origin main` contra `git rev-parse --short main`.

---

## Self-Review

**Cobertura de la spec:**
- Mapeo de columnas guardado por proveedor, sin heurística de encabezado → Task 4 (`SupplierColumnMapper`, `previewSheet`/`parseWithMapping`, `supplier_import_profiles`).
- Sin fila de inicio de datos, se descartan solas → `parseWithMapping` (Task 4), verificado en la prueba manual del Step 6.
- Alta automática, sin cola manual → RPC reescrita (Task 1), tabla `unmatched_supplier_prices` eliminada (Task 1), `UnmatchedSection`/`LinkModal` eliminados (Task 4).
- Marca en `articles` y en el ABM → Task 3.
- Prefijo por proveedor, único, en el ABM → Task 2.
- Código `<PREFIJO>-8 dígitos`, secuencia por prefijo → RPC (Task 1).
- No se toca `description`/`brand` en reimportaciones de un código ya conocido → RPC: el `update` del camino "matched" solo toca `purchase_price`/`supplier_description` (Task 1).
- Historial con columna "Creados" → Task 4 (`PriceLists.tsx`).
- Validación de proveedor sin prefijo, antes de tocar la base → chequeo en la RPC (Task 1) + precheck en la UI que deshabilita el input de archivo (Task 4).

**Placeholders:** ninguno — cada paso trae el código completo, sin "TBD" ni "similar a la tarea N".

**Consistencia de tipos:** `ColumnMapping` (priceLists.ts) tiene los mismos 4 campos que usa `SupplierColumnMapper` y que arma `parseWithMapping`; `ImportRow.brand` se agrega en priceLists.ts (Task 4, Step 2) antes de que `excelImport.ts` (Task 4, Step 1) y `SupplierColumnMapper.tsx` (Task 4, Step 3) lo consuman — dentro de la misma tarea, así que no queda un estado intermedio roto. `PriceImport`/`ImportResult.createdRows` se usa igual en `priceLists.ts` y en `PriceLists.tsx`. `Supplier.codePrefix` (Task 2) es el mismo nombre que lee `PriceLists.tsx` (Task 4).

---

## Execution Handoff

Plan completo y guardado en `docs/superpowers/plans/2026-08-26-importacion-catalogo-proveedor.md`. Dos formas de ejecutarlo:

**1. Subagent-Driven (recomendado)** — despacho un subagente nuevo por tarea, reviso entre tareas, iteración rápida.

**2. Ejecución en esta sesión** — ejecuto las tareas acá mismo con executing-plans, por lotes con checkpoints para que revises.

¿Cuál preferís?
