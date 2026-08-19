import { Capacitor } from '@capacitor/core';

/** True solo cuando corre dentro del contenedor Android, no en el navegador. */
export const isNativeApp = Capacitor.isNativePlatform();

/**
 * Ajustes que solo tienen sentido dentro de la app de Android.
 * En el navegador no hace nada, así que la web queda intacta.
 *
 * Los plugins se importan de forma diferida: en la web los módulos nativos
 * no se descargan siquiera.
 */
export async function setupNativeApp(onBack: () => boolean): Promise<void> {
  if (!isNativeApp) return;

  try {
    // La barra de estado toma el grafito de la app en vez del blanco del sistema.
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#2b2b2b' });
  } catch {
    // En algunas versiones de Android el color de la barra no es configurable.
    // No es motivo para romper el arranque de la app.
  }

  try {
    const { App } = await import('@capacitor/app');
    // El botón físico de volver debe navegar hacia atrás, no cerrar la app.
    // Solo se sale cuando ya no queda a dónde volver.
    App.addListener('backButton', ({ canGoBack }) => {
      const manejado = onBack();
      if (manejado) return;
      if (canGoBack) window.history.back();
      else App.exitApp();
    });
  } catch {
    // Sin el plugin, Android usa su comportamiento por defecto.
  }
}
