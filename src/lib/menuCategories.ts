import {
  FileText,
  Wrench,
  Receipt,
  Users,
  FileSpreadsheet,
  Truck,
  ShoppingCart,
  Factory,
  HandCoins,
  Banknote,
  FileCheck,
  Package,
  Tags,
  Wallet,
  Landmark,
  FileMinus,
  Percent,
  ClipboardList,
  BarChart3,
  MessageSquare,
  Settings,
  CalendarClock,
  ArrowRightLeft,
  Link2,
  Merge,
  Pencil,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { REPORTS } from '@/src/lib/reports';

/**
 * El menú de inicio (estilo Tango): un riel de categorías a la izquierda y,
 * dentro de cada una, tarjetas agrupadas en secciones de color. Esta es la
 * única fuente de verdad de esa estructura — el riel y la grilla la leen de
 * acá, así agregar o mover un módulo es un cambio en un solo lugar.
 *
 * Los informes no tienen categoría propia: cada uno vive en la sección
 * "Informes" de la categoría a la que pertenece (Ventas, Compras...), igual
 * que en Tango. reportCard() los toma del catálogo real (reports.ts) por id,
 * así que si un informe cambia de nombre ahí, acá se actualiza solo.
 */

export type SectionColor = 'comprobantes' | 'padrones' | 'operaciones' | 'informes';

/** Color de la barra de cada sección, tomado de la paleta ya usada en la app. */
export const SECTION_COLORS: Record<SectionColor, string> = {
  comprobantes: '#ff5a36',
  padrones: '#ffc107',
  operaciones: '#8b3a6f',
  informes: '#c9576b',
};

export const SECTION_TITLES: Record<SectionColor, string> = {
  comprobantes: 'Comprobantes',
  padrones: 'Padrones',
  operaciones: 'Operaciones',
  informes: 'Informes',
};

export interface MenuCard {
  icon: LucideIcon;
  label: string;
  path: string;
  /** Ruta directa de alta, si el módulo tiene una pantalla propia para crear (no un modal). */
  newPath?: string;
  adminOnly?: boolean;
  /**
   * Otras pantallas que son parte del mismo módulo: el detalle de un
   * comprobante (/factura/:id), su alta en otra ruta. Sirve para los permisos:
   * quien tiene el módulo entra también a estas.
   */
  rutas?: string[];
}

export interface MenuSection {
  color: SectionColor;
  cards: MenuCard[];
}

export interface MenuCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  sections: MenuSection[];
}

/** Tarjeta de un informe del catálogo (reports.ts), por su id. */
function reportCard(id: string): MenuCard {
  const report = REPORTS.find((r) => r.id === id);
  if (!report) throw new Error(`El informe "${id}" no existe en el catálogo (reports.ts).`);
  return { icon: BarChart3, label: report.name, path: `/informe/${report.id}`, adminOnly: true };
}

