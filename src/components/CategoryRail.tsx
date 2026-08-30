import React from 'react';
import { Star, BarChart3 } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { MENU_CATEGORIES, MENU_DIRECT_LINKS, visibleCategories } from '@/src/lib/menuCategories';

/**
 * El riel de categorías: reemplaza al menú de enlaces directos por el
 * esquema de Tango — categorías que llevan a una grilla de tarjetas, más
 * unos pocos enlaces directos (Usuarios, Configuración) abajo. Persiste en
 * todas las pantallas, no solo en el inicio: sirve para saltar de categoría
 * sin volver antes a "/".
 */
export function CategoryRail({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const isContador = role === 'contador';

  const categories = visibleCategories(isAdmin);
  const directLinks = MENU_DIRECT_LINKS.filter((link) => isAdmin || !link.adminOnly);

  // En "/" la categoría activa es la elegida por query; en cualquier otra
  // pantalla, la que contiene la ruta actual — así el riel acompaña la
  // navegación en vez de quedar mudo apenas se entra a un módulo.
  const activeKey =
    location.pathname === '/'
      ? searchParams.get('cat')
      : MENU_CATEGORIES.find((c) =>
          c.sections.some((s) => s.cards.some((card) => location.pathname.startsWith(card.path)))
        )?.key ?? null;

  // El contador no navega por categorías de negocio: su acceso entero es
  // un solo destino, así que el riel se reduce a ese único link.
  if (isContador) {
    return (
      <nav
        className={cn(
          'no-print fixed left-0 z-40 flex w-60 flex-col overflow-y-auto bg-ink py-5',
          'transition-transform duration-200 md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{
          top: 'calc(3.5rem + var(--safe-top))',
          height: 'calc(100vh - 3.5rem - var(--safe-top))',
          paddingBottom: 'calc(1.25rem + var(--safe-bottom))',
        }}
      >
        <ul>
          <li>
            <Link
              to="/informes"
              onClick={onClose}
              aria-current={location.pathname.startsWith('/informe') ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 border-l-[3px] px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.04em] transition-colors',
                location.pathname.startsWith('/informe')
                  ? 'border-accent bg-ink-hover text-accent'
                  : 'border-transparent text-white/70 hover:bg-ink-hover hover:text-white'
              )}
            >
              <BarChart3 size={17} strokeWidth={2} />
              Informes
            </Link>
          </li>
        </ul>
      </nav>
    );
  }

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
          'no-print fixed left-0 z-40 flex w-60 flex-col overflow-y-auto bg-ink py-5',
          'transition-transform duration-200 md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{
          top: 'calc(3.5rem + var(--safe-top))',
          height: 'calc(100vh - 3.5rem - var(--safe-top))',
          paddingBottom: 'calc(1.25rem + var(--safe-bottom))',
        }}
      >
        <ul className="mb-3">
          <li>
            <Link
              to="/?cat=favoritos"
              onClick={onClose}
              aria-current={activeKey === 'favoritos' ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 border-l-[3px] px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.04em] transition-colors',
                activeKey === 'favoritos'
                  ? 'border-accent bg-ink-hover text-accent'
                  : 'border-transparent text-white/70 hover:bg-ink-hover hover:text-white'
              )}
            >
              <Star size={17} strokeWidth={2} />
              Favoritos
            </Link>
          </li>
        </ul>

        <ul className="mb-3 border-t border-ink-line pt-3">
          {categories.map((category) => {
            const isActive = activeKey === category.key;
            return (
              <li key={category.key}>
                <Link
                  to={`/?cat=${category.key}`}
                  onClick={onClose}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 border-l-[3px] px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.04em] transition-colors',
                    isActive
                      ? 'border-accent bg-ink-hover text-accent'
                      : 'border-transparent text-white/70 hover:bg-ink-hover hover:text-white'
                  )}
                >
                  <category.icon size={17} strokeWidth={2} />
                  {category.label}
                </Link>
              </li>
            );
          })}
        </ul>

        {directLinks.length > 0 && (
          <ul className="border-t border-ink-line pt-3">
            {directLinks.map((link) => {
              const isActive = location.pathname.startsWith(link.path);
              return (
                <li key={link.path}>
                  <Link
                    to={link.path}
                    onClick={onClose}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 border-l-[3px] px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.04em] transition-colors',
                      isActive
                        ? 'border-accent bg-ink-hover text-accent'
                        : 'border-transparent text-white/70 hover:bg-ink-hover hover:text-white'
                    )}
                  >
                    <link.icon size={17} strokeWidth={2} />
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </>
  );
}
