import React from 'react';
import { XCircle, Printer, Ban, Receipt } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '@/src/lib/auth';
import { Button, PageHeader } from '@/src/components/ui';
import { getErrorMessage } from '@/src/lib/workOrders';
import { describeRemitoError, fetchRemitoById, isPending, voidRemito, type Remito } from '@/src/lib/remitos';
import { RemitoDocument } from '@/src/pages/InvoiceDetails';

/** Ficha de un remito, con o sin factura. Es también el documento imprimible. */
export function RemitoDetails() {
  const { role } = useAuth();
  const { id } = useParams();

  const [remito, setRemito] = React.useState<Remito | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [voiding, setVoiding] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setRemito(await fetchRemitoById(id));
    } catch (err) {
      setError(describeRemitoError(getErrorMessage(err)));
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => { load(); }, [load]);

  if (role !== 'admin') return <Navigate to="/" replace />;

  if (loading) {
    return <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">Cargando…</div>;
  }

  if (!remito) {
    return (
      <div className="mx-auto max-w-4xl p-8 text-center text-text-soft">
        No se encontró el remito.{' '}
        <Link to="/remitos" className="text-accent-deep underline">Volver al listado</Link>
      </div>
    );
  }

  async function handleVoid() {
    if (!remito) return;
    const reason = window.prompt(`¿Por qué se anula el remito ${remito.fullNumber}?`);
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert('Hace falta un motivo.');
      return;
    }
    setVoiding(true);
    setError(null);
    try {
      await voidRemito(remito.id, reason);
      await load();
    } catch (err) {
      setError(describeRemitoError(getErrorMessage(err)));
    } finally {
      setVoiding(false);
    }
  }

  const pending = isPending(remito);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print">
        <PageHeader
          title={remito.fullNumber}
          subtitle={pending ? 'Pendiente de facturar' : remito.invoiceId ? 'Facturado' : 'Anulado'}
          actions={
            <>
              <Link to="/remitos">
                <Button variant="ghost" type="button"><XCircle size={16} /> Volver</Button>
              </Link>
              <Button variant="ghost" type="button" onClick={() => window.print()}>
                <Printer size={16} /> Imprimir
              </Button>
              {pending && (
                <>
                  <Link to={`/facturas/nueva?remito=${remito.id}`}>
                    <Button><Receipt size={16} /> Facturar</Button>
                  </Link>
                  <Button variant="ghost" type="button" onClick={handleVoid} disabled={voiding}>
                    <Ban size={16} /> {voiding ? 'Anulando…' : 'Anular'}
                  </Button>
                </>
              )}
            </>
          }
        />

        {error && (
          <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
        )}
      </div>

      <RemitoDocument remito={remito} />
    </div>
  );
}
