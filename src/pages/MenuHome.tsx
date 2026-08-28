import React from 'react';
import { Star, List, Plus } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Panel } from '@/src/components/ui';
import { getFavorites, isFavorite, toggleFavorite } from '@/src/lib/favorites';
import {
  SECTION_COLORS,
  SECTION_TITLES,
  allCards,
  sectionColorForPath,
  visibleCategories,
  type MenuCard,
  type SectionColor,
} from '@/src/lib/menuCategories';

/**
 * Pantalla de inicio para el admin: la grilla de tarjetas por categoría,
 * estilo Tango. Qué categoría se ve sale de ?cat= en la URL —así el riel
 * (CategoryRail) y esta pantalla comparten la misma fuente de verdad y no
 * hace falta un estado aparte que se pueda desincronizar entre los dos.
 */
export function MenuHome() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [searchParams] = useSearchParams();
  const [favorites, setFavorites] = React.useState<string[]>(() => getFavorites());

  const categories = visibleCategories(isAdmin);
  const requested = searchParams.get('cat');
  const activeKey = requested ?? (favorites.length > 0 ? 'favoritos' : categories[0]?.key ?? 'favoritos');

  function handleToggleFavorite(path: string) {
    setFavorites(toggleFavorite(path));
  }

  if (activeKey === 'favoritos') {
    const favoriteCards = allCards(isAdmin).filter((card) => favorites.includes(card.path));
    return (
      <div className="mx-auto max-w-6xl">
        <CategoryTitle icon={Star} label="Favoritos" />
        {favoriteCards.length === 0 ? (
          <Panel className="p-6 text-center text-sm text-text-soft">
            Todavía no marcaste ningún módulo como favorito. Tocá la estrella de una tarjeta para
            que aparezca acá.
          </Panel>
        ) : (
          <CardGrid
            cards={favoriteCards.map((card) => ({ card, color: sectionColorForPath(card.path, isAdmin) ?? 'padrones' }))}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
          />
        )}
      </div>
    );
  }

  const category = categories.find((c) => c.key === activeKey) ?? categories[0];

  if (!category) {
    return (
      <div className="mx-auto max-w-6xl">
        <Panel className="p-6 text-center text-sm text-text-soft">No hay módulos disponibles.</Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <CategoryTitle icon={category.icon} label={category.label} />
      <div className="space-y-8">
        {category.sections.map((section) => (
          <section key={section.color}>
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-text-faint">
              {SECTION_TITLES[section.color]}
            </h2>
            <CardGrid
              cards={section.cards.map((card) => ({ card, color: section.color }))}
              favorites={favorites}
              onToggleFavorite={handleToggleFavorite}
            />
          </section>
        ))}
      </div>
    </div>
  );
}

function CategoryTitle({ icon: Icon, label }: { icon: React.ComponentType<{ size?: number }>; label: string }) {
  return (
    <div className="mb-6 flex items-center gap-2 border-b-2 border-accent pb-3">
      <Icon size={20} />
      <h1 className="font-display text-2xl font-medium uppercase tracking-wide text-text">{label}</h1>
    </div>
  );
}

function CardGrid({
  cards,
  favorites,
  onToggleFavorite,
}: {
  cards: { card: MenuCard; color: SectionColor }[];
  favorites: string[];
  onToggleFavorite: (path: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map(({ card, color }) => (
        <MenuCardTile
          key={card.path}
          card={card}
          color={color}
          favorite={favorites.includes(card.path)}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </div>
  );
}

function MenuCardTile({
  card,
  color,
  favorite,
  onToggleFavorite,
}: {
  card: MenuCard;
  color: SectionColor;
  favorite: boolean;
  onToggleFavorite: (path: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-2 border-l-4 bg-panel-alt py-3 pl-4 pr-2 transition-colors hover:bg-panel-head"
      style={{ borderLeftColor: SECTION_COLORS[color] }}
    >
      <Link to={card.path} className="flex flex-1 items-center gap-3 text-text">
        <card.icon size={18} className="shrink-0 text-text-soft" />
        <span className="text-sm font-semibold">{card.label}</span>
      </Link>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onToggleFavorite(card.path)}
          aria-label={favorite ? 'Quitar de favoritos' : 'Marcar como favorito'}
          className="rounded-full p-1.5 text-text-soft transition-colors hover:bg-panel-head hover:text-accent-deep"
        >
          <Star size={15} className={cn(favorite && 'fill-accent text-accent-deep')} />
        </button>
        <Link
          to={card.path}
          aria-label={`Ver listado de ${card.label}`}
          className="rounded-full p-1.5 text-text-soft transition-colors hover:bg-panel-head hover:text-accent-deep"
        >
          <List size={15} />
        </Link>
        {card.newPath && (
          <Link
            to={card.newPath}
            aria-label={`Nuevo en ${card.label}`}
            className="rounded-full p-1.5 text-text-soft transition-colors hover:bg-panel-head hover:text-accent-deep"
          >
            <Plus size={15} />
          </Link>
        )}
      </div>
    </div>
  );
}
