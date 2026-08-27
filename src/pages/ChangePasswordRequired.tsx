import React from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { useAuth } from '@/src/lib/auth';
import { supabase } from '@/src/lib/supabase';
import { getErrorMessage } from '@/src/lib/workOrders';

/**
 * Pantalla obligatoria antes de entrar a cualquier otra parte de la app: se
 * muestra cuando el usuario todavía tiene la contraseña inicial (1234) que
 * se le asigna al crearlo. No hay forma de saltearla más que cerrar sesión.
 */
export function ChangePasswordRequired() {
  const { markPasswordChanged, signOut } = useAuth();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const tooCorta = password.length > 0 && password.length < 6;
  const noCoinciden = confirm.length > 0 && password !== confirm;
  const puedeGuardar = password.length >= 6 && password === confirm && !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar) return;
    setSaving(true);
    setError(null);
    try {
      const { error: errorClave } = await supabase.auth.updateUser({ password });
      if (errorClave) throw errorClave;
      await markPasswordChanged();
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-panel-alt p-4">
      <div className="w-full max-w-sm bg-panel border border-line p-6 space-y-4">
        <div className="flex items-center gap-2 text-accent-deep">
          <KeyRound size={20} />
          <h1 className="text-lg font-bold text-text">Cambiá tu contraseña</h1>
        </div>
        <p className="text-sm text-text-soft">
          Todavía tenés la contraseña inicial. Elegí una nueva antes de seguir — es lo único que
          podés hacer hasta que la cambies.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {error && (
            <div className="bg-danger-soft border border-danger/40 text-danger text-xs px-3 py-2">{error}</div>
          )}

          <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
            Contraseña nueva
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="mt-1 w-full border border-line bg-panel px-3 py-2 pr-9 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
                placeholder="Mínimo 6 caracteres"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                title={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                className="absolute right-2 top-1/2 -translate-y-1/2 mt-0.5 text-text-soft hover:text-text"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {tooCorta && <span className="mt-1 block text-[10px] font-normal normal-case text-danger">Mínimo 6 caracteres.</span>}
          </label>

          <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
            Repetí la contraseña
            <input
              type={showPassword ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
            />
            {noCoinciden && <span className="mt-1 block text-[10px] font-normal normal-case text-danger">No coincide.</span>}
          </label>

          <button
            type="submit"
            disabled={!puedeGuardar}
            className="w-full bg-accent text-accent-ink font-semibold text-[11px] uppercase tracking-wider px-4 py-2.5 hover:bg-accent-deep hover:text-white transition-colors disabled:opacity-50"
          >
            {saving ? 'Guardando...' : 'Guardar y continuar'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => signOut()}
          className="w-full text-center text-[11px] font-semibold uppercase tracking-wider text-text-soft hover:text-text"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
