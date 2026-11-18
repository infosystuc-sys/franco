import React from 'react';
import { leerNumero, numeroParaEditar } from '@/src/lib/numeros';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'> & {
  /** null o undefined: el campo vacío. */
  value: number | null | undefined;
  /** El número leído, o null si el campo quedó vacío (o a medio escribir, como "-"). */
  onValor: (valor: number | null) => void;
};

/**
 * Campo para importes y cantidades que acepta el punto del teclado numérico
 * y la coma por igual.
 *
 * Un <input type="number"> descartaba el punto del teclado numérico en una
 * PC configurada en español: "12." no es un número para el navegador, el
 * campo devolvía vacío y el valor volvía a 0. Este es un campo de texto: lo
 * que se escribe queda tal cual mientras se edita, y afuera se informa el
 * número ya leído. Al salir del campo se muestra con coma decimal.
 */
export function NumeroInput({ value, onValor, onFocus, onBlur, ...rest }: Props) {
  // Lo que se está escribiendo. null = no se está editando: se muestra el valor.
  const [texto, setTexto] = React.useState<string | null>(null);
  const mostrado = texto ?? numeroParaEditar(value);

  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={mostrado}
      onFocus={(e) => {
        setTexto(numeroParaEditar(value));
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setTexto(null);
        onBlur?.(e);
      }}
      onChange={(e) => {
        const limpio = e.target.value.replace(/[^\d.,-]/g, '');
        setTexto(limpio);
        onValor(leerNumero(limpio, { puntoDeMiles: false }));
      }}
    />
  );
}
