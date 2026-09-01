# Carga de facturas de compra con IA — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un flujo nuevo y separado de la carga manual — subir el PDF/foto de una factura de proveedor, que Gemini extraiga los datos, revisarlos contra el original y confirmar — para ambos tipos de compra (ARTICULOS y CONCEPTOS) que ya existen en Ludiesel.

**Architecture:** Edge Function (`extraer-factura-compra`) que recibe la ruta de un archivo ya subido a Storage, llama a Gemini con visión de documento y `responseSchema`, matchea proveedor (por CUIT) y renglones de artículo (por código exacto en `article_suppliers`), y persiste el resultado crudo en una tabla de borrador (`purchase_invoice_extractions`). El frontend tiene su propia entrada de menú y sus propias páginas (landing → subir → revisar), separadas de `PurchaseNew.tsx`; al confirmar, llama a la misma RPC `save_purchase_invoice` de siempre, sin cambios.

**Tech Stack:** React 19 + TypeScript + Vite, Supabase (Postgres + Storage + Edge Functions en Deno), `@google/genai` (Gemini, ya declarado en `package.json`).

**Spec:** [docs/superpowers/specs/2026-09-01-carga-facturas-compra-ia-design.md](../specs/2026-09-01-carga-facturas-compra-ia-design.md)

## Global Constraints

- Proveedor de IA: **Gemini** (`@google/genai@^2.4.0`, ya en `package.json`), nunca llamado desde el navegador — solo desde la Edge Function con la API key server-side.
- Alcance: **ARTICULOS y CONCEPTOS desde el arranque**. Renglones de ARTICULOS se matchean contra el catálogo **solo por código exacto** de `article_suppliers.supplier_code` (índice único `(supplier_id, upper(supplier_code))`) — sin fuzzy-matching de texto en v1.
- Entrada de archivo: PDF o foto (imagen), subidos por el usuario — el archivo se sube directo a Storage desde el cliente, la Edge Function nunca recibe el binario en el body.
- Arquitectura **síncrona con borrador persistido**: sin cola, sin cron. El resultado crudo de Gemini se guarda en `purchase_invoice_extractions` apenas vuelve, antes de que el usuario confirme nada.
- **Separado de la carga manual**: entrada de menú propia, rutas propias, páginas propias. `PurchaseNew.tsx` no se toca como pantalla (solo se le extraen 3 componentes de presentación, sin cambiar su comportamiento).
- **Sin test runner nuevo**: el proyecto no tiene Vitest/Jest instalado y esa es la convención existente — se sigue el patrón ya establecido en este repo (`npx tsc --noEmit`, `npm run build`, prueba manual end-to-end con Playwright y datos reales, limpieza de datos de prueba después).
- Todo Edge Function nueva sigue el patrón exacto de `supabase/functions/gestionar-empleado/index.ts`: `SUPABASE_SERVICE_ROLE_KEY` server-side, `verificarAdmin(req)` antes de tocar el body, `CORS_HEADERS` fijos, helper `json(body, status)`.
- Confirmar (`savePurchaseInvoice`, la RPC `save_purchase_invoice`, la tabla `purchase_invoices`) **no se modifica**.

---

### Task 1: Migración SQL — borrador de extracción con IA

**Files:**
- Create: `supabase/purchase-invoice-extractions.sql`

**Interfaces:**
- Produces: tabla `purchase_invoice_extractions` (columnas: `id`, `kind`, `supplier_id`, `attachment_storage_path`, `attachment_mime_type`, `raw_extraction` jsonb, `status`, `error_message`, `purchase_invoice_id`, `created_by`, `created_at`); bucket `purchase-invoice-drafts`.

- [ ] **Step 1: Escribir la migración**

```sql
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
```

- [ ] **Step 2: Aplicar la migración**

Usar la herramienta de Supabase del entorno (`apply_migration`, proyecto `mnoqdqjhsylohlvuekfh`) con el nombre `purchase_invoice_extractions`, confirmando con el usuario antes de aplicar (patrón ya establecido en este proyecto para cualquier cambio de esquema).

- [ ] **Step 3: Verificar**

```sql
select column_name, data_type from information_schema.columns
where table_name = 'purchase_invoice_extractions' order by ordinal_position;

select id, public from storage.buckets where id = 'purchase-invoice-drafts';
```

Esperado: 10 columnas listadas: `id`, `kind`, `supplier_id`, `attachment_storage_path`, `attachment_mime_type`, `raw_extraction`, `status`, `error_message`, `purchase_invoice_id`, `created_by`, `created_at`. Bucket con `public = false`.

- [ ] **Step 4: Commit**

```bash
git add supabase/purchase-invoice-extractions.sql
git commit -m "Compras: tabla y bucket para borradores de facturas leídas con IA"
```

---

### Task 2: Medir el techo de campos del structured output de Gemini

**Files:**
- Create: `scripts/medir-techo-schema-gemini.ts`

**Interfaces:**
- Consumes: `GEMINI_API_KEY` (variable de entorno, se pide al usuario si no está seteada localmente para correr este script una sola vez).
- Produces: confirmación de si el schema de ARTICULOS diseñado en la Tarea 6 compila tal cual, o si hace falta partirlo en dos llamados (como el segundo pase de PH_FAC contra el remito).

Gemini no publica un techo numérico de campos para `responseSchema` (a diferencia de Claude, que PH_FAC midió en ~35) — la documentación solo advierte de un error 400 por "complejidad de schema" sin dar un número. Este script prueba el schema completo de ARTICULOS (el más grande de los dos tipos, con el array de renglones) contra un prompt trivial, sin necesitar ningún PDF real — el objetivo es solo confirmar que el schema en sí no rebota.

- [ ] **Step 1: Escribir el script**

```typescript
// scripts/medir-techo-schema-gemini.ts
//
// Corrida única, manual: confirma si el schema de ARTICULOS (Tarea 6)
// compila en Gemini antes de construir la Edge Function alrededor de él.
// Uso: GEMINI_API_KEY=... npx tsx scripts/medir-techo-schema-gemini.ts

import { GoogleGenAI, Type } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Falta GEMINI_API_KEY en el entorno.');
  process.exit(1);
}

// Mismo schema que usa extraer-factura-compra (Tarea 6) para kind=ARTICULOS
// — si se cambia acá, cambiarlo también allá.
const schemaArticulos = {
  type: Type.OBJECT,
  properties: {
    valores: {
      type: Type.OBJECT,
      properties: {
        proveedor_cuit: { type: Type.STRING },
        proveedor_razon_social: { type: Type.STRING },
        tipo_comprobante: { type: Type.STRING },
        letra: { type: Type.STRING },
        punto_venta: { type: Type.STRING },
        numero: { type: Type.STRING },
        fecha_comprobante: { type: Type.STRING },
        condicion_pago: { type: Type.STRING },
        total: { type: Type.STRING },
      },
      required: [
        'proveedor_cuit', 'proveedor_razon_social', 'tipo_comprobante', 'letra',
        'punto_venta', 'numero', 'fecha_comprobante', 'condicion_pago', 'total',
      ],
    },
    confianzas: {
      type: Type.OBJECT,
      properties: {
        proveedor_cuit: { type: Type.NUMBER },
        proveedor_razon_social: { type: Type.NUMBER },
        tipo_comprobante: { type: Type.NUMBER },
        letra: { type: Type.NUMBER },
        punto_venta: { type: Type.NUMBER },
        numero: { type: Type.NUMBER },
        fecha_comprobante: { type: Type.NUMBER },
        condicion_pago: { type: Type.NUMBER },
        total: { type: Type.NUMBER },
      },
      required: [
        'proveedor_cuit', 'proveedor_razon_social', 'tipo_comprobante', 'letra',
        'punto_venta', 'numero', 'fecha_comprobante', 'condicion_pago', 'total',
      ],
    },
    percepciones: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { nombre: { type: Type.STRING }, importe: { type: Type.STRING } },
        required: ['nombre', 'importe'],
      },
    },
    renglones: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          codigo: { type: Type.STRING },
          descripcion: { type: Type.STRING },
          cantidad: { type: Type.STRING },
          precio_unitario: { type: Type.STRING },
          bonificacion_porcentaje: { type: Type.STRING },
          alicuota_iva: { type: Type.STRING },
          confianza: { type: Type.NUMBER },
        },
        required: [
          'codigo', 'descripcion', 'cantidad', 'precio_unitario',
          'bonificacion_porcentaje', 'alicuota_iva', 'confianza',
        ],
      },
    },
  },
  required: ['valores', 'confianzas', 'percepciones', 'renglones'],
};

const ai = new GoogleGenAI({ apiKey });

const response = await ai.models.generateContent({
  model: 'gemini-3.7-flash',
  contents: 'Devolvé un objeto de ejemplo con un renglón y una percepción, con valores inventados.',
  config: {
    responseMimeType: 'application/json',
    responseSchema: schemaArticulos,
  },
});

console.log('OK — el schema compiló. Respuesta:');
console.log(response.text);
```

- [ ] **Step 2: Correrlo**

Run: `GEMINI_API_KEY=<key real> npx tsx scripts/medir-techo-schema-gemini.ts`

**Si da error 400 con un mensaje de complejidad de schema** ("schema too complex", "too many properties" o similar): anotarlo en la Tarea 6 y aplicar ahí el mismo remedio que PH_FAC — partir en dos llamados: uno para `valores`+`confianzas`+`percepciones` (encabezado), y uno segundo solo para `renglones`, cada uno con su propio schema más chico. Ajustar el Step 3 de la Tarea 6 en consecuencia antes de escribir esa tarea.

**Si compila y devuelve JSON válido**: seguir con la Tarea 6 tal como está escrita, sin partir el llamado.

- [ ] **Step 3: Borrar el script**

Era de una sola corrida, no queda en el repo:

```bash
rm scripts/medir-techo-schema-gemini.ts
```

No hay commit de este task — es un spike, no se guarda código.

---

### Task 3: Extraer `SupplierModal` a componente compartido

**Files:**
- Create: `src/components/SupplierModal.tsx`
- Modify: `src/pages/Suppliers.tsx:1-25` (imports), `:183-331` (uso + borrar la función local)

