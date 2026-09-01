// src/pages/PurchaseAIHome.tsx
import React from 'react';
import { Sparkles, Package, FileText } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { formatDate } from '@/src/lib/utils';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
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

  React.useEffect(() => {
    if (role !== 'admin') return;
    fetchPendingExtractions()
      .then(setPending)
      .catch((err) => setError(describeExtractionError(getErrorMessage(err))))
      .finally(() => setLoading(false));
  }, [role]);

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
            {pending.map((draft) => (
              <li key={draft.id}>
                <Link
                  to={`/compras-ia/revisar/${draft.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm hover:text-accent-deep"
                >
                  <span>
                    {draft.kind === 'ARTICULOS' ? 'Artículos' : 'Conceptos'} · leída el {formatDate(draft.createdAt)}
                  </span>
                  <Button variant="ghost" type="button" className="pointer-events-none px-3">
                    Revisar
                  </Button>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
