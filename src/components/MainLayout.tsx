import React from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { CategoryRail } from './CategoryRail';
import { TopNavBar } from './TopNavBar';
import logo from '@/src/assets/logo-luciano-diesel.png';

interface MainLayoutProps {
  children: React.ReactNode;
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

  /*
    La barra arranca contraída siempre, sin importar cómo haya quedado la vez
    anterior. El ancho de la pantalla es para los datos: la barra se despliega
    cuando hace falta buscar un módulo y se vuelve a cerrar sola al recargar.
    Antes se recordaba la última posición en localStorage, y eso hacía que un
    despliegue de hace tres días siguiera comiéndose el ancho hoy.
  */
  const [railCollapsed, setRailCollapsed] = React.useState(true);

  // Al navegar, el panel deslizable se cierra solo.
  React.useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  /**
   * Entrar a cargar algo contrae la barra; al salir vuelve a como la había
   * dejado el usuario en esta sesión. Contraerla ahí es una conveniencia del
   * momento, no una decisión suya: si la tenía desplegada para navegar, se la
   * devolvemos cuando termina de cargar.
   */
  const comoLaDejo = React.useRef(true);
  const cargandoAntes = React.useRef(esPantallaDeCarga(location.pathname));
  React.useEffect(() => {
    const cargando = esPantallaDeCarga(location.pathname);
    if (cargando === cargandoAntes.current) return;
    cargandoAntes.current = cargando;
    setRailCollapsed(cargando ? true : comoLaDejo.current);
  }, [location.pathname]);

  function toggleRail() {
    setRailCollapsed((collapsed) => {
      const next = !collapsed;
      comoLaDejo.current = next;
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
        <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-text-soft">
          <span className="flex items-center gap-2">
            <img src={logo} alt="Luciano Diesel" className="h-5 w-auto" />
            <span>Sistema de gestión de taller</span>
          </span>
          <span className="font-mono text-[12px] text-text-faint">
            Inyección diesel · Bosch · Delphi · Denso · CAT
          </span>
        </div>
      </footer>
    </div>
  );
}
