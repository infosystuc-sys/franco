import {
  LogIn,
  FileText,
  Wrench,
  Receipt,
  Users,
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
  Percent,
  ClipboardList,
  BarChart3,
  MessageSquare,
  Settings,
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
  comprobantes: '#e07b1a', // --color-state-wait
  padrones: '#f5c518', // --color-accent
  operaciones: '#7b3fa0', // --color-state-work
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
          { icon: LogIn, label: 'Ingreso de vehículos', path: '/ingresos', adminOnly: true },
          { icon: FileText, label: 'Cotizaciones', path: '/cotizaciones', adminOnly: true },
          { icon: Wrench, label: 'Órdenes de trabajo', path: '/ordenes' },
          { icon: Receipt, label: 'Facturación', path: '/facturas', newPath: '/facturas/nueva', adminOnly: true },
        ],
      },
      {
        color: 'padrones',
        cards: [
          { icon: Users, label: 'Clientes', path: '/clientes', adminOnly: true },
          { icon: Truck, label: 'Vehículos', path: '/vehiculos', adminOnly: true },
          { icon: Wrench, label: 'Estados de OT', path: '/estados-ot', adminOnly: true },
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
        cards: [{ icon: ShoppingCart, label: 'Compras', path: '/compras', adminOnly: true }],
      },
      {
        color: 'padrones',
        cards: [{ icon: Factory, label: 'Proveedores', path: '/proveedores', adminOnly: true }],
      },
      {
        color: 'informes',
        cards: [reportCard('libro-iva-compras')],
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
          { icon: HandCoins, label: 'Cobranzas', path: '/cobranzas', newPath: '/cobranzas/nueva', adminOnly: true },
          { icon: Banknote, label: 'Pagos', path: '/pagos', newPath: '/pagos/nueva', adminOnly: true },
        ],
      },
      {
        color: 'operaciones',
        cards: [{ icon: FileCheck, label: 'Cheques', path: '/cheques', adminOnly: true }],
      },
      {
        color: 'informes',
        cards: [
          reportCard('saldos-clientes'),
          reportCard('antiguedad-clientes'),
          reportCard('saldos-proveedores'),
          reportCard('antiguedad-proveedores'),
          reportCard('cheques-cartera'),
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
          { icon: Package, label: 'Inventario', path: '/inventario', adminOnly: true },
          { icon: Tags, label: 'Listas de precios', path: '/listas-precios', adminOnly: true },
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
          { icon: Landmark, label: 'Medios de pago', path: '/medios-pago', adminOnly: true },
        ],
      },
      {
        color: 'informes',
        cards: [reportCard('libro-caja'), reportCard('arqueo')],
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
          { icon: Percent, label: 'Alícuotas', path: '/alicuotas', adminOnly: true },
          { icon: ClipboardList, label: 'Conceptos de gasto', path: '/conceptos', adminOnly: true },
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
  { icon: Users, label: 'Usuarios', path: '/usuarios', adminOnly: true },
  { icon: MessageSquare, label: 'Mensajes', path: '/mensajes', adminOnly: true },
  { icon: Settings, label: 'Configuración', path: '/configuracion', adminOnly: true },
];

export function visibleCategories(isAdmin: boolean): MenuCategory[] {
  return MENU_CATEGORIES.map((category) => ({
    ...category,
    sections: category.sections
      .map((section) => ({
        ...section,
        cards: section.cards.filter((card) => isAdmin || !card.adminOnly),
      }))
      .filter((section) => section.cards.length > 0),
  })).filter((category) => category.sections.length > 0);
}

export function allCards(isAdmin: boolean): MenuCard[] {
  return visibleCategories(isAdmin).flatMap((category) => category.sections.flatMap((section) => section.cards));
}

/** De qué color es la tarjeta de esta ruta, para pintar la sección "Favoritos" con el color de origen de cada una. */
export function sectionColorForPath(path: string, isAdmin: boolean): SectionColor | undefined {
  for (const category of visibleCategories(isAdmin)) {
    for (const section of category.sections) {
      if (section.cards.some((card) => card.path === path)) return section.color;
    }
  }
  return undefined;
}
