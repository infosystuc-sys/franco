import React from 'react';
import { Search, Bell, LogOut, Menu, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';

export function TopNavBar({
  onMenuClick,
  menuOpen,
  railCollapsed,
  onToggleRail,
}: {
  onMenuClick: () => void;
  menuOpen: boolean;
  railCollapsed: boolean;
  onToggleRail: () => void;
}) {
  const { session, role, signOut } = useAuth();

  return (
    <header
      className="no-print fixed top-0 z-50 flex w-full items-center justify-between gap-3 border-b border-ink-line bg-ink px-4"
      /* En Android la barra de estado se superpone: se agrega su alto arriba. */
      style={{ height: 'calc(3.5rem + var(--safe-top))', paddingTop: 'var(--safe-top)' }}
    >
      <div className="flex min-w-0 items-center gap-3">
        {/* En pantallas chicas el menú lateral no entra: se abre desde acá. */}
        <button
          onClick={onMenuClick}
          aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={menuOpen}
          className="p-1.5 text-accent transition-colors hover:bg-ink-hover md:hidden"
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
        {/* En pantallas grandes el menú queda persistente, pero se puede ocultar para ganar ancho de trabajo. */}
        <button
          onClick={onToggleRail}
          aria-label={railCollapsed ? 'Mostrar menú' : 'Ocultar menú'}
          aria-expanded={!railCollapsed}
          className="hidden p-1.5 text-accent transition-colors hover:bg-ink-hover md:inline-flex"
        >
          {railCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
        </button>
        <Link to="/" className="flex items-baseline gap-1.5 transition-opacity hover:opacity-80">
          <span className="font-display text-2xl font-semibold uppercase leading-none tracking-[0.02em] text-accent">
            DieselPro
          </span>
          <span className="font-display text-sm font-light uppercase leading-none tracking-[0.2em] text-white/60">
            ERP
          </span>
        </Link>
      </div>

      <div className="mx-3 hidden max-w-md flex-1 md:flex">
        <div className="relative w-full">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50" />
          <input
            className="h-8 w-full border border-ink-line bg-ink-hover pl-9 pr-3 text-xs text-white placeholder:text-white/50 focus:border-accent focus:outline-none"
            placeholder="Buscar..."
            type="text"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          aria-label="Notificaciones"
          className="p-1.5 text-accent transition-colors hover:bg-ink-hover"
        >
          <Bell size={18} />
        </button>
        {session && (
          <div className="ml-1 hidden flex-col items-end leading-tight md:flex">
            <span className="text-xs font-medium text-white">{session.user.email}</span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-accent">{role ?? '…'}</span>
          </div>
        )}
        <button
          onClick={() => signOut()}
          title="Cerrar sesión"
          aria-label="Cerrar sesión"
          className="p-1.5 text-accent transition-colors hover:bg-ink-hover"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
