import React from 'react';
import {
  LayoutDashboard,
  Wrench,
  Package,
  Users,
  Microscope,
  BarChart3,
  Truck,
  Factory,
  FileText,
  Tags,
  MessageSquare,
  HardHat,
} from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';

/**
 * El menú agrupa por cómo se trabaja en el taller: primero el circuito
 * (cotización → orden), después los padrones que lo alimentan.
 */
interface NavItem {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  path: string;
  /** Solo lo ven los administradores; el operario consulta, no gestiona. */
  adminOnly?: boolean;
}

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Operación',
    items: [
      { icon: LayoutDashboard, label: 'Panel', path: '/' },
      { icon: FileText, label: 'Cotizaciones', path: '/cotizaciones', adminOnly: true },
      { icon: Wrench, label: 'Órdenes de Trabajo', path: '/ordenes' },
    ],
  },
  {
    label: 'Padrones',
    items: [
      { icon: Users, label: 'Clientes', path: '/clientes', adminOnly: true },
      { icon: Truck, label: 'Vehículos', path: '/vehiculos', adminOnly: true },
      { icon: Factory, label: 'Proveedores', path: '/proveedores', adminOnly: true },
      { icon: Package, label: 'Inventario', path: '/inventario', adminOnly: true },
      { icon: Tags, label: 'Listas de Precios', path: '/listas-precios', adminOnly: true },
      { icon: HardHat, label: 'Empleados', path: '/empleados', adminOnly: true },
    ],
  },
  {
    label: 'Análisis',
    items: [
      { icon: MessageSquare, label: 'Mensajes', path: '/mensajes', adminOnly: true },
      { icon: Microscope, label: 'Diagnósticos', path: '/diagnosticos' },
      { icon: BarChart3, label: 'Reportes', path: '/reportes' },
    ],
  },
];

/**
 * En escritorio queda fijo a la izquierda. En pantallas chicas se comporta
 * como panel deslizable: sin esto no habría ninguna forma de navegar,
 * porque no entra en el ancho.
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const { role } = useAuth();

  const groups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.adminOnly || role === 'admin'),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          aria-hidden
          className="fixed inset-x-0 bottom-0 z-30 bg-black/50 md:hidden"
          style={{ top: 'calc(3.5rem + var(--safe-top))' }}
        />
      )}
      <nav
        className={cn(
          'fixed left-0 z-40 flex w-60 flex-col overflow-y-auto bg-ink py-5',
          'transition-transform duration-200 md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{
          top: 'calc(3.5rem + var(--safe-top))',
          height: 'calc(100vh - 3.5rem - var(--safe-top))',
          paddingBottom: 'calc(1.25rem + var(--safe-bottom))',
        }}
      >
        {groups.map((group) => (
          <div key={group.label} className="mb-5 last:mb-0">
            <div className="mb-2 px-5">
              <span className="font-display text-[11px] uppercase tracking-[0.18em] text-white/40">
                {group.label}
              </span>
            </div>
            <ul>
              {group.items.map((item) => {
                const isActive =
                  location.pathname === item.path ||
                  (item.path !== '/' && location.pathname.startsWith(item.path));

                return (
                  <li key={item.path}>
                    <Link
                      to={item.path}
                      onClick={onClose}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-3 border-l-[3px] px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.04em] transition-colors',
                        isActive
                          ? 'border-accent bg-ink-hover text-accent'
                          : 'border-transparent text-white/70 hover:bg-ink-hover hover:text-white'
                      )}
                    >
                      <item.icon size={17} strokeWidth={2} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
