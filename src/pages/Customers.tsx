import React from 'react';
import { CabeceraFija } from '@/src/components/CabeceraFija';
import { ordenarFilas, type Orden } from '@/src/lib/ordenar';
import { ThOrdenable } from '@/src/components/ThOrdenable';
import { Plus, Pencil, Trash2, Search, Truck, FileSpreadsheet, ChevronLeft, ChevronRight } from 'lucide-react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { cn, formatMoney, coincideBusqueda } from '@/src/lib/utils';
import { Button, PageHeader } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import { CustomerModal } from '@/src/components/CustomerModal';
import { formatCuit, TAX_CONDITION_LABELS } from '@/src/lib/fiscal';
import {
  deleteCustomer,
  describeCustomerError,
  fetchCustomers,
  type Customer,
} from '@/src/lib/customers';
import { fetchSaldosDeClientes } from '@/src/lib/receipts';

const POR_PAGINA = 50;

export function Customers() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [customers, setCustomers] = React.useState<Customer[]>([]);
  // Saldo por cliente: positivo debe, negativo tiene a favor. Sin entrada, cero.
  const [saldos, setSaldos] = React.useState<Map<string, number>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [pagina, setPagina] = React.useState(0);
  const [editing, setEditing] = React.useState<Customer | 'new' | null>(null);

  // El "+" del menú entra con ?nuevo=1 y abre el alta directo. Se limpia el
  // parámetro para que recargar la página no vuelva a abrir el modal.
  const [searchParams, setSearchParams] = useSearchParams();
  React.useEffect(() => {
    if (searchParams.get('nuevo') !== '1') return;
    setEditing('new');
    setSearchParams((actuales) => {
      const proximos = new URLSearchParams(actuales);
      proximos.delete('nuevo');
      return proximos;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  const loadCustomers = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [clientes, conSaldo] = await Promise.all([fetchCustomers(), fetchSaldosDeClientes()]);
      setCustomers(clientes);
      setSaldos(new Map(conSaldo.map((s) => [s.customerId, s.saldo])));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (isAdmin) loadCustomers();
  }, [isAdmin, loadCustomers]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return customers;
    return customers.filter((c) =>
      coincideBusqueda(term, [c.name, c.legalName, c.taxId, c.email, c.phone, c.addressCity])
    );
  }, [customers, search]);

  // Orden por columna: click en el título ordena, otro invierte, otro vuelve
  // al orden original.
  const [orden, setOrden] = React.useState<Orden | null>(null);
  const ordenados = React.useMemo(
    () =>
      ordenarFilas(filtered, orden, (c, columna) => {
        switch (columna) {
      case 'Cliente': return c.name;
      case 'CUIT / CUIL': return c.taxId;
      case 'Cond. IVA': return TAX_CONDITION_LABELS[c.taxCondition];
      case 'Contacto': return c.email ?? c.phone;
      case 'Saldo': return saldos.get(c.id) ?? 0;
      case 'Vehíc.': return c.vehicles.length;
      case 'Estado': return c.active ? 'Activo' : 'Inactivo';
          default: return null;
        }
      }),
    [filtered, orden, saldos]
  );

  // Con más de mil clientes, dibujarlos todos juntos hace la pantalla lenta e
  // inmanejable: se muestran de a páginas. Al buscar se vuelve a la primera,
  // que es donde quedan los resultados.
  const totalPaginas = Math.max(1, Math.ceil(filtered.length / POR_PAGINA));
  const paginaActual = Math.min(pagina, totalPaginas - 1);
  const visibles = ordenados.slice(paginaActual * POR_PAGINA, (paginaActual + 1) * POR_PAGINA);
  React.useEffect(() => { setPagina(0); }, [search]);

  async function handleDelete(customer: Customer) {
    if (!window.confirm(`¿Eliminar el cliente "${customer.name}"? También se eliminarán sus vehículos.`)) return;
    setError(null);
    try {
      await deleteCustomer(customer.id);
      loadCustomers();
    } catch (err) {
      // Un cliente con órdenes de trabajo no se puede borrar (FK). Se sugiere desactivarlo.
      setError(describeCustomerError(getErrorMessage(err), customer.name));
    }
  }

  // El padrón de clientes es gestión: solo admin.
  if (role && !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="w-full space-y-6">
      <CabeceraFija>
      <PageHeader
        title="Clientes"
        subtitle="Datos fiscales y vehículos de cada cliente del taller."
        actions={
          <>
            <Link to="/clientes/importar">
              <Button variant="ghost" type="button">
                <FileSpreadsheet size={16} /> Importar desde Excel
              </Button>
            </Link>
            <Button onClick={() => setEditing('new')}>
              <Plus size={16} /> Nuevo cliente
            </Button>
          </>
        }
      />

      {error && (
        <div className="bg-danger-soft border border-danger/40 text-danger text-sm px-4 py-3">{error}</div>
      )}

      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, CUIT, email..."
          className="h-9 w-full rounded-md border border-line bg-panel pl-9 pr-3 text-sm focus:border-accent-deep focus:outline-none"
        />
      </div>

      </CabeceraFija>

      <div className="overflow-hidden rounded-lg border border-line bg-panel xl:overflow-visible">
        <div className="overflow-x-auto xl:overflow-x-clip">
          <table className="tabla-fija table-stack w-full text-left text-[15px]">
            <thead>
              <tr className="border-b border-line bg-panel-head text-[13px] uppercase tracking-[0.06em] text-text-soft">
                <ThOrdenable columna="Cliente" orden={orden} onOrden={setOrden} className="p-3 font-semibold">Cliente</ThOrdenable>
                <ThOrdenable columna="CUIT / CUIL" orden={orden} onOrden={setOrden} className="p-3 font-semibold w-36">CUIT / CUIL</ThOrdenable>
                <ThOrdenable columna="Cond. IVA" orden={orden} onOrden={setOrden} className="p-3 font-semibold w-44">Cond. IVA</ThOrdenable>
                <ThOrdenable columna="Contacto" orden={orden} onOrden={setOrden} className="p-3 font-semibold w-48">Contacto</ThOrdenable>
                <ThOrdenable columna="Saldo" orden={orden} onOrden={setOrden} className="p-3 font-semibold w-36 text-right">Saldo</ThOrdenable>
                <ThOrdenable columna="Vehíc." orden={orden} onOrden={setOrden} className="p-3 font-semibold w-20 text-center">Vehíc.</ThOrdenable>
                <ThOrdenable columna="Estado" orden={orden} onOrden={setOrden} className="p-3 font-semibold w-20 text-center">Estado</ThOrdenable>
                <th className="p-3 font-semibold w-24 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="p-6 text-center text-text-soft">Cargando...</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-text-soft">
                    {search ? 'Ningún cliente coincide con la búsqueda.' : 'No hay clientes cargados.'}
                  </td>
                </tr>
              )}
              {visibles.map((customer) => (
                <tr key={customer.id} className="border-b border-line hover:bg-panel-alt transition-colors">
                  <td data-primary className="p-3">
                    <div className="font-bold text-text">{customer.name}</div>
                    {customer.legalName && customer.legalName !== customer.name && (
                      <div className="text-[13px] text-text-soft">{customer.legalName}</div>
                    )}
                  </td>
                  <td data-label="CUIT" className="p-3 font-mono">{formatCuit(customer.taxId) || <span className="text-text-faint">—</span>}</td>
                  <td data-label="Cond. IVA" className="p-3">
                    <span className="text-[12px] font-bold uppercase tracking-wider text-accent-deep">
                      {TAX_CONDITION_LABELS[customer.taxCondition]}
                    </span>
                  </td>
                  <td data-label="Contacto" className="p-3 text-[13px] text-text-soft">
                    {customer.email && <div>{customer.email}</div>}
                    {customer.phone && <div>{customer.phone}</div>}
                    {!customer.email && !customer.phone && <span className="text-text-faint">—</span>}
                  </td>
                  <td data-label="Saldo" className="p-3 text-right font-mono">
                    <SaldoCelda saldo={saldos.get(customer.id) ?? 0} />
                  </td>
                  <td data-label="Vehículos" className="p-3 text-center">
                    <span className="inline-flex items-center gap-1 text-text-soft">
                      <Truck size={13} />
                      {customer.vehicles.length}
                    </span>
                  </td>
                  <td data-label="Estado" className="p-3 text-center">
                    <span className={cn(
                      "text-[12px] font-bold uppercase tracking-wider",
                      customer.active ? "text-state-done" : "text-text-faint"
                    )}>
                      {customer.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => setEditing(customer)} title="Editar" className="text-text-soft hover:text-text p-1">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(customer)} title="Eliminar" className="text-text-soft hover:text-danger p-1">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && filtered.length > 0 && (
        <Paginador
          pagina={paginaActual}
          totalPaginas={totalPaginas}
          desde={paginaActual * POR_PAGINA + 1}
          hasta={Math.min((paginaActual + 1) * POR_PAGINA, filtered.length)}
          total={filtered.length}
          onCambiar={setPagina}
        />
      )}

      {editing && (
        <CustomerModal
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadCustomers();
          }}
        />
      )}
    </div>
  );
}

