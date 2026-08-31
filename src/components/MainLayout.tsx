import React from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { CategoryRail } from './CategoryRail';
import { TopNavBar } from './TopNavBar';

interface MainLayoutProps {
  children: React.ReactNode;
}

const RAIL_COLLAPSED_KEY = 'dieselpro:rail-collapsed';

export function MainLayout({ children }: MainLayoutProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [railCollapsed, setRailCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem(RAIL_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const location = useLocation();

  // Al navegar, el panel deslizable se cierra solo.
  React.useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  function toggleRail() {
    setRailCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, String(next));
      } catch {
        // Sin localStorage (modo privado, etc.) el toggle sigue andando, solo no se recuerda.
      }
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-surface text-text selection:bg-accent selection:text-accent-ink">
      <TopNavBar
        onMenuClick={() => setMenuOpen((open) => !open)}
        menuOpen={menuOpen}
        railCollapsed={railCollapsed}
        onToggleRail={toggleRail}
      />
      <CategoryRail open={menuOpen} onClose={() => setMenuOpen(false)} collapsed={railCollapsed} />

      <main
        className={cn(
          'print-area px-5 py-6 pb-16 transition-[margin] duration-200',
          railCollapsed ? 'md:ml-0' : 'md:ml-60'
        )}
        style={{ marginTop: 'calc(3.5rem + var(--safe-top))' }}
      >
        {children}
      </main>

      <footer
        className={cn(
          'no-print border-t border-line bg-panel px-5 py-3 transition-[margin] duration-200',
          railCollapsed ? 'md:ml-0' : 'md:ml-60'
        )}
        style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-text-soft">
          <span>
            <span className="font-display font-semibold uppercase tracking-[0.1em] text-accent-deep">
              DieselPro
            </span>
            <span className="ml-2">Sistema de gestión de taller</span>
          </span>
          <span className="font-mono text-[10px] text-text-faint">
            Inyección diesel · Bosch · Delphi · Denso · CAT
          </span>
        </div>
      </footer>
    </div>
  );
}
