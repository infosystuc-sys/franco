# Un artículo, varios proveedores: el código de fábrica

**Estado:** propuesta, a aprobar antes de implementar.
**Fecha:** 2026-09-16

## El problema, con nombre y apellido

Hoy, al importar una lista o al leer una factura con IA, el artículo se busca así
(`import_supplier_prices`, y lo mismo en `extraer-factura-compra`):

```sql
where supplier_id = p_supplier_id
  and upper(supplier_code) = upper(r.code)
```

La búsqueda está **encerrada dentro del proveedor**. Entonces:

1. El proveedor A trae la tobera Bosch `0445120123`. No existe → se crea el
   artículo `AA-00000001`.
2. El proveedor B trae **la misma tobera** como `BOS0445120123`. Dentro de B no
   existe → se crea otro artículo, `BB-00000001`.

La misma pieza física quedó dos veces en el catálogo, con dos stocks, dos
precios de venta y dos historias. Es exactamente lo que describís.

Lo importante: **el modelo de datos ya es el correcto**. `article_suppliers`
(artículo, proveedor, `supplier_code`, `supplier_description`, `purchase_price`,
`is_preferred`) ya permite un artículo con varios proveedores, cada uno con su
código. Lo que falta no es la tabla: es **cómo se decide que dos códigos
distintos son la misma pieza**.

### Cuidado con el nombre

`suppliers.code_prefix` ya existe, pero es otra cosa: es el prefijo con el que
generamos **nuestros** códigos al importar (`MD-00000004`). Dos caracteres,
único por proveedor. El campo nuevo es distinto y necesita otro nombre, o vamos
a confundirlos para siempre.

### La escala hoy

107 artículos, 103 vínculos, 5 proveedores, y **solo 3 artículos con más de un
proveedor**. O sea: el catálogo todavía es casi "un proveedor por artículo" y la
duplicación recién empieza. Arreglarlo ahora cuesta poco; con 5.000 artículos
importados es una limpieza de datos muy cara.

## La idea

Darle al artículo un **código de fábrica**: el número que le pone el fabricante,
el mismo sin importar quién lo venda. Ese número es el que une a los proveedores.

Cada proveedor declara **qué prefijo le antepone** a ese número. Al importar, se
le saca el prefijo al código del proveedor, se normaliza, y lo que queda se
busca en el catálogo:

```
Proveedor A (sin prefijo):  "0445120123"       → 0445120123
Proveedor B (prefijo BOS):  "BOS0445120123"    → 0445120123   ← misma pieza
Proveedor C (prefijo B-):   "B-0 445 120 123"  → 0445120123   ← misma pieza
```

Normalizar = mayúsculas y afuera todo lo que no sea letra o número. Eso resuelve
de paso los espacios y los puntos, que Bosch usa en su propia documentación
(`0 445 120 123`).

### Por qué "código de fábrica" y no "código Bosch"

Es la misma columna y el mismo trabajo, pero el día que Delphi o Denso tengan el
mismo problema —y lo van a tener— no hay que migrar nada ni renombrar. Bosch
pasa a ser el caso principal, no el único. Si preferís que diga Bosch
explícitamente, es cambiar dos nombres antes de empezar; después, no.

## Decisiones que necesito de vos

Estas tres cambian el resultado y no las puedo tomar solo:

**1. ¿Cuándo aplicamos la regla del prefijo?** Sacarle el prefijo a un código que
no era Bosch lo rompe. Opciones:
   - **(a)** Solo si la fila trae marca Bosch en la lista del proveedor.
   - **(b)** Solo si lo que queda después de sacar el prefijo tiene pinta de
     número Bosch (10 caracteres, arranca con 0, 1, 2, 9 o F).
   - **(c)** Las dos: marca Bosch **o** patrón reconocible. *(mi recomendación)*

**2. ¿Unimos solo o preguntamos?** Cuando la importación detecta que un código
nuevo corresponde a un artículo que ya existe:
   - **(a)** Lo vincula sola y lo informa en el resumen. *(mi recomendación,
     con el resumen bien visible)*
   - **(b)** Lo deja pendiente y lo confirmás vos antes.

   Ojo: un falso positivo acá es **peor que un duplicado**. Une dos piezas
   distintas en un solo artículo y mezcla stock y precios, y desarmarlo después
   es mucho trabajo.

**3. ¿Qué hacemos con los duplicados que ya existan?** Detectarlos es fácil;
fusionarlos toca `work_order_items`, `invoice_items`, `article_components` y el
stock. Lo dejaría como tarea aparte, con un informe previo de qué se va a
fusionar, para mirarlo antes de tocar nada.

## Las tareas

### Tarea 1 — El campo en el proveedor
- `suppliers.factory_code_prefix text null` (normalizado a mayúsculas sin
  espacios por trigger, como ya se hace con `code_prefix`).
- Campo en el ABM de Proveedores, con una ayuda que lo distinga del otro
  prefijo: *"Lo que este proveedor le antepone al número de fábrica. Vacío si
  usa el número tal cual."*
- **Verificación:** cargar un prefijo, recargar, sigue ahí y en mayúsculas.

### Tarea 2 — El código de fábrica en el artículo
- `articles.factory_code text null` + índice único parcial
  (`where factory_code is not null`) para que no haya dos artículos con el mismo
  número de fábrica.
- Se muestra y se edita en la ficha del artículo.
- **Verificación:** intentar guardar dos artículos con el mismo número de
  fábrica → lo rechaza con un mensaje claro.

### Tarea 3 — La función que resuelve, una sola
- `resolver_articulo_de_proveedor(p_supplier_id, p_codigo, p_marca)` en la base,
  devolviendo el `article_id` y **cómo lo encontró** (código del proveedor /
  código de fábrica / no encontrado).
- Orden de búsqueda: primero el vínculo exacto que ya existe (respeta lo que
  ataste a mano), después el código de fábrica.
- Que viva en la base y no en cada pantalla es lo que garantiza que la
  importación y la IA decidan igual. Hoy cada una tiene su propia copia de la
  misma consulta, y ahí es donde se desincronizan.
- **Verificación:** tests SQL en transacción con rollback, cubriendo los tres
  resultados y el caso "el prefijo no aplica".

### Tarea 4 — La importación usa la función
- `import_supplier_prices` pasa a resolver con la Tarea 3. Si encuentra el
  artículo por código de fábrica, **vincula** en vez de crear.
- El resumen de la importación suma una categoría: *vinculados a un artículo que
  ya existía*, con el detalle de cuáles.
- **Verificación:** importar dos listas con la misma pieza y dos códigos
  distintos → un solo artículo, dos vínculos.

### Tarea 5 — La IA usa la función
- `extraer-factura-compra` reemplaza su consulta por la misma función.
- **Verificación:** una factura del proveedor B con la pieza que cargó el
  proveedor A → cae en el artículo existente.

### Tarea 6 — Duplicados que ya existen *(aparte, después de aprobar el informe)*
- Informe: artículos cuyo código de fábrica normalizado coincide.
- Fusión: mover vínculos, renglones e historia al que queda; sumar stock;
  desactivar el otro. Nunca borrar: hay comprobantes emitidos que lo referencian.

## Lo que NO resuelve

Un proveedor que usa **su propio código interno**, sin relación con el número de
fábrica (`REP-0012` para la misma tobera), no se resuelve con prefijos. Para eso
sigue estando el vínculo manual desde la ficha del artículo, que ya existe y
queda como el camino para esos casos. Si resultan muchos, la vuelta siguiente es
una pantalla para atar los no reconocidos después de cada importación.
