# DieselPro ERP

Sistema de gestión para taller de inyección diesel: cotizaciones, órdenes de
trabajo, inventario con control de stock, listas de precios de compra y venta,
y un portal público donde el cliente sigue el avance de su reparación.

React + Vite + TypeScript sobre Supabase (Postgres + Auth).

## Circuito

```
Cotización  ──aceptada──▶  Orden de trabajo  ──▶  Portal del cliente
(Emitida →                 (Autorizada → Esp. Repuestos →
 Enviada →                  En Reparación → Calibración →
 Aceptada /                 Terminado)
 Rechazada)
```

La cotización **no** mueve stock: es una propuesta. El stock se descuenta
recién al convertirla en orden, y todo ocurre en una transacción — si no
alcanza el stock, no se crea la orden.

## Módulos

| Módulo | Qué hace |
|---|---|
| **Cotizaciones** | Presupuesto previo, con validez, duplicado y conversión a OT |
| **Órdenes de trabajo** | Renglones, avance de estado con historial, totales con IVA |
| **Inventario** | Artículos con control de stock opcional y utilidad por artículo |
| **Listas de precios** | Importación de listas de compra por Excel, con vinculación de códigos |
| **Clientes / Proveedores** | Padrones con datos fiscales argentinos (CUIT validado, condición IVA) |
| **Vehículos** | Ficha técnica: motor, sistema de inyección, kilometraje u horas |
| **Portal del cliente** | Público, sin login: estado de la reparación con fechas reales |

## Roles

- **admin**: acceso completo.
- **operario**: consulta el estado de las órdenes; no puede modificar nada.

Las restricciones se aplican en la base con Row Level Security, no solo en la
interfaz: un operario no puede escribir aunque manipule el navegador.

## Puesta en marcha

**Requisitos:** Node.js 20+ y un proyecto de Supabase.

```bash
npm install
cp .env.example .env   # completá con las credenciales de tu proyecto
npm run dev
```

La app queda en `http://localhost:4000`.

### Base de datos

Sobre una base vacía, ejecutar en el SQL Editor de Supabase en este orden:

```
supabase/schema.sql
supabase/auth.sql
supabase/articles.sql
supabase/quotations.sql
supabase/price-lists.sql
supabase/price-lists-functions.sql
supabase/work-order-status.sql
```

Después, crear el usuario administrador desde **Authentication → Users** y
promoverlo:

```sql
update profiles set role = 'admin' where email = 'tu-email@ejemplo.com';
```

Los usuarios nuevos quedan como `operario` por defecto.

## Pendiente

- Las secciones **Diagnósticos** y **Reportes** están en el menú pero todavía
  no tienen contenido.
- No existe un estado "Anulada" para las órdenes: una vez que una cotización
  se convierte en OT, ninguna de las dos se puede eliminar (por trazabilidad).
