import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {isSupabaseConfigured} from './lib/supabase.ts';
import './index.css';

const raiz = createRoot(document.getElementById('root')!);

/*
  Las credenciales se incrustan al compilar. Si faltan, el cliente de Supabase
  falla al arrancar y la pantalla queda en blanco, con el motivo escondido en
  la consola. Preferimos decirlo.
*/
if (!isSupabaseConfigured) {
  raiz.render(
    <div className="mx-auto max-w-lg p-8 font-sans text-text">
      <h1 className="mb-3 font-display text-2xl uppercase">Falta la configuración</h1>
      <p className="mb-4 text-sm">
        No están cargadas las variables <code className="font-mono">VITE_SUPABASE_URL</code> y{' '}
        <code className="font-mono">VITE_SUPABASE_ANON_KEY</code>. La aplicación no puede
        conectarse a la base de datos.
      </p>
      <p className="text-sm text-text-soft">
        En Vercel se cargan en Settings → Environment Variables. Después hay que volver a
        desplegar: se incrustan al compilar, no se leen en cada visita.
      </p>
    </div>
  );
} else {
  raiz.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
