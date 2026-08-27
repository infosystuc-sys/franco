import React from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/src/lib/supabase';

export type UserRole = 'admin' | 'operario';

interface AuthState {
  session: Session | null;
  role: UserRole | null;
  /** Permiso de pantalla: ver el listado histórico de comprobantes (Facturación, Cobranzas, Pagos, Compras, Tesorería). No es una guarda de datos, ver profiles-can-view-history.sql. */
  canViewHistory: boolean;
  /** true hasta que el usuario cambie la contraseña inicial (1234) que se le asigna al crearlo. */
  mustChangePassword: boolean;
  /** Confirma el cambio de contraseña ya hecho: apaga el flag en la base y en el estado local. */
  markPasswordChanged: () => Promise<void>;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [role, setRole] = React.useState<UserRole | null>(null);
  const [canViewHistory, setCanViewHistory] = React.useState(true);
  const [mustChangePassword, setMustChangePassword] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    async function loadRole(userId: string) {
      const { data } = await supabase
        .from('profiles')
        .select('role, can_view_history, must_change_password')
        .eq('id', userId)
        .maybeSingle();
      if (cancelled) return;
      setRole((data?.role as UserRole) ?? null);
      setCanViewHistory(data?.can_view_history ?? true);
      setMustChangePassword(data?.must_change_password ?? false);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      if (data.session) loadRole(data.session.user.id).finally(() => !cancelled && setLoading(false));
      else setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession) {
        setLoading(true);
        loadRole(newSession.user.id).finally(() => !cancelled && setLoading(false));
      } else {
        setRole(null);
        setCanViewHistory(true);
        setMustChangePassword(false);
      }
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signOut = React.useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const markPasswordChanged = React.useCallback(async () => {
    const { error } = await supabase.rpc('mark_password_changed');
    if (error) throw error;
    setMustChangePassword(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{ session, role, canViewHistory, mustChangePassword, markPasswordChanged, loading, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