**Interfaces:**
- Produces: `SupplierModal({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: (supplier: Supplier) => void })` — exportado, mismo patrón que `CustomerModal.tsx`. La Tarea 9 (página de revisión) lo usa para alta rápida de proveedor.

- [ ] **Step 1: Crear el componente compartido**

Es el `SupplierModal` que hoy vive local en `Suppliers.tsx:197-331`, con dos cambios: exportado, y `onSaved` pasa el proveedor guardado en vez de no llevar argumento.

```typescript
// src/components/SupplierModal.tsx
import React from 'react';
import { X, Package, CalendarClock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getErrorMessage } from '@/src/lib/workOrders';
import { FiscalFields } from '@/src/components/FiscalFields';
import {
  EMPTY_FISCAL_FORM,
  fiscalEntityToForm,
  isValidCuit,
} from '@/src/lib/fiscal';
import {
  createSupplier,
  describeSupplierError,
  updateSupplier,
  type Supplier,
  type SupplierInput,
} from '@/src/lib/suppliers';

/**
 * Alta/edición de proveedor. Compartido entre la pantalla de Proveedores y
 * la revisión de facturas de compra leídas con IA (que necesita poder
 * cargar un proveedor nuevo sin salir de esa pantalla, igual que
 * CustomerModal para clientes).
 */
export function SupplierModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  onClose: () => void;
  onSaved: (supplier: Supplier) => void;
}) {
  const [form, setForm] = React.useState<SupplierInput>(
    supplier
      ? {
          ...fiscalEntityToForm(supplier),
          paymentTermsDays: supplier.paymentTermsDays,
          codePrefix: supplier.codePrefix,
        }
      : { ...EMPTY_FISCAL_FORM, taxCondition: 'RESPONSABLE_INSCRIPTO', paymentTermsDays: 30, codePrefix: null }
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function patch(changes: Partial<SupplierInput>) {
    setForm((prev) => ({ ...prev, ...changes }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('El nombre del proveedor es obligatorio.');
      return;
    }
    if (form.taxId.trim() !== '' && !isValidCuit(form.taxId)) {
      setError('El CUIT/CUIL ingresado no es válido.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = supplier ? await updateSupplier(supplier.id, form) : await createSupplier(form);
      onSaved(saved);
    } catch (err) {
      setError(describeSupplierError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">
            {supplier ? 'Editar proveedor' : 'Nuevo proveedor'}
          </h2>
          <button onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5 overflow-y-auto">
          {error && <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>}

          <FiscalFields
            form={form}
            patch={patch}
            nameLabel="Nombre / Denominación comercial"
            namePlaceholder="Diesel Parts S.A."
            legalNamePlaceholder="Diesel Parts Sociedad Anónima"
            activeLabel="Activo (disponible para asignar a artículos)"
          />

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

          {supplier && (
            <div className="border-t border-line pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-accent-deep flex items-center gap-1.5">
                  <Package size={14} /> Artículos que provee
                </h3>
                <Link to="/listas-precios" className="text-[11px] font-bold uppercase tracking-wider text-accent-deep hover:underline">
                  Importar lista →
                </Link>
              </div>
              {supplier.articles.length === 0 ? (
                <p className="text-xs text-text-soft">
                  Ningún artículo tiene asignado este proveedor. Asignalo desde la sección Inventario.
                </p>
              ) : (
                <ul className="space-y-1 max-h-48 overflow-y-auto">
                  {supplier.articles.map((article) => (
                    <li key={article.id} className="flex items-center justify-between bg-panel-alt border border-line px-3 py-2 text-sm gap-3">
                      <span className="min-w-0">
                        <span className="font-mono font-bold text-accent-deep text-xs">{article.supplierCode}</span>
                        <span className="mx-1.5 text-text-faint">→</span>
                        <span className="font-mono text-text-soft text-xs">{article.code}</span>
                        <span className="ml-2 text-text">{article.description}</span>
                      </span>
                      <span className="text-xs text-text-soft whitespace-nowrap">
                        $ {article.purchasePrice.toFixed(2)}
                        {article.isPreferred && (
                          <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-accent-deep">Preferido</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <button type="button" onClick={onClose} className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-text-soft hover:bg-panel-alt">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-accent text-accent-ink font-semibold text-[11px] uppercase tracking-wider px-4 py-2 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
            >
              {saving ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Actualizar `Suppliers.tsx`**

Borrar la función local `SupplierModal` (líneas 197-331) y la función `SupplierArticlesSection` (334-376, ahora inline arriba), importar la nueva, y adaptar el único uso (que hoy no usa el argumento — sigue sin usarlo, solo cambia la firma del callback):

```typescript
// src/pages/Suppliers.tsx — agregar el import
import { SupplierModal } from '@/src/components/SupplierModal';
```

```typescript
// src/pages/Suppliers.tsx — el uso (línea ~184) queda igual de comportamiento,
// solo que ahora onSaved recibe el proveedor (se ignora acá, no hace falta):
{editing && (
  <SupplierModal
    supplier={editing === 'new' ? null : editing}
    onClose={() => setEditing(null)}
    onSaved={() => {
      setEditing(null);
      loadSuppliers();
    }}
  />
)}
```

Borrar de `Suppliers.tsx` todo el bloque de las líneas 197 a 376 (las dos funciones locales) y el import de `Package`/`CalendarClock` si quedan sin uso en ese archivo (siguen usándose en la tabla — `Package` en la columna "Artículos" línea 156 — revisar antes de borrar el import; `CalendarClock` sí queda sin uso, borrarlo del import de `lucide-react` en la línea 2).

- [ ] **Step 3: Verificar tipos y comportamiento**

Run: `npx tsc --noEmit`
Expected: sin errores.

Probar manualmente en `/proveedores`: crear un proveedor nuevo y editar uno existente — mismo comportamiento que antes de la extracción (es un refactor, no debería cambiar nada visible).

- [ ] **Step 4: Commit**

```bash
git add src/components/SupplierModal.tsx src/pages/Suppliers.tsx
git commit -m "Extraer SupplierModal a componente compartido (como CustomerModal)"
```

---

### Task 4: Extraer componentes de renglón/impuesto/totales de `PurchaseNew.tsx`

**Files:**
- Create: `src/components/purchase/PurchaseItemRow.tsx`
- Create: `src/components/purchase/PurchaseTaxRow.tsx`
- Create: `src/components/purchase/PurchaseTotalsSummary.tsx`
- Modify: `src/pages/PurchaseNew.tsx` (usar los tres componentes en vez de JSX inline)

**Interfaces:**
- Produces:
  - `PurchaseItemRow({ line, idx, isArticles, concepts, vatRates, onPatch, onRemove }: { line: PurchaseLine; idx: number; isArticles: boolean; concepts: ExpenseConcept[]; vatRates: TaxRate[]; onPatch: (patch: Partial<PurchaseLine>) => void; onRemove: () => void })` — una fila `<tr>` de la tabla de renglones.
  - `PurchaseTaxRow({ tax, rate, suggested, onAmountChange, onRemove }: { tax: PurchaseFootTax; rate: TaxRate | undefined; suggested: number; onAmountChange: (amount: number) => void; onRemove: () => void })` — un `<li>` del pie de impuestos.
  - `PurchaseTotalsSummary({ totals, generalDiscount, onGeneralDiscountChange, declaredTotal, onDeclaredTotalChange }: { totals: PurchaseTotals; generalDiscount: string; onGeneralDiscountChange: (value: string) => void; declaredTotal: string; onDeclaredTotalChange: (value: string) => void })` — el panel completo de Totales, incluido el control cruzado.
- Consumes (de Task 5, para la Tarea 9): estos tres componentes son los que la página de revisión reutiliza para no duplicar la edición de renglones/impuestos/totales.

- [ ] **Step 1: Crear `PurchaseItemRow`**

```typescript
// src/components/purchase/PurchaseItemRow.tsx
import { Trash2, Package } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import type { ExpenseConcept } from '@/src/lib/expenseConcepts';
import type { TaxRate } from '@/src/lib/taxRates';
import type { PurchaseLine } from '@/src/lib/purchases';

/**
 * Una fila de la tabla de renglones de un comprobante de compra, sea
 * artículo o concepto. Compartida entre la carga manual (PurchaseNew) y la
 * revisión de una factura leída por IA — misma edición en los dos lugares.
 */
