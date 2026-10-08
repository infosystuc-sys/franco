import React from 'react';
import { cn } from '@/src/lib/utils';

/**
 * La parte de arriba de un listado (título, botones y filtros) que queda fija
 * al bajar por la tabla, justo debajo de la barra superior. Mide su alto y se
 * lo avisa a los títulos de columna (clase "tabla-fija"), que se pegan
 * debajo de ella: así título, filtros y encabezado de la tabla siguen a la
 * vista mientras se recorren las filas.
 */
export function CabeceraFija({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raiz = document.documentElement;
    const medir = () => raiz.style.setProperty('--cabecera-fija-alto', `${el.offsetHeight}px`);
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => {
      observador.disconnect();
      raiz.style.removeProperty('--cabecera-fija-alto');
    };
  }, []);

  return (
    <div ref={ref} className={cn('cabecera-fija -mx-5 px-5', className)}>
      {children}
    </div>
  );
}
