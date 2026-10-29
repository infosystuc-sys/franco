// src/pages/PurchaseAIUpload.tsx
import React from 'react';
import { Sparkles, XCircle } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader, Panel } from '@/src/components/ui';
import type { PurchaseKind } from '@/src/lib/purchases';
import { LeerFacturaConIA } from '@/src/components/purchase/LeerFacturaConIA';

/** Paso 1 de la carga con IA: sacar la foto o elegir el archivo y esperar a que Gemini lo lea. */
export function PurchaseAIUpload() {
  const { role } = useAuth();
  const { kind: kindParam } = useParams();
  const [error, setError] = React.useState<string | null>(null);

  const kind: PurchaseKind = kindParam === 'articulos' ? 'ARTICULOS' : 'CONCEPTOS';

  if (role !== 'admin') return <Navigate to="/" replace />;
  if (kindParam !== 'articulos' && kindParam !== 'conceptos') {
    return <Navigate to="/compras-ia" replace />;
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
        <Sparkles size={32} className="text-accent-deep" />
        <p className="text-sm text-text-soft">Sacale una foto a la factura con el celular, o subí el PDF.</p>
        <p className="text-xs text-text-faint">
          Con la factura apoyada en una mesa, bien iluminada y entera en la foto. PDF o imagen, hasta 10 MB.
        </p>
        <LeerFacturaConIA kind={kind} onError={setError} />
      </Panel>
    </div>
  );
}
