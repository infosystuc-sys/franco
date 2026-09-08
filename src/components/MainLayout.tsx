import React from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { CategoryRail } from './CategoryRail';
import { TopNavBar } from './TopNavBar';

interface MainLayoutProps {
  children: React.ReactNode;
}

const RAIL_COLLAPSED_KEY = 'dieselpro:rail-collapsed';

function preferenciaGuardada(): boolean {
  try {
    // Arranca contraída: la pantalla de inicio es el menú de módulos, y la
    // barra desplegada le come el ancho repitiendo lo mismo que ya se ve.
    // Si el usuario la despliega, su preferencia manda de ahí en más.
    const guardado = localStorage.getItem(RAIL_COLLAPSED_KEY);
    return guardado === null ? true : guardado === 'true';
  } catch {
    return true;
  }
}

/**
 * Las pantallas donde se está cargando algo: un comprobante nuevo, una
 * recepción, una facturación. Ahí el ancho es para el formulario, no para un
 * menú que en ese momento no se usa.
 *
 * Se mira la ruta y no una lista de pantallas para que un alta nueva quede
 * incluida sola: en esta app toda carga vive bajo "nuevo" o "nueva".
 */
export function esPantallaDeCarga(pathname: string): boolean {
  const partes = pathname.toLowerCase().split('/').filter(Boolean);
  if (partes.includes('nuevo') || partes.includes('nueva')) return true;
  // Las tres que no siguen esa convención pero son igual de carga.
  if (partes[0] === 'facturar') return true;
  if (partes[0] === 'compras-ia' && partes[1] === 'revisar') return true;
  return partes[0] === 'tesoreria' && partes[1] === 'endosar-cheque';
}

export function MainLayout({ children }: MainLayoutProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const location = useLocation();
  // Entrar directo por URL a una pantalla de carga también arranca contraída:
  // el efecto de abajo solo reacciona a los cambios de ruta, no al montaje.
  const [railCollapsed, setRailCollapsed] = React.useState(
    () => preferenciaGuardada() || esPantallaDeCarga(location.pathname)
  );

  // Al navegar, el panel deslizable se cierra solo.
  React.useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  /**
   * Entrar a cargar algo contrae la barra; salir devuelve la preferencia del
   * usuario. No se guarda: contraerla acá es una conveniencia del momento, no
   * una decisión suya, y pisarle la preferencia sería quedarse con ella para
   * siempre. Mientras carga puede desplegarla a mano igual.
   */
  const cargandoAntes = React.useRef(esPantallaDeCarga(location.pathname));
  React.useEffect(() => {
    const cargando = esPantallaDeCarga(location.pathname);
    if (cargando === cargandoAntes.current) return;
    cargandoAntes.current = cargando;
    setRailCollapsed(cargando ? true : preferenciaGuardada());
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
