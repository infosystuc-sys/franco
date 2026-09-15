import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // El identificador del paquete se deja como está: cambiarlo publica la app
  // como una app nueva en Play Store y rompe las instalaciones existentes.
  // El nombre visible sí se actualiza — es lo que se ve bajo el ícono.
  appId: 'ar.com.dieselpro.erp',
  appName: 'Luciano Diesel',
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
