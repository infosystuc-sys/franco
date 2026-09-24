import React from 'react';
import { XCircle, Printer } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, PageHeader } from '@/src/components/ui';
import { getErrorMessage, fetchWorkOrderByNumber, type WorkOrderDetail } from '@/src/lib/workOrders';
import { fetchTallerHeader, formatAddress, type TallerHeader } from '@/src/lib/companySettings';
import { WorkOrderBlankDocument } from '@/src/components/WorkOrderBlankDocument';

/**
 * La orden en blanco para imprimir: mismo patrón que "Imprimir presupuesto"
 * desde la ficha de la orden —una pantalla propia en vez de un modal, porque
 * el CSS de impresión necesita que lo único visible sea el papel—.
 *
 * Con ?imprimir=1 dispara el diálogo de impresión solo, apenas carga.
 */
export function WorkOrderPrintBlank() {
  const { id: number } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [order, setOrder] = React.useState<WorkOrderDetail | null>(null);
  const [taller, setTaller] = React.useState<TallerHeader | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const yaImprimio = React.useRef(false);

  const destinoAlSalir = `/orden/${number}`;

  React.useEffect(() => {
    if (!number) return;
    let cancelled = false;
    Promise.all([
      fetchWorkOrderByNumber(number),
      fetchTallerHeader().catch(() => null),
    ])
      .then(([data, datosTaller]) => {
        if (cancelled) return;
        setOrder(data);
        setTaller(datosTaller);
      })
      .catch((err) => !cancelled && setError(getErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [number]);

  // Mismo mecanismo que la impresión del presupuesto: se espera a que cargue
  // y se dispara una sola vez, con un respiro para que el navegador termine
  // de pintar el documento antes de capturarlo.
  React.useEffect(() => {
    if (yaImprimio.current) return;
    if (searchParams.get('imprimir') !== '1') return;
    if (loading || !order) return;
    const t = setTimeout(() => {
      if (yaImprimio.current) return;
      yaImprimio.current = true;
      window.addEventListener('afterprint', () => navigate(destinoAlSalir), { once: true });
      window.print();
    }, 300);
    return () => clearTimeout(t);
  }, [loading, order, searchParams, navigate, destinoAlSalir]);

  if (loading) {
    return <div className="w-full p-8 text-center text-text-soft">Cargando…</div>;
  }

  if (!order) {
    return (
      <div className="w-full p-8 text-center text-text-soft">
        {error ?? 'No se encontró la orden.'}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print">
        <PageHeader
          title="Orden en blanco"
          subtitle={`Para completar a mano — orden ${order.number}`}
          actions={
            <>
              <Button variant="ghost" type="button" onClick={() => navigate(destinoAlSalir)}>
                <XCircle size={16} /> Volver
              </Button>
              <Button type="button" onClick={() => window.print()}>
                <Printer size={16} /> Imprimir
              </Button>
            </>
          }
        />
        {error && (
          <div className="mb-6 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}
      </div>

      <WorkOrderBlankDocument
        order={{
          number: order.number,
          component: order.component,
          customerName: order.customer?.name ?? '—',
          customerPhone: order.customer?.phone ?? null,
          customerTaxId: order.customer?.tax_id ?? null,
          customerTaxCondition: order.customer?.tax_condition ?? null,
          customerAddress: order.customer
            ? formatAddress({
                addressStreet: order.customer.address_street,
                addressCity: order.customer.address_city,
                addressState: order.customer.address_state,
                addressZip: order.customer.address_zip,
              }) || null
            : null,
          vehicleBrand: order.vehicle?.brand ?? null,
          vehicleModel: order.vehicle?.model ?? null,
          licensePlate: order.vehicle?.license_plate ?? null,
          year: order.vehicle?.year ?? null,
          engineBrand: order.vehicle?.engine_brand ?? null,
          engineModel: order.vehicle?.engine_model ?? null,
        }}
        taller={taller}
      />
    </div>
  );
}
