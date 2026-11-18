/**
 * Cómo se cargó la última compra: a mano o con IA, de artículos o de
 * conceptos. El botón "Nueva" del listado de compras abre la misma forma,
 * para no tener que elegirla cada vez (y para no caer en la carga manual
 * después de venir cargando con IA).
 *
 * Se guarda en el navegador: es una comodidad de quien carga, no un dato.
 */

export type ViaDeCarga = 'manual' | 'ia';
export type ClaseDeCompra = 'articulos' | 'conceptos';

export interface ModoDeCarga {
  via: ViaDeCarga;
  clase: ClaseDeCompra;
}

const CLAVE = 'ludiesel:modo-de-carga-de-compras';
const POR_DEFECTO: ModoDeCarga = { via: 'manual', clase: 'articulos' };

export function recordarModoDeCarga(modo: ModoDeCarga): void {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(modo));
  } catch {
    // Sin almacenamiento (ventana privada): se sigue con el de siempre.
  }
}

export function ultimoModoDeCarga(): ModoDeCarga {
  try {
    const guardado = JSON.parse(localStorage.getItem(CLAVE) ?? 'null');
    if (
      guardado &&
      (guardado.via === 'manual' || guardado.via === 'ia') &&
      (guardado.clase === 'articulos' || guardado.clase === 'conceptos')
    ) {
      return guardado;
    }
  } catch {
    // Valor roto o sin almacenamiento.
  }
  return POR_DEFECTO;
}

export function rutaDeCarga({ via, clase }: ModoDeCarga): string {
  return via === 'ia' ? `/compras-ia/nueva/${clase}` : `/compras/nueva/${clase}`;
}

export function nombreDelModo({ via, clase }: ModoDeCarga): string {
  return `${clase === 'articulos' ? 'artículos' : 'conceptos'} ${via === 'ia' ? 'con IA' : 'a mano'}`;
}

export const MODOS_DE_CARGA: ModoDeCarga[] = [
  { via: 'manual', clase: 'articulos' },
  { via: 'manual', clase: 'conceptos' },
  { via: 'ia', clase: 'articulos' },
  { via: 'ia', clase: 'conceptos' },
];
