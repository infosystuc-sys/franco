/**
 * Favoritos del menú de inicio: una preferencia personal de este navegador,
 * no un dato del negocio. Por eso vive en localStorage y no en la base —no
 * hay nada que sincronizar entre dispositivos ni que otro usuario deba ver.
 */

const STORAGE_KEY = 'dieselpro:favoritos';

function read(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function write(paths: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // Sin almacenamiento disponible (privado, cuota llena): se sigue sin favoritos.
  }
}

export function getFavorites(): string[] {
  return read();
}

export function isFavorite(path: string): boolean {
  return read().includes(path);
}

export function toggleFavorite(path: string): string[] {
  const current = read();
  const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
  write(next);
  return next;
}
