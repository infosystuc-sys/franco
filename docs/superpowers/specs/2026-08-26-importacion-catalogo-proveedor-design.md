# Importación de catálogo de proveedor — Diseño

**Fecha:** 26 de agosto de 2026
**Estado:** aprobado

## Qué se va a construir

Extiende la pantalla "Listas de precios" existente para poder importar el
Excel **tal como lo manda cada proveedor** (encabezado en cualquier fila,
columnas en cualquier orden, filas de título/sección intercaladas) en vez de
exigir que se reacomode a una plantilla fija. Cuando el código del proveedor
no corresponde a ningún artículo nuestro, en vez de dejarlo en una cola para
vincular a mano, se da de alta un artículo nuevo automáticamente: código
propio secuencial, descripción, marca y precio de compra.

Es una extensión del flujo de importación ya construido
([`priceLists.ts`](../../../src/lib/priceLists.ts),
[`PriceLists.tsx`](../../../src/pages/PriceLists.tsx)), no un módulo aparte:
misma pantalla, misma tabla de sinónimos (`article_suppliers`), mismo
historial (`price_imports`). Este documento registra solo lo que cambia.

---

## Diferencia 1: mapeo de columnas guardado por proveedor, en vez de adivinar por nombre de encabezado

Hoy `parsePriceListFile` busca columnas por nombre de encabezado ("codigo",
"descripcion", "precio") en la primera fila. Sirve para nuestra plantilla,
pero no para un archivo real de proveedor como el de Maximiliano Diesel:
encabezado en la fila 6, títulos de sección ("1-TOBERAS"), filas de guiones
separadoras, columna de marca, y "PRECIO" y "P.OFERTA" en columnas distintas.

En vez de heurísticas de detección automática (frágiles: "GR. SUBRUBRO" no es
marca, y cada proveedor nombra distinto lo mismo), el mapeo se define **una
vez por proveedor** y se guarda:

- Tabla nueva `supplier_import_profiles`: una fila por proveedor, con el
  índice de columna (0-based) para `code_column` (obligatoria),
  `price_column` (obligatoria), `description_column` (opcional) y
  `brand_column` (opcional).
- **No se guarda "fila donde empiezan los datos".** No hace falta: una fila
  de título o de separador no va a tener a la vez un código no vacío *y* un
  precio numérico válido en las columnas mapeadas, así que cae sola en el
  mismo mecanismo de descarte que ya existe (`skipped`, con motivo). Guardar
  un número de fila fijo además sería frágil si el proveedor agrega o saca una
  fila de título entre una lista y la siguiente.
- Se usa siempre la primera hoja del libro, igual que hoy — no se agrega
  selector de hoja (YAGNI: ningún proveedor mencionado lo necesita).

### Flujo en pantalla

1. Se elige proveedor y archivo, igual que hoy.
2. **Si el proveedor no tiene mapeo guardado:** en vez de la vista previa
   parseada, se muestra una grilla cruda del archivo (primeras ~15 filas,
   columnas rotuladas A, B, C…) con 4 desplegables — Código, Precio,
   Descripción, Marca — donde cada opción lista la columna junto con un valor
   de ejemplo tomado de esa misma grilla, para ubicarse sin tener que contar
   letras. "Guardar mapeo y continuar" lo persiste y pasa a la vista previa
   parseada de siempre.
3. **Si ya tiene mapeo guardado:** se aplica directo y se muestra la vista
   previa parseada (como hoy), con un link "Editar mapeo" que reabre la
   grilla cruda precargada con la configuración actual, para cuando el
   proveedor cambia el formato de su lista.
4. El botón "Importar precios" sigue siendo la confirmación final — la
   grilla de mapeo y la vista previa son pasos de revisión, no ejecutan nada
   por sí solos.

---

## Diferencia 2: alta automática en vez de cola manual

Hoy, un código sin sinónimo se guarda en `unmatched_supplier_prices` para
vincularlo a mano a un artículo existente. Se decidió reemplazar esto del
todo: **no queda cola manual**. Si el código del proveedor es nuevo, se crea
un artículo nuestro.

| | Hoy | Nuevo |
|---|---|---|
| Código sin sinónimo | fila en `unmatched_supplier_prices`, a vincular a mano | se crea un artículo nuevo automáticamente |
| Riesgo | requiere trabajo manual repetido | puede duplicar un artículo que ya existía con otro nombre/proveedor — aceptado: el catálogo se puede depurar después a mano si hace falta |
| Código ya conocido | actualiza `purchase_price` y `supplier_description` | **sin cambios**: mismo comportamiento |

La tabla `unmatched_supplier_prices` está vacía en producción (se verificó
antes de diseñar esto) — se elimina junto con `link_unmatched_price`,
`discardUnmatchedPrice`, su política RLS y la sección "Códigos pendientes de
vincular" de `PriceLists.tsx`. No hay datos que migrar.

### Qué se completa al crear el artículo

