# Módulo de informes — Diseño

**Fecha:** 25 de agosto de 2026
**Estado:** aprobado

## Qué se va a construir

Un catálogo de informes de gestión al estilo de Tango o SAP: se eligen del
árbol, se ven en pantalla con sus totales, y se exportan a Excel.

---

## Restricciones que definen el diseño

**La agregación va en la base.** PostgREST no sabe agrupar. Traer cinco mil
comprobantes al navegador para sumarlos anda con datos de prueba y se cae en
producción; y un Libro IVA calculado en el cliente no es auditable.

**Un informe que no se puede sumar en Excel no sirve.** Los importes se
escriben como números, no como texto. Es el error más común al exportar y el
que arruina el archivo sin que se note hasta que alguien intenta usarlo.

**Todos los informes tienen que verse y exportarse igual.** Un componente
compartido, no una pantalla por informe: si cada uno se arma por su cuenta,
terminan con filtros distintos y el Excel de uno funciona mejor que el de
otro.

**El formato de importación de ARCA no se escribe de memoria.** Es de ancho
fijo, con posiciones exactas y códigos propios, y cambió entre el Régimen de
Información de Compras y Ventas y el Libro IVA Digital. Un ancho equivocado
produce un archivo que el aplicativo rechaza sin explicar, o que acepta con
los datos corridos. Los libros se entregan como planilla legible —que es el
90% del trabajo— y la serialización a ancho fijo queda pendiente de la
especificación.

---

## El framework

### Catálogo declarativo

Cada informe es una **definición**, no una pantalla: id, área, nombre,
descripción, filtros, columnas y una función que trae los datos. Una sola
ruta `/informe/:id` los renderiza a todos.

```
ReportDefinition
  ├─ columns[]  → encabezado, alineación, formato, si suma en totales
  ├─ filters    → qué controles mostrar
  └─ run()      → llama a la función de la base
```

Agregar un informe nuevo es agregar una definición, no una pantalla. Es lo que
hace que la fase 2 sea barata.

### Las columnas declaran su formato

Cada columna dice si es texto, fecha, número o importe. De ahí salen **a la
vez** la alineación en pantalla, el formato numérico en Excel y si entra en la
fila de totales. Sin eso habría que mantener el mismo criterio en dos lugares.

---

## Dónde se calcula

Funciones en la base, una por informe, con `security invoker`.

El RLS de las tablas ya dice "solo admin", así que la función hereda esa
restricción sin abrir un camino privilegiado nuevo. Es la diferencia con las
RPC de los módulos operativos: aquéllas son `security definer` porque
necesitan escribir donde el RLS no deja; un informe solo lee.

---

## El Excel

Título, período, columnas con ancho útil, importes como números con formato
`#,##0.00` y fila de totales.

**Sin negritas ni colores**: la edición comunitaria de SheetJS no escribe
estilos. Se puede simular con filas separadoras, pero prometer un formato que
la librería no soporta sería peor que no tenerlo.

---

## Fases

### Fase 1 — Framework y lo que se mira seguido

| Informe | Qué responde |
|---|---|
| Ventas por período | qué se facturó, comprobante por comprobante |
| Ranking de clientes | quién compra más |
| Artículos más vendidos | qué se vende |
| Comparativo mensual | cómo viene el año |
| Composición de saldos (clientes / proveedores) | qué comprobantes forman cada saldo |
| **Antigüedad de saldos** (clientes / proveedores) | a quién hay que reclamar |

La antigüedad de saldos es el que justifica la fase: es el informe que se mira
todas las semanas.

### Fase 2 — Impositivos y operativos

Libro IVA Ventas y Compras, retenciones sufridas y practicadas, stock
valorizado, artículos sin movimiento, libro de caja, arqueo por medio de pago
y cheques en cartera por vencimiento.

---

## Lo que queda afuera, y por qué

- **Archivo de importación de ARCA.** Pendiente de la especificación, por lo
  explicado arriba.
- **Gráficos.** Los informes de gestión se leen en tabla y se exportan; un
  gráfico es otra discusión de diseño.
- **Informes guardados con sus filtros.** Cada consulta arranca de cero.
- **Rentabilidad por orden.** Necesita imputar mano de obra, que hoy no se
  registra por tiempo.

---

## Verificación

El repo no tiene runner de tests. Queda `npm run lint`, `npm run build`, y que
los totales de cada informe crucen contra la pantalla del módulo de origen
—las ventas del período contra el listado de Facturación, los saldos contra la
cuenta corriente de Cobranzas.

## Aplicación de la migración

`supabase/reports.sql`, después de todas las demás.