export function PurchaseItemRow({
  line,
  idx,
  isArticles,
  concepts,
  vatRates,
  onPatch,
  onRemove,
}: {
  line: PurchaseLine;
  idx: number;
  isArticles: boolean;
  concepts: ExpenseConcept[];
  vatRates: TaxRate[];
  onPatch: (patch: Partial<PurchaseLine>) => void;
  onRemove: () => void;
}) {
  const net = line.quantity * line.unitPrice * (1 - (line.discountPercent || 0) / 100);

  return (
    <tr className={cn('h-9 border-b border-line', idx % 2 === 0 ? 'bg-panel-alt' : 'bg-panel')}>
      {isArticles ? (
        <>
          <td data-primary className="px-2 py-1 font-mono font-semibold text-text-soft">
            <span className="inline-flex items-center gap-1.5">
              <Package size={12} className="text-accent-deep" />
              {line.code}
            </span>
          </td>
          <td data-label="Descripción" className="px-2 py-1">{line.description}</td>
        </>
      ) : (
        <>
          <td data-label="Concepto" className="px-1 py-1">
            <select
              value={line.conceptId ?? ''}
              onChange={(e) => onPatch({ conceptId: e.target.value || null })}
              className="w-full bg-transparent px-1 py-1 text-[12px] focus:outline-none"
            >
              <option value="">— texto libre —</option>
              {concepts.map((concept) => (
                <option key={concept.id} value={concept.id}>{concept.name}</option>
              ))}
            </select>
          </td>
          <td data-label="Detalle" className="px-1 py-1">
            <input
              value={line.description}
              onChange={(e) => onPatch({ description: e.target.value })}
              placeholder="Detalle del gasto"
              className={cn(
                'w-full bg-transparent px-2 py-1',
                line.description.trim() === '' && 'bg-danger-soft'
              )}
            />
          </td>
        </>
      )}

      <td data-label="Cant." className="px-1 py-1">
        <input
          type="number" step="0.01" min="0"
          value={line.quantity}
          onChange={(e) => onPatch({ quantity: Number(e.target.value) })}
          className="w-full bg-transparent px-2 py-1 text-right"
        />
      </td>
      <td data-label="P. unitario" className="px-1 py-1">
        <input
          type="number" step="0.01" min="0"
          value={line.unitPrice}
          onChange={(e) => onPatch({ unitPrice: Number(e.target.value) })}
          className="w-full bg-transparent px-2 py-1 text-right"
        />
      </td>
      <td data-label="Bonif. %" className="px-1 py-1">
        <input
          type="number" step="0.01" min="0" max="100"
          value={line.discountPercent}
          onChange={(e) => onPatch({ discountPercent: Number(e.target.value) })}
          className="w-full bg-transparent px-2 py-1 text-right"
        />
      </td>
      <td data-label="IVA" className="px-1 py-1">
        <select
          value={line.vatRateId}
          onChange={(e) => onPatch({ vatRateId: e.target.value })}
          className={cn(
            'w-full bg-transparent px-1 py-1 text-[12px] focus:outline-none',
            !line.vatRateId && 'bg-danger-soft'
          )}
        >
          <option value="">— elegir —</option>
          {vatRates.map((rate) => (
            <option key={rate.id} value={rate.id}>{rate.name}</option>
          ))}
        </select>
      </td>
      <td data-label="Neto" className="px-2 py-1 text-right font-semibold">
        $ {formatMoney(net)}
      </td>
      <td className="px-1 py-1 text-center">
        <button
          type="button"
          onClick={onRemove}
          aria-label="Quitar renglón"
          className="text-text-soft transition-colors hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}
```

- [ ] **Step 2: Crear `PurchaseTaxRow`**

```typescript
// src/components/purchase/PurchaseTaxRow.tsx
import { Trash2 } from 'lucide-react';
import { formatMoney } from '@/src/lib/utils';
import type { TaxRate } from '@/src/lib/taxRates';
import type { PurchaseFootTax } from '@/src/lib/purchases';

/** Un renglón del pie de percepciones/impuestos de un comprobante de compra. */
export function PurchaseTaxRow({
  tax,
  rate,
  suggested,
  onAmountChange,
  onRemove,
}: {
  tax: PurchaseFootTax;
  rate: TaxRate | undefined;
  suggested: number;
  onAmountChange: (amount: number) => void;
  onRemove: () => void;
}) {
  const edited = Math.abs(tax.amount - suggested) > 0.009;
  return (
    <li className="flex items-center gap-2 border border-line bg-panel-alt px-3 py-2">
      <span className="min-w-0 flex-1 text-xs">
        <span className="block truncate font-semibold text-text">{rate?.name}</span>
        <span className="text-[10px] text-text-soft">
          {rate?.rate}% s/ {rate?.base === 'TOTAL' ? 'total' : 'neto'}
          {edited && ` · calculado $ ${formatMoney(suggested)}`}
        </span>
      </span>
      <input
        type="number" step="0.01" min="0"
        value={tax.amount}
        onChange={(e) => onAmountChange(Number(e.target.value))}
        className="w-28 rounded border border-line bg-panel px-2 py-1 text-right font-mono text-sm focus:border-accent-deep focus:outline-none"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Quitar impuesto"
        className="text-text-soft transition-colors hover:text-danger"
      >
        <Trash2 size={15} />
      </button>
    </li>
  );
}
```

- [ ] **Step 3: Crear `PurchaseTotalsSummary`**

```typescript
// src/components/purchase/PurchaseTotalsSummary.tsx
import { AlertTriangle, Check } from 'lucide-react';
import { cn, formatMoney } from '@/src/lib/utils';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import type { PurchaseTotals } from '@/src/lib/purchases';

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={muted ? 'text-text-faint' : 'text-text-soft'}>{label}</dt>
      <dd className={cn('font-mono', muted ? 'text-text-faint' : 'text-text')}>
        {value < 0 ? '−' : ''}$ {formatMoney(Math.abs(value))}
      </dd>
    </div>
  );
}

/**
 * Panel de totales de un comprobante de compra: bonificación general, el
 * desglose por alícuota, y el control cruzado contra el total impreso en
 * el papel. Compartido entre la carga manual y la revisión de IA.
 */