- **Código:** ver "Prefijo y secuencia" más abajo.
- **Descripción:** la del Excel. Si la columna no está mapeada, `'Sin
  descripción — importado de <proveedor>'` (la descripción es `not null` en
  `articles`).
- **Marca:** la del Excel si la columna está mapeada; si no, `null`.
- **Precio de venta (`unit_price`):** igual que un artículo cargado a mano
  sin utilidad propia — se calcula con la utilidad global sobre el precio de
  compra importado, vía la misma lógica que ya usa `computeSalePrice`.
- **Sinónimo:** fila en `article_suppliers` con `supplier_code`,
  `purchase_price`, y `is_preferred = true` (es el único proveedor que
  conocemos para ese artículo en el momento de crearlo).

En reimportaciones posteriores del mismo código, **no se vuelve a tocar**
`description` ni `brand` del artículo — solo `purchase_price` y
`supplier_description`, igual que en el camino ya existente de "coincide con
un sinónimo". Esto evita que una limpieza manual de la descripción se pierda
en la próxima importación.

---

## Diferencia 3: prefijo y secuencia de código, por proveedor

Se agrega `code_prefix` (2 caracteres, mayúsculas, único) al ABM de
Proveedores, junto al campo "Plazo de pago" ya existente. Nullable: no todo
proveedor necesita cargar catálogo. Si se intenta importar un proveedor sin
prefijo, el import se bloquea con un aviso claro ("Definí un prefijo de
código para este proveedor en Proveedores antes de importar") — se valida
antes de tocar la base, no a mitad de la importación.

El prefijo tiene que ser único entre proveedores porque `articles.code` es
`unique`: si dos proveedores compartieran prefijo, sus secuencias
independientes generarían el mismo código para artículos distintos.

Numeración: tabla `article_code_sequences` (`code_prefix` PK, `last_number`),
mismo patrón que ya usa el resto del sistema para numeración de comprobantes
(`invoice_sequences`, etc.) — se toma con `for update` dentro de la misma
transacción del alta. Formato final: `<PREFIJO>-<8 dígitos>`, el mismo
padding que ya usan facturas, recibos y órdenes de pago
(`lpad(n::text, 8, '0')`). Ejemplo: `DE-00000001`, `DE-00000002`.

La secuencia es por prefijo, no global: los artículos de un mismo proveedor
quedan numerados de forma contigua entre sí.

---

## Cambios en el modelo de datos

```
suppliers
  + code_prefix        text null, unique (case-insensitive)

articles
  + brand              text null

supplier_import_profiles   (nueva)
  supplier_id          uuid PK, references suppliers
  code_column          int not null
  price_column         int not null
  description_column   int null
  brand_column         int null
  updated_at           timestamptz not null default now()

article_code_sequences   (nueva)
  code_prefix          text PK
  last_number          int not null default 0

unmatched_supplier_prices        -- eliminada
```

`price_imports` no cambia de forma (mismo historial: `total_rows`,
`matched_rows`, `unmatched_rows`); solo cambia el significado de
`unmatched_rows`, que ahora cuenta **artículos creados** en vez de "códigos
pendientes de vincular". Se le agrega una nota en el comentario de columna;
no se renombra para no romper el historial ya guardado. La UI del historial
cambia la etiqueta de esa columna a "Creados".

---

## RPC de importación

`import_supplier_prices(supplier_id, file_name, rows)` se reemplaza por una
versión que ya no inserta en `unmatched_supplier_prices`: cuando el código no
matchea, toma el prefijo del proveedor (error si es null), incrementa
`article_code_sequences` para ese prefijo, inserta el artículo y su sinónimo.
Misma firma de entrada; misma forma de salida (`total_rows`, `matched_rows`,
`unmatched_rows` ahora "creados", `import_id`).

---

## Errores y validaciones

- Proveedor sin `code_prefix` configurado → se corta antes de llamar al RPC,
  con mensaje que lleva a Proveedores.
- Mapeo sin columna de código o de precio asignada → "Guardar mapeo" queda
  deshabilitado hasta completar las dos obligatorias.
- Código de proveedor repetido dentro del mismo archivo → se descarta la
  repetición, igual que hoy (`seen` set en `parsePriceListFile`).
- Precio ilegible o negativo → se descarta la fila, igual que hoy.
- Prefijo duplicado entre proveedores → constraint único en
  `suppliers.code_prefix`, con mensaje traducido en
  `describeSupplierError`.

---

## Testing

- `tsc --noEmit` y `npm run build` antes de commitear (igual que el resto del
  proyecto).
- Prueba manual con el archivo real de Maximiliano Diesel S.A. (el de la
  captura): mapear Código=B, Descripción=C, Marca=D, Precio=G; confirmar que
  las filas de título ("1-TOBERAS") y separadoras quedan en "descartadas" y
  que se crean artículos nuevos con el prefijo del proveedor.
- Reimportar el mismo archivo una segunda vez: confirmar que no se duplican
  artículos (todos los códigos ya son sinónimos) y que solo se actualiza el
  precio de compra.
