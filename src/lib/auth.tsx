import React from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/src/lib/supabase';
import type { Modulos } from '@/src/lib/menuCategories';

export type UserRole = 'admin' | 'operario' | 'contador';

interface AuthState {
  session: Session | null;
  role: UserRole | null;
  /** Módulos habilitados para un admin: null es todo el sistema. Ver profiles.modulos. */
  modulos: Modulos;
  /** Permiso de pantalla: ver el listado histórico de comprobantes (Facturación, Cobranzas, Pagos, Compras, Tesorería). No es una guarda de datos, ver profiles-can-view-history.sql. */
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
  const [modulos, setModulos] = React.useState<Modulos>(null);
  const [mustChangePassword, setMustChangePassword] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  // A quién pertenece la sesión actual, para distinguir "cambió la persona"
  // de "se renovó el token de la misma persona". RequireAuth reemplaza TODA
  // la app por "Cargando..." mientras loading es true, así que ese flag solo
  // se toca cuando de verdad hay alguien entrando o saliendo — nunca en una
  // renovación, o cualquier modal abierto (y lo que se hubiera tipeado ahí)
  // se perdía cada vez que Supabase revalida el token al volver de otra
  // pestaña.
  const usuarioActualRef = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    let cancelled = false;

    async function loadRole(userId: string) {
      let { data, error } = await supabase
        .from('profiles')
        .select('role, must_change_password, modulos')
        .eq('id', userId)
        .maybeSingle();
      // Sin la migración de permisos la columna no existe: se entra igual, con todo.
      if (error) {
        ({ data } = await supabase
          .from('profiles')
          .select('role, must_change_password')
          .eq('id', userId)
          .maybeSingle());
      }
      if (cancelled) return;
      setRole((data?.role as UserRole) ?? null);
      setModulos(((data as { modulos?: string[] | null } | null)?.modulos as Modulos) ?? null);
      setMustChangePassword(data?.must_change_password ?? false);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      usuarioActualRef.current = data.session?.user.id;
      setSession(data.session);
      if (data.session) loadRole(data.session.user.id).finally(() => !cancelled && setLoading(false));
      else setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      const cambioDePersona = usuarioActualRef.current !== newSession?.user.id;
      usuarioActualRef.current = newSession?.user.id;
      setSession(newSession);
      if (!cambioDePersona) return; // solo se renovó el token: nada más que hacer

      if (newSession) {
        setLoading(true);
        loadRole(newSession.user.id).finally(() => !cancelled && setLoading(false));
      } else {
        setRole(null);
        setModulos(null);
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
      value={{ session, role, modulos, mustChangePassword, markPasswordChanged, loading, signOut }}
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
