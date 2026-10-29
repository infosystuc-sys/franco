// src/components/purchase/LeerFacturaConIA.tsx
import React from 'react';
import { Camera, Sparkles, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { getErrorMessage } from '@/src/lib/workOrders';
import type { PurchaseKind } from '@/src/lib/purchases';
import {
  describeDraftFileProblem,
  describeExtractionError,
  prepararFotoDeFactura,
  requestExtraction,
  uploadPurchaseInvoiceDraft,
} from '@/src/lib/purchaseExtractions';

const botonClass =
  'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-semibold uppercase tracking-wider transition-colors';

/**
 * Botones para cargar una factura de compra con IA: sacarle una foto con la
 * cámara del celular o elegir el PDF/imagen. Sube el archivo, lo hace leer
 * por Gemini y lleva a la revisión del borrador.
 *
 * Son dos inputs separados a propósito: con `capture` el celular abre directo
 * la cámara y no deja elegir un PDF, y sin él obliga a pasar por el selector
 * de archivos para sacar la foto. En una PC `capture` se ignora, así que ahí
 * los dos botones abren el selector.
 */
export function LeerFacturaConIA({
  kind,
  onError,
  compacto = false,
}: {
  kind: PurchaseKind;
  onError: (mensaje: string | null) => void;
  /** Versión chica, para la cabecera de la carga manual. */
  compacto?: boolean;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);

  async function handleFile(original: File) {
    onError(null);
    setBusy(true);
    try {
      const file = await prepararFotoDeFactura(original);
      // Se valida antes de subir: no tiene sentido gastar la subida entera
      // para que el archivo rebote del otro lado.
      const problema = describeDraftFileProblem(file);
      if (problema) {
        onError(problema);
        setBusy(false);
        return;
      }
      const { storagePath, mimeType } = await uploadPurchaseInvoiceDraft(file);
      const { id } = await requestExtraction({ storagePath, mimeType, kind });
      navigate(`/compras-ia/revisar/${id}`);
    } catch (err) {
      onError(describeExtractionError(getErrorMessage(err)));
      setBusy(false);
    }
  }

  function alElegir(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Se limpia el input para que, si el archivo se rechaza, se pueda volver
    // a elegir el mismo después de achicarlo.
    e.target.value = '';
    if (file) void handleFile(file);
  }

  if (busy) {
    return (
      <span className={cn('inline-flex items-center gap-2 text-sm text-text-soft', !compacto && 'flex-col')}>
        <Sparkles size={compacto ? 16 : 32} className="animate-pulse text-accent-deep" />
        Leyendo la factura con IA…
      </span>
    );
  }

  return (
    <div className={cn('flex flex-wrap gap-2', !compacto && 'justify-center')}>
      <label className={cn(botonClass, 'bg-accent text-accent-ink hover:bg-accent-deep')}>
        <Camera size={16} /> {compacto ? 'Foto con IA' : 'Sacar foto'}
        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={alElegir} />
      </label>
      <label className={cn(botonClass, 'border border-line-strong bg-panel text-text-soft hover:bg-panel-alt')}>
        <Upload size={16} /> {compacto ? 'PDF con IA' : 'Elegir PDF o imagen'}
        <input type="file" accept="application/pdf,image/*" className="hidden" onChange={alElegir} />
      </label>
    </div>
  );
}
