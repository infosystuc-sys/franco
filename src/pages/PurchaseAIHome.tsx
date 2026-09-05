// src/pages/PurchaseAIHome.tsx
import React from 'react';
import { Sparkles, Package, FileText, AlertTriangle, Trash2 } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  deleteExtraction,
  describeExtraction,
  fetchPendingExtractions,
  describeExtractionError,
  type PurchaseExtraction,
} from '@/src/lib/purchaseExtractions';

/**
 * Punto de entrada de la carga de facturas de compra con IA — separado a
 * propósito de la carga manual (Compras): dos métodos disponibles, el
 * operador elige el que conviene por factura.
 */
export function PurchaseAIHome() {
  const { role } = useAuth();
  const [pending, setPending] = React.useState<PurchaseExtraction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (role !== 'admin') return;
    fetchPendingExtractions()
      .then(setPending)
      .catch((err) => setError(describeExtractionError(getErrorMessage(err))))
      .finally(() => setLoading(false));
  }, [role]);

  async function handleDelete(draft: PurchaseExtraction) {
    const que = describeExtraction(draft) || 'este borrador';
    if (!window.confirm(
      `¿Borrar ${que}? Se elimina el borrador y el archivo que subiste. No se puede deshacer: para volver a cargarlo hay que subir la factura de nuevo.`
    )) return;
    setDeleting(draft.id);
    setError(null);
    try {
      await deleteExtraction(draft);
      setPending((actuales) => actuales.filter((d) => d.id !== draft.id));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDeleting(null);
    }
  }

  if (role !== 'admin') return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Compras con IA"
        subtitle="Subí el PDF o una foto de la factura del proveedor y revisá lo que Gemini leyó antes de guardar."
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link to="/compras-ia/nueva/articulos">
          <Panel className="flex items-center gap-3 p-5 transition-colors hover:border-accent-deep">
            <Package size={22} className="text-accent-deep" />
            <div>
              <p className="font-semibold text-text">Factura de artículos</p>
              <p className="text-xs text-text-soft">Repuestos del catálogo. Actualiza stock y precio de compra.</p>
            </div>
          </Panel>
        </Link>
        <Link to="/compras-ia/nueva/conceptos">
          <Panel className="flex items-center gap-3 p-5 transition-colors hover:border-accent-deep">
            <FileText size={22} className="text-accent-deep" />
            <div>
              <p className="font-semibold text-text">Factura de conceptos</p>
              <p className="text-xs text-text-soft">Gastos sin stock: fletes, servicios, honorarios.</p>
            </div>
          </Panel>
        </Link>
      </div>

      <Panel className="p-5">
        <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft">
          <Sparkles size={14} /> Leídas por IA sin confirmar {pending.length > 0 && `(${pending.length})`}
        </h2>
        {loading ? (
          <p className="text-sm text-text-soft">Cargando…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-text-soft">No hay borradores pendientes de revisar.</p>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((draft) => {
              // Los que fallaron se listan igual: es la única forma de llegar
              // al botón de reintentar sobre el archivo que ya está subido.
              const failed = draft.status === 'ERROR';
              // De qué comprobante es. Sin esto, dos borradores de la misma
              // factura se ven idénticos en la lista y no hay forma de saber
              // cuál se está por borrar.
              const cual = describeExtraction(draft);
              return (
                <li key={draft.id} className="flex items-center gap-2">
                  <Link
                    to={`/compras-ia/revisar/${draft.id}`}
                    className="flex flex-1 items-center justify-between gap-3 py-2.5 text-sm hover:text-accent-deep"
                  >
                    <span className={failed ? 'text-danger' : undefined}>
                      {failed && <AlertTriangle size={14} className="mr-1.5 inline-block align-[-2px]" />}
                      {draft.kind === 'ARTICULOS' ? 'Artículos' : 'Conceptos'}
                      {cual && ` · ${cual}`}
                      <span className="mt-0.5 block text-[11px] text-text-soft">
                        {failed ? 'no se pudo leer' : 'leída'} el {formatDate(draft.createdAt)}
                        {failed && draft.errorMessage && ` — ${draft.errorMessage}`}
                      </span>
                    </span>
                    <Button variant="ghost" type="button" className="pointer-events-none shrink-0 px-3">
                      {failed ? 'Reintentar' : 'Revisar'}
                    </Button>
                  </Link>
                  {/* Fuera del Link: un botón dentro de un enlace navega al
                      hacer clic, además de disparar su propia acción. */}
                  <button
                    type="button"
                    title="Borrar este borrador"
                    aria-label={`Borrar ${cual || 'borrador'}`}
                    disabled={deleting === draft.id}
                    onClick={() => handleDelete(draft)}
                    className="shrink-0 p-1 text-text-soft transition-colors hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
