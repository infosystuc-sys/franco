import React from 'react';
import { cn } from '@/src/lib/utils';

/**
 * Primitivos visuales de DieselPro.
 *
 * El elemento que da identidad es la REGLA AMARILLA: cada pantalla y cada
 * sección arrancan con un título en mayúscula condensada sobre una línea
 * amarilla. Es lo que ordena la lectura de arriba hacia abajo.
 */

/** Encabezado de pantalla: título grande, acciones a la derecha, regla amarilla. */
export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Datos que acompañan al título en la misma línea (estado, origen, etc.). */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="font-display text-3xl md:text-4xl font-light uppercase tracking-[0.02em] text-text-faint leading-none">
              {title}
            </h1>
            {meta}
          </div>
          {subtitle && <p className="mt-2 text-sm text-text-soft">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-3 h-[3px] w-full bg-accent" />
    </header>
  );
}

/** Encabezado de sección dentro de una pantalla. Misma regla, en menor escala. */
export function SectionHeader({
  title,
  actions,
  className,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg uppercase tracking-[0.08em] text-text-faint leading-none">
          {title}
        </h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-2 h-[2px] w-full bg-accent" />
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover',
  secondary: 'bg-ink text-white hover:bg-ink-hover',
  ghost: 'border border-line-strong bg-panel text-text-soft hover:bg-panel-alt',
  danger: 'bg-danger text-white hover:bg-danger-hover',
};

export function Button({
  variant = 'primary',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center gap-1.5 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em]',
        'transition-colors disabled:opacity-45 disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        className
      )}
    />
  );
}

/** Rótulo sobre el control, como en las pantallas de carga del taller. */
export function Label({
  children,
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      {...props}
      className={cn('block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-soft', className)}
    >
      {children}
    </label>
  );
}

/** Control de formulario. `required` dibuja la barra roja al costado. */
export const inputClass =
  'mt-1 w-full border border-line bg-panel px-3 py-2 text-sm text-text ' +
  'placeholder:text-text-faint focus:border-accent-deep focus:outline-none';

export function fieldClass(required?: boolean, extra?: string) {
  return cn(inputClass, required && 'field-required', extra);
}

/** Panel blanco: el contenedor de tablas y formularios. */
export function Panel({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cn('border border-line bg-panel', className)}>
      {children}
    </div>
  );
}

/**
 * Tira de color al borde izquierdo de una ficha o fila.
 * El color codifica el estado real, no decora: se lee el avance de un vistazo.
 */
export function StateStrip({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('absolute left-0 top-0 h-full w-[5px]', className)}
      style={{ backgroundColor: color }}
    />
  );
}
