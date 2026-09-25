import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export type CanalEnvio = 'email' | 'whatsapp';
export type AccionDesdeListado = 'imprimir' | 'ticket' | 'descargar' | CanalEnvio;

/** Cómo le pide el listado a la ficha que haga algo: un parámetro en la URL. */
export function urlDeAccion(ficha: string, accion: AccionDesdeListado): string {
  switch (accion) {
    case 'imprimir': return `${ficha}?imprimir=1`;
    case 'ticket': return `${ficha}?ticket=1`;
    case 'descargar': return `${ficha}?descargar=1`;
    default: return `${ficha}?enviar=${accion}`;
  }
}

function leerAccion(params: URLSearchParams): AccionDesdeListado | null {
  if (params.get('imprimir') === '1') return 'imprimir';
  if (params.get('ticket') === '1') return 'ticket';
  if (params.get('descargar') === '1') return 'descargar';
  const canal = params.get('enviar');
  if (canal === 'email' || canal === 'whatsapp') return canal;
  return null;
}

/**
 * Los botones del listado de comprobantes (Imprimir, Descargar, Enviar…) no
 * tienen su propia forma de armar el papel: abren la ficha del comprobante,
 * que ya sabe dibujarlo, y le piden la acción por la URL. Así hay una sola
 * versión de cada comprobante impreso, y no dos que se despegan.
 *
 * Imprimir y descargar vuelven solos al listado al terminar; el envío abre el
 * modal y la ficha vuelve al cerrarlo (ver vinoDelListado).
 *
 * Se espera a que el documento esté cargado y en condiciones —`listo`— y la
 * acción corre una sola vez.
 */
export function useAccionDesdeListado({
  listo,
  listado,
  documentRef,
  nombreArchivo,
  abrirEnvio,
}: {
  listo: boolean;
  listado: string;
  documentRef: React.RefObject<HTMLDivElement>;
  nombreArchivo: string;
  abrirEnvio: (canal: CanalEnvio) => void;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accion = leerAccion(searchParams);
  const hecha = React.useRef(false);
  const [descargando, setDescargando] = React.useState(false);

  React.useEffect(() => {
    if (hecha.current || !accion || !listo) return;
    // Un respiro para que el navegador termine de pintar el documento antes
    // de imprimirlo o fotografiarlo. La marca se pone recién adentro: en
    // desarrollo React monta el efecto dos veces.
    const t = setTimeout(async () => {
      if (hecha.current) return;
      hecha.current = true;

      if (accion === 'imprimir' || accion === 'ticket') {
        window.addEventListener('afterprint', () => navigate(listado), { once: true });
        window.print();
        return;
      }

      if (accion === 'descargar') {
        if (!documentRef.current) return;
        setDescargando(true);
        try {
          const { downloadElementAsPdf } = await import('@/src/lib/pdf');
          await downloadElementAsPdf(documentRef.current, nombreArchivo);
          navigate(listado);
        } catch {
          window.alert('No se pudo armar el PDF. Probá de nuevo desde la ficha.');
        } finally {
          setDescargando(false);
        }
        return;
      }

      abrirEnvio(accion);
    }, 300);
    return () => clearTimeout(t);
  }, [accion, listo, listado, navigate, documentRef, nombreArchivo, abrirEnvio]);

  return {
    accion,
    /** Llegó desde el listado a hacer algo puntual: al terminar, vuelve ahí. */
    vinoDelListado: accion !== null,
    descargando,
    volverAlListado: () => navigate(listado),
  };
}