/** Lo que debe en negro, lo que tiene a favor en verde, y un guión si está en cero. */
function SaldoCelda({ saldo }: { saldo: number }) {
  if (Math.abs(saldo) < 0.005) return <span className="text-text-faint">—</span>;
  if (saldo < 0) {
    return <span className="font-semibold text-state-done" title="A favor del cliente">− $ {formatMoney(-saldo)}</span>;
  }
  return <span className="font-semibold text-text">$ {formatMoney(saldo)}</span>;
}

function Paginador({
  pagina,
  totalPaginas,
  desde,
  hasta,
  total,
  onCambiar,
}: {
  pagina: number;
  totalPaginas: number;
  desde: number;
  hasta: number;
  total: number;
  onCambiar: (pagina: number) => void;
}) {
  const [irA, setIrA] = React.useState('');
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-text-soft">
      <span>
        {desde}–{hasta} de {total} {total === 1 ? 'cliente' : 'clientes'}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" type="button" onClick={() => onCambiar(0)} disabled={pagina === 0}>
          Primera
        </Button>
        <Button variant="ghost" type="button" onClick={() => onCambiar(pagina - 1)} disabled={pagina === 0}>
          <ChevronLeft size={16} /> Anterior
        </Button>
        <span className="whitespace-nowrap">
          Página{' '}
          <input
            value={irA}
            onChange={(e) => setIrA(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !irA) return;
              onCambiar(Math.min(Math.max(Number(irA), 1), totalPaginas) - 1);
              setIrA('');
            }}
            placeholder={String(pagina + 1)}
            aria-label="Ir a la página"
            className="w-12 rounded border border-line bg-panel px-1.5 py-0.5 text-center text-text focus:border-accent-deep focus:outline-none"
          />{' '}
          de {totalPaginas}
        </span>
        <Button
          variant="ghost"
          type="button"
          onClick={() => onCambiar(pagina + 1)}
          disabled={pagina >= totalPaginas - 1}
        >
          Siguiente <ChevronRight size={16} />
        </Button>
        <Button
          variant="ghost"
          type="button"
          onClick={() => onCambiar(totalPaginas - 1)}
          disabled={pagina >= totalPaginas - 1}
        >
          Última
        </Button>
      </div>
    </div>
  );
}
