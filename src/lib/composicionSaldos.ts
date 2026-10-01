import { supabase } from '@/src/lib/supabase';

/**
 * Composición de saldos de clientes y proveedores, con la forma de la de
 * Tango: por cada uno, sus comprobantes con lo aplicado debajo y lo que quedó
 * a cuenta. Los renglones los arma la base (supabase/composicion-de-saldos.sql);
 * acá se agrupan, se filtran por fecha y se calcula el saldo anterior.
 */

export type Lado = 'clientes' | 'proveedores';

export interface Movimiento {
  parteId: string;
  nombre: string;
  cuit: string | null;
  tipo: 'COMPROBANTE' | 'APLICACION' | 'A_CUENTA';
  comprobanteId: string;
  comprobante: string | null;
  fecha: string | null;
  vencimiento: string | null;
  importe: number;
  aplicado: string | null;
  fechaAplicacion: string | null;
}

export async function fetchMovimientos(lado: Lado, hasta: string): Promise<Movimiento[]> {
  const fn = lado === 'clientes' ? 'cuenta_corriente_clientes' : 'cuenta_corriente_proveedores';
  const idCol = lado === 'clientes' ? 'customer_id' : 'supplier_id';
  // La base corta en 1000 filas por consulta: de a tandas.
  const filas: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase
      .rpc(fn, { p_hasta: hasta })
      .order('nombre')
      .order(idCol)
      .order('fecha', { nullsFirst: false })
      .order('comprobante_id')
      .order('tipo')
      .order('aplicado', { nullsFirst: true })
      .order('fecha_aplicacion', { nullsFirst: true })
      .order('importe')
      .range(desde, desde + 999);
    if (error) throw error;
    filas.push(...((data ?? []) as any[]));
    if ((data ?? []).length < 1000) break;
  }
  return filas.map((r) => ({
    parteId: r[idCol],
    nombre: r.nombre,
    cuit: r.cuit,
    tipo: r.tipo,
    comprobanteId: r.comprobante_id,
    comprobante: r.comprobante,
    fecha: r.fecha,
    vencimiento: r.vencimiento,
    importe: Number(r.importe),
    aplicado: r.aplicado,
    fechaAplicacion: r.fecha_aplicacion,
  }));
}

/** El mail de cada cliente o proveedor, para "Enviar por correo electrónico". */
export async function fetchMails(lado: Lado): Promise<Map<string, string>> {
  const tabla = lado === 'clientes' ? 'customers' : 'suppliers';
  const mails = new Map<string, string>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase
      .from(tabla)
      .select('id, email')
      .not('email', 'is', null)
      .order('id')
      .range(desde, desde + 999);
    if (error) throw error;
    for (const r of (data ?? []) as any[]) if (r.email) mails.set(r.id, r.email);
    if ((data ?? []).length < 1000) break;
  }
  return mails;
}

export interface Renglon {
  /** El comprobante, o vacío si es una aplicación. */
  comprobante: string;
  /** Para abrir la ficha del comprobante, si tiene. */
  ruta: string | null;
  fecha: string | null;
  vencimiento: string | null;
  aplicado: string;
  fechaAplicacion: string | null;
  debe: number | null;
  haber: number | null;
  /** Solo en el renglón del comprobante, como en Tango: su importe. */
  total: number | null;
  esAplicacion: boolean;
}

export interface Bloque {
  parteId: string;
  nombre: string;
  cuit: string | null;
  saldoAnterior: number;
  totalSaldo: number;
  renglones: Renglon[];
}

export interface Filtros {
  /** yyyy-mm-dd; vacío = desde el principio. */
  desde: string;
  /** Texto: parte del nombre o del CUIT. */
  parte: string;
  modo: 'pendientes' | 'todos';
}

const redondear = (n: number) => Math.round(n * 100) / 100;

function rutaDe(lado: Lado, m: Movimiento): string | null {
  const texto = m.comprobante ?? '';
  if (m.tipo === 'COMPROBANTE') {
    if (lado === 'clientes') return `/factura/${m.comprobanteId}`;
    return texto.startsWith('NC provisoria') ? '/nc-provisorias' : `/compra/${m.comprobanteId}`;
  }
  if (texto.startsWith('Recibo')) return `/recibo/${m.comprobanteId}`;
  if (texto.startsWith('Nota de crédito')) return `/nota-credito/${m.comprobanteId}`;
  if (texto.startsWith('Orden de pago')) return `/pago/${m.comprobanteId}`;
  return null;
}

interface Item {
  fecha: string;
  pendiente: number;
  aCuenta: boolean;
  renglones: Renglon[];
}

/**
 * Arma un bloque por cliente o proveedor.
 *
 * El saldo anterior es lo que todavía debían, a la fecha "hasta", los
 * comprobantes anteriores a "desde"; los del período se listan. Así el total
 * del bloque es siempre el saldo a la fecha "hasta", con o sin "desde".
 *
 * En "pendientes" se listan solo los comprobantes con saldo; lo que está a
 * cuenta se lista si en conjunto deja algo a favor (si se compensó entero, no
 * aporta nada).
 */
