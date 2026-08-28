import React from 'react';
import { useLocation } from 'react-router-dom';
import { CategoryRail } from './CategoryRail';
import { TopNavBar } from './TopNavBar';

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const location = useLocation();

  // Al navegar, el panel deslizable se cierra solo.
  React.useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-surface text-text selection:bg-accent selection:text-accent-ink">
      <TopNavBar onMenuClick={() => setMenuOpen((open) => !open)} menuOpen={menuOpen} />
      <CategoryRail open={menuOpen} onClose={() => setMenuOpen(false)} />

      <main
        className="print-area px-5 py-6 pb-16 md:ml-60"
        style={{ marginTop: 'calc(3.5rem + var(--safe-top))' }}
      >
        {children}
      </main>

      <footer
        className="no-print border-t border-line bg-panel px-5 py-3 md:ml-60"
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
