import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from '@/src/lib/supabase';
import { useAuth } from '@/src/lib/auth';
import { Button, Label, fieldClass } from '@/src/components/ui';

/**
 * El login de la mayoría de los usuarios no es un email real: gestionar-empleado
 * arma uno falso (usuario@taller.local) porque Supabase Auth solo entiende
 * email. Si lo que se tipeó ya tiene arroba (la cuenta del dueño, con su
 * casilla real) se manda tal cual; si no, se completa con el mismo dominio.
 */
function resolveLoginEmail(input: string): string {
  const trimmed = input.trim();
  return trimmed.includes('@') ? trimmed : `${trimmed.toLowerCase()}@taller.local`;
}

export function Login() {
  const { session, loading } = useAuth();
  const location = useLocation();
  const [usuario, setUsuario] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  if (!loading && session) {
    const from = (location.state as { from?: string })?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: resolveLoginEmail(usuario),
      password,
    });
    if (error) setError(error.message);
    setSubmitting(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink p-4">
      <div className="w-full max-w-sm border border-line-strong bg-panel">
        {/* La franja amarilla es la misma señal que ordena toda la app. */}
        <div className="h-1.5 w-full bg-accent" />

        <div className="px-7 pb-7 pt-6">
          <div className="mb-7">
            <div className="flex items-baseline gap-1.5">
              <span className="font-display text-3xl font-semibold uppercase leading-none tracking-[0.02em] text-text">
                DieselPro
              </span>
              <span className="font-display text-base font-light uppercase leading-none tracking-[0.2em] text-text-faint">
                ERP
              </span>
            </div>
            <p className="mt-2 text-sm text-text-soft">Gestión de taller de inyección diesel</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
                {error}
              </div>
            )}

            <Label>
              Usuario
              <input
                type="text"
                required
                autoComplete="username"
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
                className={fieldClass(true, 'font-normal normal-case')}
              />
            </Label>

            <Label>
              Contraseña
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={fieldClass(true, 'font-normal normal-case')}
              />
            </Label>

            <Button type="submit" disabled={submitting} className="w-full justify-center py-2.5">
              {submitting ? 'Ingresando…' : 'Ingresar'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
