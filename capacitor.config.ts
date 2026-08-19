import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ar.com.dieselpro.erp',
  appName: 'DieselPro ERP',
  // Vite compila acá; Capacitor copia estos archivos dentro del APK.
  webDir: 'dist',
  android: {
    // El contenido web se dibuja sin rebote elástico, como una app nativa.
    allowMixedContent: false,
  },
  plugins: {
    StatusBar: {
      // Grafito, el mismo de la barra superior de la app.
      backgroundColor: '#2b2b2b',
      style: 'DARK',
      overlaysWebView: false,
    },
  },
};

export default config;