export const MENU_CATEGORIES: MenuCategory[] = [
  {
    key: 'ventas',
    label: 'Ventas',
    icon: Receipt,
    sections: [
      {
        color: 'comprobantes',
        cards: [
          { icon: FileText, label: 'Cotizaciones', path: '/cotizaciones', newPath: '/cotizaciones/nueva', adminOnly: true, rutas: ['/cotizacion'] },
          // El + no abre una orden: lleva a cargar el vehículo. Antes de abrir la OT
          // hay que tener el equipo dado de alta, y es el paso que más se repite.
          { icon: Wrench, label: 'Órdenes de trabajo', path: '/ordenes', newPath: '/vehiculos/nuevo?destino=ot', rutas: ['/orden'] },
          { icon: CalendarClock, label: 'Disponibilidad del taller', path: '/disponibilidad-taller', adminOnly: true },
          { icon: Receipt, label: 'Facturación', path: '/facturas', newPath: '/facturas/nueva', adminOnly: true, rutas: ['/factura', '/facturar'] },
          { icon: ClipboardList, label: 'Órdenes para facturar', path: '/facturas/pendientes', adminOnly: true, rutas: ['/facturar'] },
          { icon: FileMinus, label: 'Notas de crédito', path: '/notas-credito', newPath: '/notas-credito/nueva', adminOnly: true, rutas: ['/nota-credito'] },
          { icon: Truck, label: 'Remitos', path: '/remitos', newPath: '/remitos/nuevo', adminOnly: true, rutas: ['/remito'] },
        ],
      },
      {
        color: 'padrones',
        cards: [
          { icon: Users, label: 'Clientes', path: '/clientes', newPath: '/clientes?nuevo=1', adminOnly: true },
          { icon: Truck, label: 'Vehículos', path: '/vehiculos', newPath: '/vehiculos/nuevo', adminOnly: true },
          { icon: Wrench, label: 'Estados de OT', path: '/estados-ot', newPath: '/estados-ot?nuevo=1', adminOnly: true },
        ],
      },
      {
        color: 'informes',
        cards: [
          reportCard('ventas-periodo'),
          reportCard('ranking-clientes'),
          reportCard('articulos-vendidos'),
          reportCard('ventas-mensual'),
          reportCard('libro-iva-ventas'),
          reportCard('tiempos-por-etapa'),
        ],
      },
    ],
  },
  {
    key: 'compras',
    label: 'Compras',
    icon: ShoppingCart,
    sections: [
      {
        color: 'comprobantes',
        cards: [
          { icon: ShoppingCart, label: 'Compras', path: '/compras', newPath: '/compras/nueva/articulos', adminOnly: true, rutas: ['/compra'] },
          { icon: Sparkles, label: 'Compras con IA', path: '/compras-ia', newPath: '/compras-ia/nueva/articulos', adminOnly: true, rutas: ['/compras-ia/nueva/conceptos'] },
          // Acceso directo: la factura de conceptos (luz, flete, honorarios)
          // leída con IA, sin pasar por la pantalla de Compras con IA.
          { icon: Sparkles, label: 'Conceptos con IA', path: '/compras-ia/nueva/conceptos', adminOnly: true },
        ],
      },
      {
        color: 'padrones',
        cards: [{ icon: Factory, label: 'Proveedores', path: '/proveedores', newPath: '/proveedores?nuevo=1', adminOnly: true }],
      },
      {
        color: 'informes',
        cards: [
          reportCard('compras-periodo'),
          reportCard('ranking-proveedores'),
          reportCard('articulos-comprados'),
          reportCard('compras-por-concepto'),
          reportCard('compras-mensual'),
          reportCard('libro-iva-compras'),
        ],
      },
    ],
  },
  {
    key: 'cuenta-corriente',
    label: 'Cuenta corriente',
    icon: HandCoins,
    sections: [
      {
        color: 'comprobantes',
        cards: [
          { icon: HandCoins, label: 'Cobranzas', path: '/cobranzas', newPath: '/cobranzas/nueva', adminOnly: true, rutas: ['/recibo'] },
          { icon: Users, label: 'Cuenta corriente de clientes', path: '/cuenta-corriente-clientes', adminOnly: true },
          { icon: Banknote, label: 'Pagos', path: '/pagos', newPath: '/pagos/nueva', adminOnly: true, rutas: ['/pago'] },
          { icon: Factory, label: 'Cuenta corriente de proveedores', path: '/cuenta-corriente-proveedores', adminOnly: true },
          { icon: Link2, label: 'Imputación de comprobantes', path: '/imputaciones', adminOnly: true },
        ],
      },
      {
        color: 'operaciones',
        cards: [
          { icon: FileSpreadsheet, label: 'Saldos iniciales de clientes', path: '/saldos-iniciales/clientes', adminOnly: true },
          { icon: FileSpreadsheet, label: 'Saldos iniciales de proveedores', path: '/saldos-iniciales/proveedores', adminOnly: true },
          { icon: FileMinus, label: 'NC provisorias', path: '/nc-provisorias', adminOnly: true },
          { icon: Wrench, label: 'Cuentas de mecánicos', path: '/mecanicos', adminOnly: true },
        ],
      },
      {
        color: 'informes',
        cards: [
          reportCard('saldos-clientes'),
          reportCard('antiguedad-clientes'),
          reportCard('saldos-proveedores'),
          reportCard('pagos-a-realizar'),
          reportCard('antiguedad-proveedores'),
        ],
      },
    ],
  },
  {
    key: 'inventario',
    label: 'Inventario',
    icon: Package,
    sections: [
      {
        color: 'padrones',
        cards: [
          { icon: Package, label: 'Inventario', path: '/inventario', newPath: '/inventario?nuevo=1', adminOnly: true },
          { icon: Tags, label: 'Listas de precios', path: '/listas-precios', adminOnly: true },
          { icon: Merge, label: 'Artículos duplicados', path: '/articulos-duplicados', adminOnly: true },
          { icon: Pencil, label: 'Actualización masiva', path: '/actualizacion-masiva', adminOnly: true },
        ],
      },
      {
        color: 'informes',
        cards: [reportCard('stock-valorizado'), reportCard('stock-sin-movimiento')],
      },
    ],
  },
  {
    key: 'tesoreria',
    label: 'Tesorería',
    icon: Wallet,
    sections: [
      {
        color: 'operaciones',
        cards: [
          { icon: Wallet, label: 'Tesorería', path: '/tesoreria', adminOnly: true },
          { icon: FileCheck, label: 'Cheques', path: '/cheques', newPath: '/cheques/nuevo', adminOnly: true },
          { icon: ArrowRightLeft, label: 'Endosar cheques', path: '/tesoreria/endosar-cheque', adminOnly: true },
          { icon: FileSpreadsheet, label: 'Carga inicial de cheques', path: '/saldos-iniciales/cheques', adminOnly: true },
          { icon: Landmark, label: 'Medios de pago', path: '/medios-pago', newPath: '/medios-pago?nuevo=1', adminOnly: true },
          { icon: Landmark, label: 'Bancos', path: '/bancos', newPath: '/bancos?nuevo=1', adminOnly: true },
        ],
      },
      {
        color: 'informes',
        cards: [reportCard('libro-caja'), reportCard('egresos-por-concepto'), reportCard('arqueo'), reportCard('cheques-cartera')],
      },
    ],
  },
  {
    key: 'impuestos',
    label: 'Impuestos',
    icon: Percent,
    sections: [
      {
        color: 'padrones',
        cards: [
          { icon: Percent, label: 'Alícuotas', path: '/alicuotas', newPath: '/alicuotas?nuevo=1', adminOnly: true },
          { icon: ClipboardList, label: 'Conceptos de gasto', path: '/conceptos', adminOnly: true },
        ],
      },
      {
        color: 'operaciones',
        cards: [
          { icon: MessageSquare, label: 'Retenciones pendientes', path: '/retenciones-pendientes', adminOnly: true },
        ],
      },
      {
        color: 'informes',
        cards: [reportCard('retenciones-sufridas'), reportCard('retenciones-practicadas')],
      },
    ],
  },
];

