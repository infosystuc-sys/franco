// src/pages/PurchaseAIUpload.tsx
import React from 'react';
import { Sparkles, XCircle } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import type { PurchaseKind } from '@/src/lib/purchases';
import {
  describeExtractionError,
  requestExtraction,
  uploadPurchaseInvoiceDraft,
} from '@/src/lib/purchaseExtractions';

/** Paso 1 de la carga con IA: elegir el archivo y esperar a que Gemini lo lea. */
export function PurchaseAIUpload() {
  const { role } = useAuth();
  const { kind: kindParam } = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const kind: PurchaseKind = kindParam === 'articulos' ? 'ARTICULOS' : 'CONCEPTOS';

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (kindParam !== 'articulos' && kindParam !== 'conceptos') {
    return <Navigate to="/compras-ia" replace />;
  }

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { storagePath, mimeType } = await uploadPurchaseInvoiceDraft(file);
      const { id } = await requestExtraction({ storagePath, mimeType, kind });
      navigate(`/compras-ia/revisar/${id}`);
    } catch (err) {
      setError(describeExtractionError(getErrorMessage(err)));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={kind === 'ARTICULOS' ? 'Factura de artículos — con IA' : 'Factura de conceptos — con IA'}
        actions={
          <Link to="/compras-ia">
            <Button variant="ghost" type="button"><XCircle size={16} /> Cancelar</Button>
          </Link>
        }
      />

      {error && (
        <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="flex flex-col items-center gap-4 p-10 text-center">
        {busy ? (
          <>
            <Sparkles size={32} className="animate-pulse text-accent-deep" />
            <p className="text-sm text-text-soft">Leyendo la factura con IA…</p>
          </>
        ) : (
          <>
            <Sparkles size={32} className="text-accent-deep" />
            <p className="text-sm text-text-soft">Subí el PDF de la factura, o sacale una foto con el celular.</p>
            <label className="cursor-pointer rounded-md bg-accent px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-accent-ink hover:bg-accent-deep">
              Elegir archivo
              <input
                type="file"
                accept="application/pdf,image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
            </label>
          </>
        )}
      </Panel>
    </div>
  );
}
