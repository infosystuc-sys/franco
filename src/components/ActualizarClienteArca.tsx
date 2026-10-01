import React from 'react';
import { AlertTriangle, Landmark } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { Button, Panel } from '@/src/components/ui';
import { formatCuit, fiscalEntityToForm, TAX_CONDITION_LABELS, type FiscalEntityInput } from '@/src/lib/fiscal';
import { consultarPadron, volcarEnFicha, type DatosDePadron } from '@/src/lib/arcaPadron';
import { updateCustomer, type Customer } from '@/src/lib/customers';
import { getErrorMessage } from '@/src/lib/workOrders';

type Campo = 'taxId' | 'legalName' | 'taxCondition' | 'addressStreet' | 'addressCity' | 'addressState' | 'addressZip';

const CAMPOS: { campo: Campo; rotulo: string }[] = [
  { campo: 'legalName', rotulo: 'Razón social' },
  { campo: 'taxId', rotulo: 'CUIT' },
  { campo: 'taxCondition', rotulo: 'Condición de IVA' },
  { campo: 'addressStreet', rotulo: 'Domicilio' },
  { campo: 'addressCity', rotulo: 'Localidad' },
  { campo: 'addressState', rotulo: 'Provincia' },
  { campo: 'addressZip', rotulo: 'Código postal' },
];

function mostrar(campo: Campo, valor: string | null | undefined): string {
  if (!valor) return '—';
  if (campo === 'taxCondition') return TAX_CONDITION_LABELS[valor as keyof typeof TAX_CONDITION_LABELS] ?? valor;
  if (campo === 'taxId') return formatCuit(valor);
  return valor;
}

const igual = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * Trae del padrón de ARCA los datos fiscales del cliente elegido y muestra
 * qué cambiaría antes de tocar nada: la ficha se actualiza recién cuando se
 * confirma. Cambia lo que ARCA conoce (razón social, condición de IVA,
 * domicilio); el nombre con que se lo conoce en el taller, el teléfono y el
 * mail quedan como estaban.
 */
export function ActualizarClienteArca({
  cliente,
  onClose,
  onActualizado,
}: {
  cliente: Customer;
  onClose: () => void;
  onActualizado: (cliente: Customer) => void;
}) {
  const [datos, setDatos] = React.useState<DatosDePadron | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);
  const [consultando, setConsultando] = React.useState(true);
  const [guardando, setGuardando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let vigente = true;
    if (!cliente.taxId) {
      setError('Este cliente no tiene CUIT ni DNI cargado: no hay con qué buscarlo en ARCA.');
      setConsultando(false);
      return;
    }
    consultarPadron(cliente.taxId)
      .then((r) => {
        if (!vigente) return;
        setDatos(r.datos);
        setAviso(r.aviso);
      })
      .catch((err) => vigente && setError(getErrorMessage(err)))
      .finally(() => vigente && setConsultando(false));
    return () => { vigente = false; };
  }, [cliente.taxId]);

  const ficha: FiscalEntityInput = fiscalEntityToForm(cliente);
  const cambios = datos ? volcarEnFicha(ficha, datos) : {};
  const distintos = CAMPOS.filter(
    ({ campo }) => campo in cambios && !igual(ficha[campo] as string, (cambios as Record<string, string>)[campo])
  );

  async function confirmar() {
    if (!datos || distintos.length === 0) return;
    setGuardando(true);
    setError(null);
    try {
      const actualizado = await updateCustomer(cliente.id, {
        ...ficha,
        ...Object.fromEntries(distintos.map(({ campo }) => [campo, (cambios as Record<string, string>)[campo]])),
        condicionVenta: cliente.condicionVenta ?? '',
      });
      onActualizado(actualizado);
    } catch (err) {
      setError(getErrorMessage(err));
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <Panel className="max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-text">
          <Landmark size={16} /> Actualizar desde ARCA
        </h3>
        <p className="mt-1 text-sm text-text-soft">
          {cliente.name}
          {cliente.taxId && <span className="font-mono"> — {formatCuit(cliente.taxId)}</span>}
        </p>

        {consultando && <p className="mt-4 text-sm text-text-soft">Consultando el padrón de ARCA…</p>}

        {error && (
          <div className="mt-4 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
        )}

        {datos && (
          <>
            {(aviso || (datos.estadoClave && datos.estadoClave.toUpperCase() !== 'ACTIVO')) && (
              <div className="mt-4 flex items-start gap-2 rounded-md border border-state-wait/50 bg-panel-alt px-4 py-3 text-sm">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-state-wait" />
                <span>
                  {aviso}
                  {datos.estadoClave && datos.estadoClave.toUpperCase() !== 'ACTIVO' &&
                    ` ARCA marca esta clave como ${datos.estadoClave.toLowerCase()}.`}
                </span>
              </div>
            )}

            {distintos.length === 0 ? (
              <p className="mt-4 text-sm text-text">
                Los datos de la ficha ya coinciden con los de ARCA: no hay nada que actualizar.
              </p>
            ) : (
              <>
                <p className="mt-4 text-sm text-text">
                  ARCA tiene estos datos distintos de los de la ficha. ¿Los actualizo?
                </p>
                <table className="mt-2 w-full text-left text-sm">
                  <thead className="bg-panel-head text-[12px] font-semibold uppercase tracking-[0.06em] text-text-soft">
                    <tr>
                      <th className="px-3 py-1.5">Dato</th>
                      <th className="px-3 py-1.5">En la ficha</th>
                      <th className="px-3 py-1.5">En ARCA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distintos.map(({ campo, rotulo }) => (
                      <tr key={campo} className="border-b border-line">
                        <td className="px-3 py-1.5 font-semibold">{rotulo}</td>
                        <td className="px-3 py-1.5 text-text-soft line-through decoration-danger/60">
                          {mostrar(campo, ficha[campo] as string)}
                        </td>
                        <td className="px-3 py-1.5 font-semibold text-state-done">
                          {mostrar(campo, (cambios as Record<string, string>)[campo])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[12px] text-text-soft">
                  El nombre con que se lo conoce en el taller, el teléfono, el mail y las observaciones no
                  se tocan.
                  {distintos.some((d) => d.campo === 'taxCondition') &&
                    ' Ojo: cambiar la condición de IVA cambia la letra de las próximas facturas.'}
                </p>
              </>
            )}
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={guardando}>
            {distintos.length === 0 ? 'Cerrar' : 'Cancelar'}
          </Button>
          {datos && distintos.length > 0 && (
            <Button type="button" onClick={confirmar} disabled={guardando} className={cn(guardando && 'opacity-70')}>
              {guardando ? 'Actualizando…' : 'Actualizar con los datos de ARCA'}
            </Button>
          )}
        </div>
      </Panel>
    </div>
  );
}
