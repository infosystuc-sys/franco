import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { ChangePasswordRequired } from '@/src/pages/ChangePasswordRequired';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading, mustChangePassword } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-text-soft">Cargando...</div>;
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  // Bloquea cualquier ruta interna hasta que cambie la contraseña inicial:
  // no importa a dónde intentó entrar, no hay forma de saltear esta pantalla.
  if (mustChangePassword) {
    return <ChangePasswordRequired />;
  }

  return <>{children}</>;
}