/** Enlaces directos, fuera de la grilla — igual que Configuración/Aplicaciones en Tango. */
export const MENU_DIRECT_LINKS: MenuCard[] = [
  { icon: Users, label: 'Usuarios', path: '/usuarios', newPath: '/usuarios?nuevo=1', adminOnly: true },
  { icon: MessageSquare, label: 'Mensajes', path: '/mensajes', adminOnly: true },
  { icon: Settings, label: 'Configuración', path: '/configuracion', adminOnly: true },
];

/**
 * Módulos a los que entra un usuario: null es todo el sistema; una lista, solo
 * esas tarjetas (por su ruta). Ver profiles.modulos.
 */
export type Modulos = string[] | null;

export function visibleCategories(isAdmin: boolean, modulos: Modulos = null): MenuCategory[] {
  return MENU_CATEGORIES.map((category) => ({
    ...category,
    sections: category.sections
      .map((section) => ({
        ...section,
        cards: section.cards.filter((card) => (isAdmin || !card.adminOnly) && (!modulos || modulos.includes(card.path))),
      }))
      .filter((section) => section.cards.length > 0),
  })).filter((category) => category.sections.length > 0);
}

export function allCards(isAdmin: boolean, modulos: Modulos = null): MenuCard[] {
  return visibleCategories(isAdmin, modulos).flatMap((category) => category.sections.flatMap((section) => section.cards));
}

/** De qué color es la tarjeta de esta ruta, para pintar la sección "Favoritos" con el color de origen de cada una. */
export function sectionColorForPath(path: string, isAdmin: boolean, modulos: Modulos = null): SectionColor | undefined {
  for (const category of visibleCategories(isAdmin, modulos)) {
    for (const section of category.sections) {
      if (section.cards.some((card) => card.path === path)) return section.color;
    }
  }
  return undefined;
}

// ===========================================================================
// Permisos por módulo
// ===========================================================================

/** Los informes que no tienen tarjeta en el menú: también se habilitan uno por uno. */
const INFORMES_SIN_TARJETA: MenuCard[] = ['rentabilidad-ot', 'precios-desactualizados'].map(reportCard);

/** Todo lo que se puede habilitar, agrupado como en el menú, para la pantalla de Usuarios. */
export function catalogoDeModulos(): { grupo: string; modulos: MenuCard[] }[] {
  return [
    ...MENU_CATEGORIES.map((category) => ({
      grupo: category.label,
      modulos: category.sections.flatMap((section) => section.cards),
    })),
    { grupo: 'Otros informes', modulos: INFORMES_SIN_TARJETA },
    { grupo: 'Sistema', modulos: MENU_DIRECT_LINKS },
  ];
}

/** Las rutas que abre una tarjeta: la suya, la del alta y las de sus detalles. */
function rutasDe(card: MenuCard): string[] {
  const rutas = [card.path, ...(card.rutas ?? [])];
  if (card.newPath) rutas.push(card.newPath.split('?')[0]);
  // La lista de informes se ve si hay al menos uno habilitado.
  if (card.path.startsWith('/informe/')) rutas.push('/informes');
  return rutas;
}

/** Cuántos caracteres de la ruta cubre la tarjeta (0 si no la cubre). */
function cubre(card: MenuCard, pathname: string): number {
  return Math.max(
    0,
    ...rutasDe(card)
      .filter((r) => pathname === r || pathname.startsWith(r + '/'))
      .map((r) => r.length)
  );
}

/**
 * Si la pantalla está dentro de los módulos del usuario. Manda la tarjeta que
 * cubre la ruta más precisa: /facturas/pendientes es "Órdenes para facturar",
 * no "Facturación". Una ruta que no es de ningún módulo (el inicio) es libre.
 */
export function rutaPermitida(pathname: string, modulos: Modulos): boolean {
  if (!modulos) return true;
  const todas = catalogoDeModulos().flatMap((g) => g.modulos);
  const mejor = Math.max(0, ...todas.map((card) => cubre(card, pathname)));
  if (mejor === 0) return true;
  return todas.some((card) => modulos.includes(card.path) && cubre(card, pathname) === mejor);
}