export function PurchaseTotalsSummary({
  totals,
  generalDiscount,
  onGeneralDiscountChange,
  declaredTotal,
  onDeclaredTotalChange,
}: {
  totals: PurchaseTotals;
  generalDiscount: string;
  onGeneralDiscountChange: (value: string) => void;
  declaredTotal: string;
  onDeclaredTotalChange: (value: string) => void;
}) {
  const declared = Number(declaredTotal);
  const declaredDiff =
    declaredTotal.trim() === '' || !Number.isFinite(declared)
      ? null
      : Math.round((declared - totals.total) * 100) / 100;

  return (
    <>
      <label className={cn(labelClass, 'mb-4 block sm:w-1/2')}>
        Bonificación general %
        <input
          type="number" step="0.01" min="0" max="100"
          value={generalDiscount}
          onChange={(e) => onGeneralDiscountChange(e.target.value)}
          className={cn(inputClass, 'font-mono')}
        />
      </label>

      <dl className="space-y-1 text-[13px]">
        <Row label="Bruto" value={totals.gross} />
        {totals.lineDiscount > 0 && (
          <Row label="Bonificación por renglón" value={-totals.lineDiscount} muted />
        )}
        {totals.generalDiscount > 0 && (
          <Row label={`Bonificación general ${generalDiscount}%`} value={-totals.generalDiscount} muted />
        )}

        <div className="my-2 border-t border-line" />

        {totals.vatByRate.map((entry) => (
          <Row key={entry.rate} label={`Neto gravado ${entry.rate}%`} value={entry.net} />
        ))}
        {totals.netExempt > 0 && <Row label="Neto exento" value={totals.netExempt} />}
        {totals.netUntaxed > 0 && <Row label="Neto no gravado" value={totals.netUntaxed} />}
        {totals.vatByRate.map((entry) => (
          <Row key={`iva-${entry.rate}`} label={`IVA ${entry.rate}%`} value={entry.vat} />
        ))}
        {totals.otherTaxes > 0 && <Row label="Percepciones e impuestos" value={totals.otherTaxes} />}

        <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</dt>
          <dd className="font-display text-2xl font-medium text-text">$ {formatMoney(totals.total)}</dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-line pt-3">
        <label className={labelClass}>
          Total del comprobante (control)
          <input
            type="number" step="0.01" min="0"
            value={declaredTotal}
            onChange={(e) => onDeclaredTotalChange(e.target.value)}
            placeholder="Tipeá el total que figura en el papel"
            className={cn(
              inputClass, 'font-mono',
              declaredDiff !== null && declaredDiff !== 0 && 'border-danger bg-danger-soft'
            )}
          />
        </label>
        {declaredDiff !== null && (
          <p
            className={cn(
              'mt-1.5 flex items-center gap-1.5 text-xs',
              declaredDiff === 0 ? 'text-state-done' : 'text-danger'
            )}
          >
            {declaredDiff === 0 ? <Check size={14} /> : <AlertTriangle size={14} />}
            {declaredDiff === 0
              ? 'Coincide con el comprobante.'
              : `Difiere en $ ${formatMoney(Math.abs(declaredDiff))}. Revisá los renglones o el pie.`}
          </p>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Reescribir `PurchaseNew.tsx` para usar los tres componentes**

Reemplazar en `src/pages/PurchaseNew.tsx`:
- El `import` agrega: `import { PurchaseItemRow } from '@/src/components/purchase/PurchaseItemRow';`, `import { PurchaseTaxRow } from '@/src/components/purchase/PurchaseTaxRow';`, `import { PurchaseTotalsSummary } from '@/src/components/purchase/PurchaseTotalsSummary';`.
- El bloque `{lines.map((line, idx) => { const net = ...; return (<tr>...);})}` (líneas 489-585) se reemplaza por:

```tsx
{lines.map((line, idx) => (
  <PurchaseItemRow
    key={idx}
    line={line}
    idx={idx}
    isArticles={isArticles}
    concepts={concepts}
    vatRates={vatRates}
    onPatch={(patch) => patchLine(idx, patch)}
    onRemove={() => setLines((current) => current.filter((_, i) => i !== idx))}
  />
))}
```
- El bloque `{footTaxes.map((tax, idx) => { const rate = ...; const suggested = ...; const edited = ...; return (<li>...);})}` (líneas 652-685) se reemplaza por:

```tsx
{footTaxes.map((tax, idx) => (
  <PurchaseTaxRow
    key={tax.taxRateId}
    tax={tax}
    rate={footRates.find((r) => r.id === tax.taxRateId)}
    suggested={(() => {
      const rate = footRates.find((r) => r.id === tax.taxRateId);
      return rate ? suggestedTaxAmount(rate, totals) : 0;
    })()}
    onAmountChange={(amount) =>
      setFootTaxes((current) => current.map((t, i) => (i === idx ? { ...t, amount } : t)))
    }
    onRemove={() => setFootTaxes((current) => current.filter((_, i) => i !== idx))}
  />
))}
```
- El segundo `<Panel>` de "Totales" (línea 696-767, desde `<SectionHeader title="Totales" />` hasta el cierre de ese `Panel`) se reemplaza por:

```tsx
<Panel className="p-5">
  <SectionHeader title="Totales" />
  <PurchaseTotalsSummary
    totals={totals}
    generalDiscount={generalDiscount}
    onGeneralDiscountChange={setGeneralDiscount}
    declaredTotal={declaredTotal}
    onDeclaredTotalChange={setDeclaredTotal}
  />
</Panel>
```
- Borrar del final del archivo la función `Row` (línea 797-806, ahora vive en `PurchaseTotalsSummary.tsx`) y el import de `Check`/`AlertTriangle` de `lucide-react` si quedan sin otro uso en el archivo (`AlertTriangle` sigue usándose en el aviso de renglones/precio — línea 592, 600 — no se borra ese; `Check` solo se usaba en el control cruzado que ahora es del componente nuevo, si no queda otro uso se borra del import de la línea 2).

- [ ] **Step 5: Verificar**

Run: `npx tsc --noEmit && npm run build`
Expected: sin errores.

Probar manualmente `/compras/nueva/articulos` y `/compras/nueva/conceptos`: cargar un renglón, un impuesto del pie, ver que los totales calculan igual que antes — comportamiento idéntico al de antes de este refactor.

- [ ] **Step 6: Commit**

```bash
git add src/components/purchase/ src/pages/PurchaseNew.tsx
git commit -m "Extraer PurchaseItemRow/PurchaseTaxRow/PurchaseTotalsSummary de PurchaseNew"
```

---

### Task 5: `src/lib/purchaseExtractions.ts`

**Files:**
- Create: `src/lib/purchaseExtractions.ts`

**Interfaces:**
- Consumes: bucket `purchase-invoice-drafts` y tabla `purchase_invoice_extractions` (Task 1); Edge Function `extraer-factura-compra` (Task 6, invocada acá — puede escribirse antes de que la función exista, como en cualquier cliente-antes-que-servidor).
- Produces: `type PurchaseExtractionStatus`, `interface PurchaseExtraction`, `uploadPurchaseInvoiceDraft(file: File): Promise<{ storagePath: string; mimeType: string }>`, `requestExtraction(params: { storagePath: string; mimeType: string; kind: PurchaseKind }): Promise<{ id: string }>`, `fetchExtractionById(id: string): Promise<PurchaseExtraction | null>`, `fetchPendingExtractions(): Promise<PurchaseExtraction[]>`, `confirmExtraction(id: string, purchaseInvoiceId: string): Promise<void>`, `discardExtraction(id: string): Promise<void>`, `getDraftAttachmentUrl(storagePath: string): Promise<string>`, `describeExtractionError(message: string): string`.

- [ ] **Step 1: Escribir el archivo**

```typescript
// src/lib/purchaseExtractions.ts
import { supabase } from '@/src/lib/supabase';
import type { PurchaseKind } from '@/src/lib/purchases';

/**
 * Borrador de una factura de compra leída por IA: desde que se sube el
 * archivo hasta que se confirma como comprobante real (o se descarta). El
 * archivo vive en el bucket privado purchase-invoice-drafts; el resultado
 * crudo de Gemini (valores + confianza por campo) en raw_extraction.
 */
const BUCKET = 'purchase-invoice-drafts';

export type PurchaseExtractionStatus = 'EXTRAIDO' | 'CONFIRMADO' | 'DESCARTADO' | 'ERROR';

/** Forma cruda que devuelve la Edge Function (ver Task 6) — sin tipar campo
 *  por campo acá: la pantalla de revisión (Task 9) es la que interpreta
 *  valores/confianzas/renglones según el kind. */
export type RawExtraction = Record<string, unknown>;

export interface PurchaseExtraction {
  id: string;
  kind: PurchaseKind;
  supplierId: string | null;
  attachmentStoragePath: string;
  attachmentMimeType: string;
  rawExtraction: RawExtraction | null;
  status: PurchaseExtractionStatus;
  errorMessage: string | null;
  purchaseInvoiceId: string | null;
  createdAt: string;
}

const SELECT =
  'id, kind, supplier_id, attachment_storage_path, attachment_mime_type, raw_extraction, status, error_message, purchase_invoice_id, created_at';

function mapExtraction(row: any): PurchaseExtraction {
  return {
    id: row.id,
    kind: row.kind,
    supplierId: row.supplier_id,
    attachmentStoragePath: row.attachment_storage_path,
    attachmentMimeType: row.attachment_mime_type,
    rawExtraction: row.raw_extraction,
    status: row.status,
    errorMessage: row.error_message,
    purchaseInvoiceId: row.purchase_invoice_id,
    createdAt: row.created_at,
  };
}

/** Sube el PDF/foto al bucket de borradores. La Edge Function lo lee después con la service key. */
export async function uploadPurchaseInvoiceDraft(
  file: File
): Promise<{ storagePath: string; mimeType: string }> {
  const ext = file.name.split('.').pop() || (file.type === 'application/pdf' ? 'pdf' : 'jpg');
  const path = `${crypto.randomUUID()}.${ext}`;
  const mimeType = file.type || (ext === 'pdf' ? 'application/pdf' : 'image/jpeg');

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: mimeType });
  if (error) throw error;

  return { storagePath: path, mimeType };
}

async function describeFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error) return String(body.error);
    } catch {
      // El cuerpo no era JSON: se sigue con el mensaje genérico de abajo.
    }
  }
  return error instanceof Error ? error.message : 'No se pudo leer la factura con IA.';
}

/** Llama a la Edge Function que lee el archivo con Gemini y arma el borrador. */
export async function requestExtraction(params: {
  storagePath: string;
  mimeType: string;
  kind: PurchaseKind;
}): Promise<{ id: string }> {
  const { data, error } = await supabase.functions.invoke('extraer-factura-compra', {
    body: {
      attachment_storage_path: params.storagePath,
      mime_type: params.mimeType,
      kind: params.kind,
    },
  });
  if (error) throw new Error(await describeFunctionError(error));
  if (!data?.id) throw new Error('La función no devolvió el borrador leído.');
  return { id: data.id };
}

export async function fetchExtractionById(id: string): Promise<PurchaseExtraction | null> {
  const { data, error } = await supabase.from('purchase_invoice_extractions').select(SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapExtraction(data) : null;
}

/** Borradores leídos por IA que todavía no se confirmaron ni descartaron. */
export async function fetchPendingExtractions(): Promise<PurchaseExtraction[]> {
  const { data, error } = await supabase
    .from('purchase_invoice_extractions')
    .select(SELECT)
    .eq('status', 'EXTRAIDO')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapExtraction);
}

/** Marca el borrador confirmado, ligado al comprobante recién guardado con savePurchaseInvoice. */
export async function confirmExtraction(id: string, purchaseInvoiceId: string): Promise<void> {
  const { error } = await supabase
    .from('purchase_invoice_extractions')
    .update({ status: 'CONFIRMADO', purchase_invoice_id: purchaseInvoiceId })
    .eq('id', id);
  if (error) throw error;
}

export async function discardExtraction(id: string): Promise<void> {
  const { error } = await supabase
    .from('purchase_invoice_extractions')
    .update({ status: 'DESCARTADO' })
    .eq('id', id);
  if (error) throw error;
}

/** El bucket es privado: se muestra con una URL firmada, nunca con getPublicUrl. */
export async function getDraftAttachmentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

export function describeExtractionError(message: string): string {
  if (message.includes('schema cache') || message.includes('does not exist')) {
    return 'Falta aplicar la migración de facturas con IA en la base (supabase/purchase-invoice-extractions.sql).';
  }
  return message;
}
```

- [ ] **Step 2: Verificar**

Run: `npx tsc --noEmit`
Expected: sin errores (la Edge Function todavía no existe, pero `supabase.functions.invoke` no depende de que exista para compilar).

- [ ] **Step 3: Commit**

```bash
git add src/lib/purchaseExtractions.ts
git commit -m "Compras con IA: lib de borradores de extracción"
```

---

### Task 6: Edge Function `extraer-factura-compra`

**Files:**
- Create: `supabase/functions/extraer-factura-compra/index.ts`

**Interfaces:**
- Consumes: bucket `purchase-invoice-drafts` y tabla `purchase_invoice_extractions` (Task 1); tabla `company_settings` (`select * from company_settings where id = true`, existente); tabla `suppliers` (existente, columna `tax_id`); tabla `article_suppliers` (existente, `supplier_id` + `supplier_code`, índice único `(supplier_id, upper(supplier_code))`); secreto `GEMINI_API_KEY` (a crear).
- Produces: endpoint POST que recibe `{ attachment_storage_path, mime_type, kind }` con header `Authorization: Bearer <jwt del admin>`, devuelve `{ id }` (id de `purchase_invoice_extractions`) o `{ error }`.

- [ ] **Step 1: Chequeo rápido de la versión del SDK contra el `.d.ts` instalado**

`responseSchema` (con el enum `Type` de `@google/genai`) es el campo confirmado de `GenerateContentConfig` para structured output — es el que usa el código de abajo. Antes de desplegar, correr una vez para blindarse contra drift de versión:

```bash
grep -n "responseSchema" node_modules/@google/genai/dist/*.d.ts | head -5
```

Si no aparece nada (versión distinta a la `^2.4.0` declarada), revisar el changelog del paquete antes de continuar — no asumir, ajustar el Step 3 al nombre real.

**Resultado de la Task 2 (ya corrida):** el schema de ARTICULOS (el más grande de los dos, con el array de renglones) compiló sin errores en un llamado real contra Gemini — no hizo falta partir en dos pasadas. El modelo usado en el Step 3 de abajo es `gemini-3.5-flash`, no `gemini-3.7-flash` como decía la primera versión de este plan: al momento de correr la Task 2, `gemini-3.7-flash`, `gemini-3.6-flash` y `gemini-flash-latest` devolvían 503 "high demand" (modelos válidos, solo saturados), mientras que `gemini-3.5-flash` y `gemini-3-flash-preview` respondían bien. Si para cuando se ejecute la Task 6 los modelos más nuevos ya no están saturados, es una mejora opcional cambiar el nombre del modelo — no un requisito.

- [ ] **Step 2: Configurar el secreto**

```bash
supabase secrets set GEMINI_API_KEY=<la key real> --project-ref mnoqdqjhsylohlvuekfh
```

- [ ] **Step 3: Escribir la función**

```typescript
// supabase/functions/extraer-factura-compra/index.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { GoogleGenAI, Type } from 'npm:@google/genai@2.4.0';

/*
  Lee una factura de compra (PDF o foto) con Gemini y arma un borrador en
  purchase_invoice_extractions. No escribe nada en purchase_invoices — eso
  pasa recién cuando el usuario confirma desde la pantalla de revisión, por
  la misma RPC save_purchase_invoice de siempre.

  Mismo patrón de autorización que gestionar-empleado: la API key de Gemini
  vive acá, nunca en el navegador, y solo un admin con sesión puede pedir
  una extracción.
*/

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const BUCKET = 'purchase-invoice-drafts';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

type Autorizacion = { estado: 'admin'; userId: string } | { estado: 'sin-sesion' | 'sin-permiso' };

async function verificarAdmin(req: Request): Promise<Autorizacion> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!token) return { estado: 'sin-sesion' };

  const { data: { user }, error: errorUsuario } = await db.auth.getUser(token);
  if (errorUsuario || !user) return { estado: 'sin-sesion' };

  const { data: perfil, error: errorPerfil } = await db
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (errorPerfil || !perfil) return { estado: 'sin-sesion' };
  return perfil.role === 'admin' ? { estado: 'admin', userId: user.id } : { estado: 'sin-permiso' };
}

// ── Schemas de structured output. Ver Task 2 sobre por qué están armados así
// (cadena vacía en vez de null para "no figura"; confianza como objeto
// paralelo a valores, no anidada campo por campo).

const HEADER_FIELDS = [
  'proveedor_cuit', 'proveedor_razon_social', 'tipo_comprobante', 'letra',
  'punto_venta', 'numero', 'fecha_comprobante', 'condicion_pago', 'total',
];

function headerSchema() {
  const stringProps = Object.fromEntries(HEADER_FIELDS.map((f) => [f, { type: Type.STRING }]));
  const numberProps = Object.fromEntries(HEADER_FIELDS.map((f) => [f, { type: Type.NUMBER }]));
  return {
    valores: { type: Type.OBJECT, properties: stringProps, required: HEADER_FIELDS },
    confianzas: { type: Type.OBJECT, properties: numberProps, required: HEADER_FIELDS },
    percepciones: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { nombre: { type: Type.STRING }, importe: { type: Type.STRING } },
        required: ['nombre', 'importe'],
      },
    },
  };
}

const ARTICULOS_ITEM_FIELDS = ['codigo', 'descripcion', 'cantidad', 'precio_unitario', 'bonificacion_porcentaje', 'alicuota_iva'];
const CONCEPTOS_ITEM_FIELDS = ['descripcion', 'importe', 'alicuota_iva'];

function schemaFor(kind: 'ARTICULOS' | 'CONCEPTOS') {
  const itemFields = kind === 'ARTICULOS' ? ARTICULOS_ITEM_FIELDS : CONCEPTOS_ITEM_FIELDS;
  const itemProps = Object.fromEntries(itemFields.map((f) => [f, { type: Type.STRING }]));
  return {
    type: Type.OBJECT,
    properties: {
      ...headerSchema(),
      renglones: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: { ...itemProps, confianza: { type: Type.NUMBER } },
          required: [...itemFields, 'confianza'],
        },
      },
    },
    required: ['valores', 'confianzas', 'percepciones', 'renglones'],
  };
}

function promptFor(kind: 'ARTICULOS' | 'CONCEPTOS', ownTaxId: string | null): string {
  const base = `
Sos un asistente que lee facturas de compra de un taller de inyección diesel
en Argentina y extrae sus datos en JSON, siguiendo exactamente el schema
provisto.

Reglas:
- Los importes se transcriben TAL COMO FIGURAN impresos, sin normalizar
  separadores decimales (no conviertas "1.234,56" a "1234.56": copialo tal
  cual como texto — el sistema que recibe esto hace su propia conversión).
- Si un campo no figura en el comprobante, devolvé cadena vacía "" — nunca
  inventes un valor.
- El CUIT del EMISOR de la factura es el del PROVEEDOR, no el nuestro.
  ${ownTaxId ? `Nuestro CUIT (el del taller que RECIBE la factura, nunca el proveedor) es ${ownTaxId}.` : ''}
- tipo_comprobante tiene que ser exactamente uno de: FACTURA, NOTA_CREDITO, NOTA_DEBITO.
- letra tiene que ser exactamente una de: A, B, C, M.
- alicuota_iva por renglón: el número de la alícuota (ej. "21", "10.5", "0"), sin el símbolo %.
- confianza (0 a 1): qué tan seguro estás de haber leído bien ese campo/renglón. 1 = perfectamente legible, 0.5 = dudoso, 0 = adivinado.
`.trim();

  if (kind === 'ARTICULOS') {
    return `${base}\n\nEsta factura es de artículos/repuestos: cada renglón tiene un código de producto del proveedor (columna "código", "art.", "cód. prov." o similar) — extraelo tal como está impreso en "codigo". Si un renglón no tiene código visible, dejalo en "".`;
  }
  return `${base}\n\nEsta factura es de conceptos/gastos (fletes, servicios, honorarios): no tiene códigos de artículo, solo descripción e importe por renglón.`;
}

interface ExtractedHeader {
  valores: Record<string, string>;
  confianzas: Record<string, number>;
  percepciones: { nombre: string; importe: string }[];
  renglones: Record<string, string | number>[];
}

/** Tolerante a propósito: nunca lanza por un campo raro, solo si el JSON no parsea. */
function parseExtraction(text: string): ExtractedHeader {
  const parsed = JSON.parse(text);
  return {
    valores: parsed.valores ?? {},
    confianzas: parsed.confianzas ?? {},
    percepciones: Array.isArray(parsed.percepciones) ? parsed.percepciones : [],
    renglones: Array.isArray(parsed.renglones) ? parsed.renglones : [],
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  const autorizacion = await verificarAdmin(req);
  if (autorizacion.estado === 'sin-sesion') return json({ error: 'No autorizado.' }, 401);
  if (autorizacion.estado === 'sin-permiso') return json({ error: 'No autorizado.' }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Cuerpo inválido: se esperaba JSON.' }, 400);
  }

  const storagePath = String(body.attachment_storage_path ?? '');
  const mimeType = String(body.mime_type ?? '');
  const kind = body.kind === 'ARTICULOS' ? 'ARTICULOS' : body.kind === 'CONCEPTOS' ? 'CONCEPTOS' : null;
  if (!storagePath || !mimeType || !kind) {
    return json({ error: 'Faltan attachment_storage_path, mime_type o kind.' }, 400);
  }

  // Crea el borrador ya, en estado EXTRAIDO por default — si algo falla más
  // abajo, se actualiza a ERROR en vez de dejarlo sin fila.
  const { data: draft, error: errorDraft } = await db
    .from('purchase_invoice_extractions')
    .insert({
      kind,
      attachment_storage_path: storagePath,
      attachment_mime_type: mimeType,
      status: 'EXTRAIDO',
      created_by: autorizacion.userId,
    })
    .select('id')
    .single();

  if (errorDraft || !draft) {
    return json({ error: `No se pudo crear el borrador: ${errorDraft?.message}` }, 500);
  }

  async function marcarError(mensaje: string): Promise<Response> {
    await db.from('purchase_invoice_extractions').update({ status: 'ERROR', error_message: mensaje }).eq('id', draft.id);
    return json({ id: draft.id, error: mensaje }, 200); // 200: el borrador existe, el cliente lee su status ERROR
  }

  const { data: fileData, error: errorDescarga } = await db.storage.from(BUCKET).download(storagePath);
  if (errorDescarga || !fileData) {
    return marcarError(`No se pudo leer el archivo subido: ${errorDescarga?.message}`);
  }

  const { data: company } = await db.from('company_settings').select('tax_id').eq('id', true).maybeSingle();
  const ownTaxId = company?.tax_id ?? null;

  const base64 = btoa(String.fromCharCode(...new Uint8Array(await fileData.arrayBuffer())));

  let respuesta;
  try {
    respuesta = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        { text: 'Extraé los datos de este comprobante según el schema.' },
        { inlineData: { mimeType, data: base64 } },
      ],
      config: {
        systemInstruction: promptFor(kind, ownTaxId),
        responseMimeType: 'application/json',
        responseSchema: schemaFor(kind),
      },
    });
  } catch (err) {
    return marcarError(`Gemini no pudo leer el comprobante: ${err instanceof Error ? err.message : String(err)}`);
  }

  let extraccion: ExtractedHeader;
  try {
    extraccion = parseExtraction(respuesta.text ?? '');
  } catch {
    return marcarError('La respuesta de Gemini no vino en un JSON legible.');
  }

  // ── Matcheo de proveedor por CUIT exacto.
  const cuitLimpio = (extraccion.valores.proveedor_cuit ?? '').replace(/\D/g, '');
  let supplierId: string | null = null;
  if (cuitLimpio) {
    const { data: supplier } = await db.from('suppliers').select('id').eq('tax_id', cuitLimpio).maybeSingle();
    supplierId = supplier?.id ?? null;
  }

  // ── Matcheo de renglones por código exacto de proveedor (solo ARTICULOS).
  let renglonesConMatch = extraccion.renglones;
  if (kind === 'ARTICULOS' && supplierId) {
    renglonesConMatch = await Promise.all(
      extraccion.renglones.map(async (renglon) => {
        const codigo = String(renglon.codigo ?? '').trim();
        if (!codigo) return { ...renglon, article_id: null };
        const { data: match } = await db
          .from('article_suppliers')
          .select('article_id')
          .eq('supplier_id', supplierId)
          .ilike('supplier_code', codigo)
          .maybeSingle();
        return { ...renglon, article_id: match?.article_id ?? null };
      })
    );
  } else if (kind === 'ARTICULOS') {
    renglonesConMatch = extraccion.renglones.map((r) => ({ ...r, article_id: null }));
  }

  const { error: errorUpdate } = await db
    .from('purchase_invoice_extractions')
    .update({
      supplier_id: supplierId,
      raw_extraction: { ...extraccion, renglones: renglonesConMatch },
      status: 'EXTRAIDO',
    })
    .eq('id', draft.id);

  if (errorUpdate) {
    return json({ error: `No se pudo guardar la lectura: ${errorUpdate.message}` }, 500);
  }

  return json({ id: draft.id });
});
```

- [ ] **Step 4: Desplegar**

Usar la herramienta de Supabase del entorno (`deploy_edge_function`, proyecto `mnoqdqjhsylohlvuekfh`), confirmando con el usuario antes.

- [ ] **Step 5: Probar con una factura real**

Desde el navegador (una vez que exista al menos la subida del Task 8, o con `curl` autenticado como admin si esa tarea todavía no está), subir una factura real de un proveedor cargado, con CUIT y al menos un renglón con código conocido en `article_suppliers`, y verificar:

```sql
select kind, supplier_id, status, error_message, raw_extraction
from purchase_invoice_extractions order by created_at desc limit 1;
```

Esperado: `status = 'EXTRAIDO'`, `supplier_id` resuelto si el CUIT coincide con un proveedor cargado, `raw_extraction.renglones` con al menos un `article_id` no nulo si el código coincidía.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/extraer-factura-compra/
git commit -m "Edge Function: extraer datos de una factura de compra con Gemini"
```

---

**Nota sobre menú y rutas:** no hay un task aparte para esto — `App.tsx` no compila hasta que las tres páginas existen, así que cada página registra su propia ruta al final de la tarea que la crea: Task 8 agrega las rutas de `PurchaseAIHome`/`PurchaseAIUpload`, y Task 9 agrega la de `PurchaseAIReview` junto con la tarjeta de menú (recién ahí las tres páginas existen y el menú puede apuntar a algo real). El código exacto de ambos archivos está en los Steps finales de esas dos tareas.

---

### Task 8: Páginas de aterrizaje y subida (`/compras-ia`, `/compras-ia/nueva/:kind`)

**Files:**
- Create: `src/pages/PurchaseAIHome.tsx`
- Create: `src/pages/PurchaseAIUpload.tsx`
- Modify: `src/App.tsx` (agregar import + 2 rutas, código en el Step 3 de esta misma tarea)

**Interfaces:**
- Consumes: `fetchPendingExtractions`, `uploadPurchaseInvoiceDraft`, `requestExtraction`, `describeExtractionError` (Task 5).
- Produces: navegación a `/compras-ia/revisar/:id` (Task 9) al terminar de subir.

- [ ] **Step 1: `PurchaseAIHome.tsx` — landing con borradores pendientes**

```typescript
// src/pages/PurchaseAIHome.tsx
import React from 'react';
import { Sparkles, Package, FileText } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  fetchPendingExtractions,
  describeExtractionError,
  type PurchaseExtraction,
} from '@/src/lib/purchaseExtractions';

/**
 * Punto de entrada de la carga de facturas de compra con IA — separado a
 * propósito de la carga manual (Compras): dos métodos disponibles, el
 * operador elige el que conviene por factura.
 */
export function PurchaseAIHome() {
  const { role } = useAuth();
  const [pending, setPending] = React.useState<PurchaseExtraction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    fetchPendingExtractions()
      .then(setPending)
      .catch((err) => setError(describeExtractionError(getErrorMessage(err))))
      .finally(() => setLoading(false));
  }, [role]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Compras con IA"
        subtitle="Subí el PDF o una foto de la factura del proveedor y revisá lo que Gemini leyó antes de guardar."
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link to="/compras-ia/nueva/articulos">
          <Panel className="flex items-center gap-3 p-5 transition-colors hover:border-accent-deep">
            <Package size={22} className="text-accent-deep" />
            <div>
              <p className="font-semibold text-text">Factura de artículos</p>
              <p className="text-xs text-text-soft">Repuestos del catálogo. Actualiza stock y precio de compra.</p>
            </div>
          </Panel>
        </Link>
        <Link to="/compras-ia/nueva/conceptos">
          <Panel className="flex items-center gap-3 p-5 transition-colors hover:border-accent-deep">
            <FileText size={22} className="text-accent-deep" />
            <div>
              <p className="font-semibold text-text">Factura de conceptos</p>
              <p className="text-xs text-text-soft">Gastos sin stock: fletes, servicios, honorarios.</p>
            </div>
          </Panel>
        </Link>
      </div>

      <Panel className="p-5">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
          <Sparkles size={14} /> Leídas por IA sin confirmar {pending.length > 0 && `(${pending.length})`}
        </h2>
        {loading ? (
          <p className="text-sm text-text-soft">Cargando…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-text-soft">No hay borradores pendientes de revisar.</p>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((draft) => (
              <li key={draft.id}>
                <Link
                  to={`/compras-ia/revisar/${draft.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm hover:text-accent-deep"
                >
                  <span>
                    {draft.kind === 'ARTICULOS' ? 'Artículos' : 'Conceptos'} · leída el {formatDate(draft.createdAt)}
                  </span>
                  <Button variant="ghost" type="button" className="pointer-events-none px-3">
                    Revisar
                  </Button>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 2: `PurchaseAIUpload.tsx` — elegir archivo y pedir la extracción**

```typescript
// src/pages/PurchaseAIUpload.tsx
import React from 'react';
import { Sparkles, XCircle } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import type { PurchaseKind } from '@/src/lib/purchases';
import {
  describeExtractionError,
  requestExtraction,
  uploadPurchaseInvoiceDraft,
} from '@/src/lib/purchaseExtractions';

/** Paso 1 de la carga con IA: elegir el archivo y esperar a que Gemini lo lea. */
export function PurchaseAIUpload() {
  const { role } = useAuth();
  const { kind: kindParam } = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const kind: PurchaseKind = kindParam === 'articulos' ? 'ARTICULOS' : 'CONCEPTOS';

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (kindParam !== 'articulos' && kindParam !== 'conceptos') {
    return <Navigate to="/compras-ia" replace />;
  }

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { storagePath, mimeType } = await uploadPurchaseInvoiceDraft(file);
      const { id } = await requestExtraction({ storagePath, mimeType, kind });
      navigate(`/compras-ia/revisar/${id}`);
    } catch (err) {
      setError(describeExtractionError(getErrorMessage(err)));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={kind === 'ARTICULOS' ? 'Factura de artículos — con IA' : 'Factura de conceptos — con IA'}
        actions={
          <Link to="/compras-ia">
            <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
          </Link>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="flex flex-col items-center gap-4 p-10 text-center">
        {busy ? (
          <>
            <Sparkles size={32} className="animate-pulse text-accent-deep" />
            <p className="text-sm text-text-soft">Leyendo la factura con IA…</p>
          </>
        ) : (
          <>
            <Sparkles size={32} className="text-accent-deep" />
            <p className="text-sm text-text-soft">Subí el PDF de la factura, o sacale una foto con el celular.</p>
            <label className="cursor-pointer rounded-md bg-accent px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-accent-ink hover:bg-accent-deep">
              Elegir archivo
              <input
                type="file"
                accept="application/pdf,image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
            </label>
          </>
        )}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 3: Agregar las rutas de estas dos páginas**

En `src/App.tsx`:

```typescript
import { PurchaseAIHome } from './pages/PurchaseAIHome';
import { PurchaseAIUpload } from './pages/PurchaseAIUpload';
```

```tsx
<Route path="/compras-ia" element={<PurchaseAIHome />} />
<Route path="/compras-ia/nueva/:kind" element={<PurchaseAIUpload />} />
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos relacionados a estos dos archivos (puede seguir faltando `PurchaseAIReview`, de la Task 9).

- [ ] **Step 5: Commit**

```bash
git add src/pages/PurchaseAIHome.tsx src/pages/PurchaseAIUpload.tsx src/App.tsx
git commit -m "Compras con IA: landing y subida de factura (páginas separadas de la carga manual)"
```

---

### Task 9: Página de revisión (`/compras-ia/revisar/:id`)

**Files:**
- Create: `src/pages/PurchaseAIReview.tsx`
- Modify: `src/App.tsx` (import + ruta)
- Modify: `src/lib/menuCategories.ts` (tarjeta de menú, código en el Step 3 de esta misma tarea)

**Interfaces:**
- Consumes: `PurchaseItemRow`, `PurchaseTaxRow`, `PurchaseTotalsSummary` (Task 4); `fetchExtractionById`, `getDraftAttachmentUrl`, `confirmExtraction`, `discardExtraction`, `describeExtractionError` (Task 5); `SupplierModal` (Task 3); `computePurchaseTotals`, `savePurchaseInvoice`, `describePurchaseError`, `proposeDueDate`, tipos `PurchaseLine`/`PurchaseFootTax`/`PurchaseDocType`/`PurchaseLetter` (`src/lib/purchases.ts`, sin cambios); `PurchaseArticlePicker` (existente, sin cambios).

- [ ] **Step 1: Escribir la página**

Reutiliza casi todo el estado y los cálculos de `PurchaseNew.tsx` (mismo `computePurchaseTotals`, misma validación `canSave`), pero la carga inicial de `lines`/encabezado sale del borrador en vez de arrancar vacía, y suma: chip de confianza, visor del archivo original, resaltado de renglones sin matchear, y alta rápida de proveedor si el CUIT no matcheó con ninguno cargado.

```typescript
// src/pages/PurchaseAIReview.tsx
import React from 'react';
import { Plus, Save, XCircle, AlertTriangle, Package, Trash2 } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { cn, formatMoney, todayLocal } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel, SectionHeader } from '@/src/components/ui';
import { labelClass, inputClass } from '@/src/components/FiscalFields';
import { PurchaseArticlePicker } from '@/src/components/PurchaseArticlePicker';
import { PurchaseItemRow } from '@/src/components/purchase/PurchaseItemRow';
import { PurchaseTaxRow } from '@/src/components/purchase/PurchaseTaxRow';
import { PurchaseTotalsSummary } from '@/src/components/purchase/PurchaseTotalsSummary';
import { SupplierModal } from '@/src/components/SupplierModal';
import { formatCuit } from '@/src/lib/fiscal';
import { getErrorMessage } from '@/src/lib/workOrders';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { fetchExpenseConcepts, type ExpenseConcept } from '@/src/lib/expenseConcepts';
import { fetchArticles, type Article } from '@/src/lib/articles';
import { fetchTaxRates, type TaxRate } from '@/src/lib/taxRates';
import {
  computePurchaseTotals,
  describePurchaseError,
  proposeDueDate,
  savePurchaseInvoice,
  suggestedTaxAmount,
  type PurchaseDocType,
  type PurchaseFootTax,
  type PurchaseLetter,
  type PurchaseLine,
} from '@/src/lib/purchases';
import {
  confirmExtraction,
  describeExtractionError,
  discardExtraction,
  fetchExtractionById,
  getDraftAttachmentUrl,
  requestExtraction,
  type PurchaseExtraction,
} from '@/src/lib/purchaseExtractions';

const EMPTY_LINE: PurchaseLine = {
  articleId: null, conceptId: null, code: '', description: '',
  quantity: 1, unitPrice: 0, discountPercent: 0, vatRateId: '',
};

/** Confianza 0..1 -> semáforo. Mismo criterio que PH_FAC. */
function ConfidenceChip({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  const color = value >= 0.8 ? 'text-state-done' : value >= 0.5 ? 'text-state-wait' : 'text-danger';
  return <span className={cn('ml-1.5 font-mono text-[10px]', color)}>{Math.round(value * 100)}%</span>;
}

function parseArgNumber(text: string): number {
  // El importe viene tal como está impreso: puede traer "." de miles y "," decimal, o al revés.
  const cleaned = text.trim();
  if (!cleaned) return 0;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned.replace(/[.,]/g, '');
  }
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

export function PurchaseAIReview() {
  const { role } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();

  const [draft, setDraft] = React.useState<PurchaseExtraction | null>(null);
  const [attachmentUrl, setAttachmentUrl] = React.useState<string | null>(null);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [concepts, setConcepts] = React.useState<ExpenseConcept[]>([]);
  const [articles, setArticles] = React.useState<Article[]>([]);
  const [rates, setRates] = React.useState<TaxRate[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showPicker, setShowPicker] = React.useState(false);
  const [showNewSupplier, setShowNewSupplier] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);

  const [supplierId, setSupplierId] = React.useState('');
  const [docType, setDocType] = React.useState<PurchaseDocType>('FACTURA');
  const [letter, setLetter] = React.useState<PurchaseLetter>('A');
  const [salesPoint, setSalesPoint] = React.useState('');
  const [number, setNumber] = React.useState('');
  const [issueDate, setIssueDate] = React.useState(todayLocal());
  const [receivedDate, setReceivedDate] = React.useState(todayLocal());
  const [dueDate, setDueDate] = React.useState('');
  const [lines, setLines] = React.useState<PurchaseLine[]>([]);
  const [generalDiscount, setGeneralDiscount] = React.useState('0');
  const [footTaxes, setFootTaxes] = React.useState<PurchaseFootTax[]>([]);
  const [notes, setNotes] = React.useState('');

  const isArticles = draft?.kind === 'ARTICULOS';

  React.useEffect(() => {
    if (role !== 'admin' || !id) return;
    let cancelled = false;

    Promise.all([fetchExtractionById(id), fetchSuppliers(true), fetchTaxRates(true)])
      .then(async ([d, s, r]) => {
        if (cancelled || !d) return;
        setDraft(d);
        setSuppliers(s);
        setRates(r);
        if (d.kind === 'ARTICULOS') setArticles(await fetchArticles(false));
        else setConcepts(await fetchExpenseConcepts(true));

        setAttachmentUrl(await getDraftAttachmentUrl(d.attachmentStoragePath));

        // Precarga desde lo que leyó la IA.
        const raw = (d.rawExtraction ?? {}) as any;
        const v = raw.valores ?? {};
        if (d.supplierId) setSupplierId(d.supplierId);
        if (v.tipo_comprobante === 'NOTA_CREDITO' || v.tipo_comprobante === 'NOTA_DEBITO') setDocType(v.tipo_comprobante);
        if (['A', 'B', 'C', 'M'].includes(v.letra)) setLetter(v.letra);
        if (v.punto_venta) setSalesPoint(String(Number(v.punto_venta.replace(/\D/g, '')) || ''));
        if (v.numero) setNumber(String(Number(v.numero.replace(/\D/g, '')) || ''));
        setNotes(v.condicion_pago ? `Condición de pago (IA): ${v.condicion_pago}` : '');

        const rateByPercent = new Map(r.filter((rate) => rate.kind === 'IVA').map((rate) => [rate.rate, rate]));
        const draftLines: PurchaseLine[] = (raw.renglones ?? []).map((row: any) => {
          const alicuota = Number(String(row.alicuota_iva ?? '').replace(',', '.')) || 0;
          const vatRate = rateByPercent.get(alicuota);
          return {
            articleId: row.article_id ?? null,
            conceptId: null,
            code: String(row.codigo ?? ''),
            description: String(row.descripcion ?? ''),
            quantity: parseArgNumber(String(row.cantidad ?? '1')) || 1,
            unitPrice: parseArgNumber(String(row.precio_unitario ?? '0')),
            discountPercent: parseArgNumber(String(row.bonificacion_porcentaje ?? '0')),
            vatRateId: vatRate?.id ?? '',
          };
        });
        setLines(draftLines.length > 0 ? draftLines : [{ ...EMPTY_LINE }]);
      })
      .catch((err) => !cancelled && setError(describeExtractionError(getErrorMessage(err))))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [role, id]);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
  const vatRates = React.useMemo(() => rates.filter((r) => r.kind === 'IVA'), [rates]);
  const footRates = React.useMemo(
    () => rates.filter((r) => r.kind === 'PERCEPCION' || r.kind === 'IMPUESTO_INTERNO'),
    [rates]
  );

  React.useEffect(() => {
    if (!supplier || !issueDate) return;
    setDueDate((current) => current || proposeDueDate(issueDate, supplier.paymentTermsDays));
  }, [supplier, issueDate]);

  const totals = React.useMemo(
    () => computePurchaseTotals(lines, footTaxes, Number(generalDiscount) || 0, vatRates),
    [lines, footTaxes, generalDiscount, vatRates]
  );

  const confianzas = ((draft?.rawExtraction as any)?.confianzas ?? {}) as Record<string, number>;

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (loading) return <div className="mx-auto max-w-6xl p-8 text-center text-text-soft">Leyendo el borrador…</div>;
  if (!draft) return <div className="mx-auto max-w-6xl p-8 text-center text-danger">No se encontró esa lectura.</div>;

  if (draft.status === 'ERROR') {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <AlertTriangle size={28} className="mx-auto mb-3 text-danger" />
        <p className="mb-4 text-sm text-danger">{draft.errorMessage ?? 'No se pudo leer esta factura.'}</p>
        {error && <p className="mb-4 text-xs text-danger">{error}</p>}
        <div className="flex justify-center gap-2">
          <Link to="/compras-ia"><Button variant="ghost" type="button">Volver</Button></Link>
          <Button
            type="button"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              setError(null);
              try {
                // Mismo archivo ya subido, sin pedir que se vuelva a subir.
                const { id: newId } = await requestExtraction({
                  storagePath: draft.attachmentStoragePath,
                  mimeType: draft.attachmentMimeType,
                  kind: draft.kind,
                });
                await discardExtraction(draft.id);
                navigate(`/compras-ia/revisar/${newId}`);
              } catch (err) {
                setError(describeExtractionError(getErrorMessage(err)));
                setRetrying(false);
              }
            }}
          >
            {retrying ? 'Reintentando…' : 'Reintentar lectura'}
          </Button>
        </div>
      </div>
    );
  }

  function patchLine(index: number, patch: Partial<PurchaseLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addArticle(article: Article) {
    setLines((current) => [
      ...current,
      { ...EMPTY_LINE, articleId: article.id, code: article.code, description: article.description, unitPrice: article.purchasePrice ?? 0 },
    ]);
    setShowPicker(false);
  }

  function addFootTax(taxRateId: string) {
    if (!taxRateId || footTaxes.some((tax) => tax.taxRateId === taxRateId)) return;
    const rate = footRates.find((r) => r.id === taxRateId);
    if (!rate) return;
    setFootTaxes((current) => [...current, { taxRateId, amount: suggestedTaxAmount(rate, totals) }]);
  }

  const missingVat = lines.some((line) => !line.vatRateId);
  const missingDescription = lines.some((line) => line.description.trim() === '');
  const unmatchedArticleLines = isArticles ? lines.filter((line) => !line.articleId).length : 0;

  const canSave =
    !!supplierId && salesPoint.trim() !== '' && Number(number) > 0 && !!issueDate && !!dueDate &&
    lines.length > 0 && !missingVat && !missingDescription && totals.total > 0 &&
    unmatchedArticleLines === 0 && !saving;

  async function handleDiscard() {
    if (!window.confirm('¿Descartar esta lectura? No se puede deshacer.')) return;
    await discardExtraction(draft!.id);
    navigate('/compras-ia');
  }

  async function handleSave() {
    if (!canSave || !supplier || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await savePurchaseInvoice(
        {
          kind: draft.kind, docType, letter, salesPoint: Number(salesPoint), number: Number(number),
          supplierId, issueDate, receivedDate, dueDate, paymentTermsDays: supplier.paymentTermsDays,
          generalDiscountPercent: Number(generalDiscount) || 0, movesStock: docType === 'FACTURA', notes,
        },
        lines,
        footTaxes
      );
      await confirmExtraction(draft.id, saved.id);
      navigate(`/compra/${saved.id}`);
    } catch (err) {
      setError(describePurchaseError(getErrorMessage(err)));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={isArticles ? 'Revisar factura de artículos (IA)' : 'Revisar factura de conceptos (IA)'}
        subtitle="Cotejá contra el original. Los campos con chip de confianza los completó Gemini."
        actions={
          <>
            <Button variant="ghost" type="button" onClick={handleDiscard}><XCircle size={16} /> Descartar</Button>
            <Button onClick={handleSave} disabled={!canSave}>
              <Save size={16} /> {saving ? 'Guardando…' : 'Confirmar y guardar'}
            </Button>
          </>
        }
      />

      {error && <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel className="p-2">
          {attachmentUrl && draft.attachmentMimeType === 'application/pdf' ? (
            <embed src={attachmentUrl} type="application/pdf" className="h-[70vh] w-full" />
          ) : attachmentUrl ? (
            <img src={attachmentUrl} alt="Factura original" className="max-h-[70vh] w-full object-contain" />
          ) : null}
        </Panel>

        <div>
          <Panel className="mb-4 p-5">
            <SectionHeader title="Encabezado" />
            <div className="grid grid-cols-1 gap-3">
              <label className={labelClass}>
                Proveedor <ConfidenceChip value={confianzas.proveedor_cuit} />
                <div className="flex gap-2">
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className={cn(inputClass, 'bg-panel', !supplierId && 'field-required')}
                  >
                    <option value="">Elegí un proveedor</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}{s.taxId ? ` — ${formatCuit(s.taxId)}` : ''}</option>
                    ))}
                  </select>
                  <Button type="button" variant="ghost" className="shrink-0 px-3" onClick={() => setShowNewSupplier(true)}>
                    <Plus size={14} /> Nuevo
                  </Button>
                </div>
                {!draft.supplierId && (draft.rawExtraction as any)?.valores?.proveedor_cuit && (
                  <span className="mt-1 block text-[10px] font-normal normal-case text-state-wait">
                    La IA leyó CUIT {(draft.rawExtraction as any).valores.proveedor_cuit} pero no coincide con ningún proveedor cargado.
                  </span>
                )}
              </label>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className={labelClass}>
                  Letra
                  <select value={letter} onChange={(e) => setLetter(e.target.value as PurchaseLetter)} className={cn(inputClass, 'bg-panel font-mono')}>
                    {(['A', 'B', 'C', 'M'] as PurchaseLetter[]).map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
                <label className={labelClass}>
                  P. venta <ConfidenceChip value={confianzas.punto_venta} />
                  <input type="number" min="0" value={salesPoint} onChange={(e) => setSalesPoint(e.target.value)} className={cn(inputClass, 'font-mono')} />
                </label>
                <label className={labelClass}>
                  Número <ConfidenceChip value={confianzas.numero} />
                  <input type="number" min="1" value={number} onChange={(e) => setNumber(e.target.value)} className={cn(inputClass, 'font-mono')} />
                </label>
                <label className={labelClass}>
                  Fecha <ConfidenceChip value={confianzas.fecha_comprobante} />
                  <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className={inputClass} />
                </label>
              </div>

              <label className={labelClass}>
                Vencimiento
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
              </label>
            </div>
          </Panel>
        </div>
      </div>

      <Panel className="mb-6 p-5">
        <SectionHeader
          title={isArticles ? 'Artículos' : 'Conceptos'}
          actions={isArticles && (
            <Button type="button" onClick={() => setShowPicker(true)} className="px-3">
              <Package size={16} /> Agregar artículo
            </Button>
          )}
        />
        {unmatchedArticleLines > 0 && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-danger">
            <AlertTriangle size={14} /> {unmatchedArticleLines} renglón(es) sin artículo asignado — elegilo antes de confirmar.
          </p>
        )}
        <div className="overflow-x-auto overflow-y-hidden rounded-md border border-line">
          <table className="table-stack w-full text-left text-[13px]">
            <thead className="h-9 bg-panel-head text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft">
              <tr>
                <th className="px-2 py-1 w-44">{isArticles ? 'Código' : 'Concepto'}</th>
                <th className="px-2 py-1">{isArticles ? 'Descripción' : 'Detalle'}</th>
                <th className="px-2 py-1 w-20 text-right">Cant.</th>
                <th className="px-2 py-1 w-28 text-right">P. unitario</th>
                <th className="px-2 py-1 w-20 text-right">Bonif. %</th>
                <th className="px-2 py-1 w-32">IVA</th>
                <th className="px-2 py-1 w-28 text-right">Neto</th>
                <th className="px-2 py-1 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => (
                <React.Fragment key={idx}>
                  {isArticles && !line.articleId ? (
                    <tr className="h-9 border-b border-line bg-danger-soft">
                      <td colSpan={8} className="px-2 py-1">
                        <button
                          type="button"
                          onClick={() => setShowPicker(true)}
                          className="flex w-full items-center justify-between text-left text-danger hover:underline"
                        >
                          <span>{line.description || 'Renglón sin artículo del catálogo asignado'} — elegir artículo</span>
                          <button type="button" onClick={(e) => { e.stopPropagation(); setLines((c) => c.filter((_, i) => i !== idx)); }} aria-label="Quitar renglón">
                            <Trash2 size={15} />
                          </button>
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <PurchaseItemRow
                      line={line}
                      idx={idx}
                      isArticles={isArticles}
                      concepts={concepts}
                      vatRates={vatRates}
                      onPatch={(patch) => patchLine(idx, patch)}
                      onRemove={() => setLines((current) => current.filter((_, i) => i !== idx))}
                    />
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel className="p-5">
          <SectionHeader title="Impuestos del pie" />
          {footRates.length > 0 && (
            <select value="" onChange={(e) => addFootTax(e.target.value)} className={cn(inputClass, 'mt-0 bg-panel')}>
              <option value="">Agregar percepción o impuesto…</option>
              {footRates.filter((rate) => !footTaxes.some((tax) => tax.taxRateId === rate.id)).map((rate) => (
                <option key={rate.id} value={rate.id}>{rate.name} ({rate.rate}%)</option>
              ))}
            </select>
          )}
          <ul className="mt-3 space-y-2">
            {footTaxes.map((tax, idx) => (
              <PurchaseTaxRow
                key={tax.taxRateId}
                tax={tax}
                rate={footRates.find((r) => r.id === tax.taxRateId)}
                suggested={(() => {
                  const rate = footRates.find((r) => r.id === tax.taxRateId);
                  return rate ? suggestedTaxAmount(rate, totals) : 0;
                })()}
                onAmountChange={(amount) => setFootTaxes((current) => current.map((t, i) => (i === idx ? { ...t, amount } : t)))}
                onRemove={() => setFootTaxes((current) => current.filter((_, i) => i !== idx))}
              />
            ))}
          </ul>
        </Panel>

        <Panel className="p-5">
          <SectionHeader title="Totales" />
          <ConfidenceChip value={confianzas.total} />
          <PurchaseTotalsSummary
            totals={totals}
            generalDiscount={generalDiscount}
            onGeneralDiscountChange={setGeneralDiscount}
            declaredTotal=""
            onDeclaredTotalChange={() => {}}
          />
        </Panel>
      </div>

      {showPicker && <PurchaseArticlePicker articles={articles} onPick={addArticle} onClose={() => setShowPicker(false)} />}
      {showNewSupplier && (
        <SupplierModal
          supplier={null}
          onClose={() => setShowNewSupplier(false)}
          onSaved={(created) => {
            setSuppliers((current) => [...current, created]);
            setSupplierId(created.id);
            setShowNewSupplier(false);
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Agregar la ruta**

En `src/App.tsx`:

```typescript
import { PurchaseAIReview } from './pages/PurchaseAIReview';
```

```tsx
<Route path="/compras-ia/revisar/:id" element={<PurchaseAIReview />} />
```

- [ ] **Step 3: Agregar la tarjeta de menú**

En `src/lib/menuCategories.ts`, ahora que las tres páginas existen:

```typescript
// import de lucide-react en el encabezado del archivo: agregar Sparkles
{
  color: 'comprobantes',
  cards: [
    { icon: ShoppingCart, label: 'Compras', path: '/compras', adminOnly: true },
    { icon: Sparkles, label: 'Compras con IA', path: '/compras-ia', adminOnly: true },
  ],
},
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit && npm run build`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/pages/PurchaseAIReview.tsx src/App.tsx src/lib/menuCategories.ts
git commit -m "Compras con IA: pantalla de revisión, ruta y entrada de menú"
```

---

### Task 10: Prueba end-to-end con datos reales

**Files:** ninguno (verificación manual).

**Interfaces:**
- Consumes: todo lo anterior.

- [ ] **Step 1: Preparar datos de prueba**

- Un proveedor real ya cargado en `/proveedores`, con CUIT.
- Al menos un artículo con `article_suppliers.supplier_code` cargado para ese proveedor (vía Inventario o Listas de precios).
- Una factura PDF real (o una foto) de ese proveedor, con al menos un renglón cuyo código coincida con el artículo de arriba.

- [ ] **Step 2: Probar el camino ARTICULOS**

Con Playwright (`browser_navigate`, `browser_file_upload`, `browser_snapshot`): entrar a `/compras-ia`, elegir "Factura de artículos", subir el archivo, esperar la extracción, verificar en la pantalla de revisión que:
- El proveedor matcheó solo (o, si no, probar "+ Nuevo" y confirmar que arma el proveedor y lo deja seleccionado).
- El renglón con código conocido aparece ya con el artículo asignado (no en la fila roja de "sin matchear").
- Los chips de confianza aparecen en los campos que corresponde.
- Confirmar, y verificar que navega a `/compra/:id` con los datos correctos.

- [ ] **Step 3: Probar el camino CONCEPTOS**

Mismo recorrido con una factura de gastos (sin códigos de artículo), verificando que no aparece ninguna fila de "sin matchear" (no aplica a conceptos) y que confirma igual.

- [ ] **Step 4: Verificar en la base**

```sql
select id, kind, status, purchase_invoice_id from purchase_invoice_extractions order by created_at desc limit 5;
select id, full_number, total_amount from purchase_invoices order by created_at desc limit 5;
```

Esperado: los dos borradores de prueba en `status = 'CONFIRMADO'`, cada uno con su `purchase_invoice_id` apuntando a una fila real de `purchase_invoices` con los totales esperados.

- [ ] **Step 5: Limpiar los datos de prueba**

Si las facturas de prueba no son reales (se cargaron solo para probar), anularlas desde `/compra/:id` (botón Anular, con motivo "prueba de carga con IA") en vez de borrarlas directo de la base — es el mismo criterio que ya usa este proyecto para no dejar comprobantes fantasma. Si además se creó un artículo o proveedor de prueba que no corresponde a datos reales del taller, borrarlos a mano vía SQL después de confirmar que no quedó ninguna referencia activa.

- [ ] **Step 6: Reportar al usuario**

Confirmar que los dos caminos (ARTICULOS y CONCEPTOS) funcionan de punta a punta con datos reales, antes de dar el feature por terminado.