export function armarComposicion(lado: Lado, movimientos: Movimiento[], filtros: Filtros): Bloque[] {
  const busqueda = filtros.parte.trim().toLowerCase();
  const porParte = new Map<string, Movimiento[]>();
  for (const m of movimientos) {
    const lista = porParte.get(m.parteId);
    if (lista) lista.push(m);
    else porParte.set(m.parteId, [m]);
  }

  const bloques: Bloque[] = [];
  for (const [parteId, movs] of porParte) {
    const { nombre, cuit } = movs[0];
    if (busqueda) {
      const digitos = busqueda.replace(/\D/g, '');
      const coincide =
        nombre.toLowerCase().includes(busqueda) || (digitos.length >= 3 && (cuit ?? '').includes(digitos));
      if (!coincide) continue;
    }

    const aplicaciones = new Map<string, Movimiento[]>();
    for (const m of movs) {
      if (m.tipo !== 'APLICACION') continue;
      const lista = aplicaciones.get(m.comprobanteId);
      if (lista) lista.push(m);
      else aplicaciones.set(m.comprobanteId, [m]);
    }

    const items: Item[] = [];
    for (const m of movs) {
      if (m.tipo === 'APLICACION') continue;
      const apps = (aplicaciones.get(m.comprobanteId) ?? []).sort((a, b) =>
        (a.fechaAplicacion ?? '').localeCompare(b.fechaAplicacion ?? '')
      );
      const renglones: Renglon[] = [
        {
          comprobante: m.comprobante ?? '',
          ruta: rutaDe(lado, m),
          fecha: m.fecha,
          vencimiento: m.vencimiento,
          aplicado: '',
          fechaAplicacion: null,
          debe: m.importe > 0 ? m.importe : null,
          haber: m.importe < 0 ? m.importe : null,
          total: m.importe,
          esAplicacion: false,
        },
        ...apps.map((a) => ({
          comprobante: '',
          ruta: null,
          fecha: null,
          vencimiento: null,
          aplicado: a.aplicado ?? '',
          fechaAplicacion: a.fechaAplicacion,
          debe: a.importe > 0 ? a.importe : null,
          haber: a.importe < 0 ? a.importe : null,
          total: null,
          esAplicacion: true,
        })),
      ];
      items.push({
        fecha: m.fecha ?? '',
        pendiente: redondear(m.importe + apps.reduce((s, a) => s + a.importe, 0)),
        aCuenta: m.tipo === 'A_CUENTA',
        renglones,
      });
    }

    const anteriores = filtros.desde ? items.filter((i) => i.fecha < filtros.desde) : [];
    const delPeriodo = filtros.desde ? items.filter((i) => i.fecha >= filtros.desde) : items;
    const saldoAnterior = redondear(anteriores.reduce((s, i) => s + i.pendiente, 0));

    let visibles = delPeriodo;
    if (filtros.modo === 'pendientes') {
      const aCuenta = delPeriodo.filter((i) => i.aCuenta);
      const aCuentaSuma = redondear(aCuenta.reduce((s, i) => s + i.pendiente, 0));
      visibles = delPeriodo.filter((i) => (i.aCuenta ? Math.abs(aCuentaSuma) >= 0.005 : Math.abs(i.pendiente) >= 0.005));
    }
    visibles = [...visibles].sort((a, b) => a.fecha.localeCompare(b.fecha));

    const totalSaldo = redondear(saldoAnterior + delPeriodo.reduce((s, i) => s + i.pendiente, 0));

    if (visibles.length === 0 && Math.abs(saldoAnterior) < 0.005 && Math.abs(totalSaldo) < 0.005) continue;
    if (filtros.modo === 'pendientes' && Math.abs(totalSaldo) < 0.005 && visibles.length === 0) continue;

    bloques.push({
      parteId,
      nombre,
      cuit,
      saldoAnterior,
      totalSaldo,
      renglones: visibles.flatMap((i) => i.renglones),
    });
  }

  return bloques.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

const COLUMNAS = ['Comprobante', 'Fecha', 'Vencimiento', 'Comprobante aplicado', 'Fecha aplicación', 'Debe', 'Haber', 'Total'];

function fechaAR(f: string | null): string {
  if (!f) return '';
  const [a, m, d] = f.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

/** Las filas planas de la composición: para el portapapeles y el Excel. */
export function filasParaExportar(bloques: Bloque[], desde: string): (string | number | null)[][] {
  const filas: (string | number | null)[][] = [];
  for (const b of bloques) {
    filas.push([`${b.nombre}${b.cuit ? ` (${b.cuit})` : ''}`]);
    if (desde) filas.push([`Saldo anterior a ${fechaAR(desde)}`, null, null, null, null, null, null, b.saldoAnterior]);
    filas.push([...COLUMNAS]);
    for (const r of b.renglones) {
      filas.push([
        r.comprobante,
        fechaAR(r.fecha),
        fechaAR(r.vencimiento),
        r.aplicado,
        fechaAR(r.fechaAplicacion),
        r.debe,
        r.haber,
        r.total,
      ]);
    }
    filas.push(['Total saldo', null, null, null, null, null, null, b.totalSaldo]);
    filas.push([]);
  }
  return filas;
}
