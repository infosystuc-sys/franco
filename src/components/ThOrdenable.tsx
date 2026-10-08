import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { siguienteOrden, type Orden } from '@/src/lib/ordenar';

/**
 * Título de columna que ordena la tabla al hacer click: de menor a mayor, de
 * mayor a menor, y al tercer click vuelve al orden original. La flechita
 * marca la columna ordenada y el sentido.
 */
export function ThOrdenable({
  columna,
  orden,
  onOrden,
  children,
  className,
  derecha,
}: {
  columna: string;
  orden: Orden | null;
  onOrden: (orden: Orden | null) => void;
  children: React.ReactNode;
  className?: string;
  derecha?: boolean;
}) {
  const activa = orden?.columna === columna;
  return (
    <th
      scope="col"
      aria-sort={activa ? (orden!.sentido === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(className, derecha && 'text-right')}
    >
      <button
        type="button"
        onClick={() => onOrden(siguienteOrden(orden, columna))}
        title="Ordenar por esta columna"
        className={cn(
          'inline-flex cursor-pointer select-none items-center gap-1 whitespace-nowrap text-left text-inherit hover:underline',
          derecha && 'flex-row-reverse'
        )}
        style={{ font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit' }}
      >
        {children}
        {activa ? (
          orden!.sentido === 'asc' ? (
            <ChevronUp size={15} className="shrink-0" />
          ) : (
            <ChevronDown size={15} className="shrink-0" />
          )
        ) : null}
      </button>
    </th>
  );
}
