import { Link } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { MODOS_DE_CARGA, rutaDeCarga, type ModoDeCarga } from '@/src/lib/modoDeCargaCompra';

/**
 * Las cuatro formas de cargar una compra, a la vista y en un solo lugar:
 * artículos o conceptos, a mano o con IA. Se pasa de una a otra sin volver
 * al listado ni buscar en los menús.
 */
export function SelectorModoDeCarga({ actual }: { actual: ModoDeCarga }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 text-[13px]">
      <span className="font-semibold uppercase tracking-[0.06em] text-text-soft">Cargar</span>
      <div className="inline-flex flex-wrap overflow-hidden rounded-md border border-line-strong">
        {MODOS_DE_CARGA.map((m) => {
          const elegido = m.via === actual.via && m.clase === actual.clase;
          return (
            <Link
              key={`${m.via}-${m.clase}`}
              to={rutaDeCarga(m)}
              aria-current={elegido ? 'page' : undefined}
              className={cn(
                'border-r border-line-strong px-3 py-1.5 font-semibold uppercase tracking-[0.05em] transition-colors last:border-r-0',
                elegido ? 'bg-accent text-accent-ink' : 'bg-panel text-text-soft hover:bg-panel-alt hover:text-text'
              )}
            >
              {m.clase === 'articulos' ? 'Artículos' : 'Conceptos'} · {m.via === 'ia' ? 'con IA' : 'a mano'}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
