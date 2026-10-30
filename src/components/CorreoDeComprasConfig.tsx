import React from 'react';
import { AlertTriangle, Check, Inbox, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Button, Panel } from '@/src/components/ui';
import { inputClass, labelClass, sectionTitleClass } from '@/src/components/FiscalFields';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  borrarCorreoDeCompras,
  fetchCorreoDeCompras,
  guardarCorreoDeCompras,
  revisarCorreoDeCompras,
  type CorreoDeCompras,
} from '@/src/lib/purchaseExtractions';
import type { PurchaseKind } from '@/src/lib/purchases';

/**
 * La casilla de Gmail donde llegan los comprobantes de compra. Cada 10
 * minutos se revisan los mails sin leer con adjuntos: cada PDF queda en
 * Compras con IA, leído y listo para revisar.
 */
export function CorreoDeComprasConfig() {
  const [actual, setActual] = React.useState<CorreoDeCompras | null>(null);
  const [email, setEmail] = React.useState('');
  const [clave, setClave] = React.useState('');
  const [tipo, setTipo] = React.useState<PurchaseKind>('ARTICULOS');
  const [ocupado, setOcupado] = React.useState<'guardar' | 'revisar' | 'borrar' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [aviso, setAviso] = React.useState<string | null>(null);

  const cargar = React.useCallback(async () => {
    try {
      const c = await fetchCorreoDeCompras();
      setActual(c);
      setEmail(c.email ?? '');
      setTipo(c.tipo);
    } catch (err) {
      // Sin la migración la función no existe: se avisa en vez de romper la pantalla.
      setError(getErrorMessage(err));
    }
  }, []);

  React.useEffect(() => { cargar(); }, [cargar]);

  const configurado = !!actual?.email && actual.tieneClave;

  async function guardar() {
    setOcupado('guardar');
    setError(null);
    setAviso(null);
    try {
      await guardarCorreoDeCompras(email.trim(), clave, tipo);
      setClave('');
      setAviso('Guardado. La casilla se revisa sola cada 10 minutos.');
      await cargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setOcupado(null);
    }
  }

  async function revisar() {
    setOcupado('revisar');
    setError(null);
    setAviso(null);
    try {
      const r = await revisarCorreoDeCompras();
      setAviso(
        r.mails === 0
          ? 'No hay mails nuevos con comprobantes.'
          : `Se tomaron ${r.comprobantes} comprobante${r.comprobantes === 1 ? '' : 's'} de ${r.mails} mail${r.mails === 1 ? '' : 's'}. ` +
              'En unos segundos aparecen en Compras con IA para revisar.' +
              (r.avisos.length ? ` ${r.avisos.join(' ')}` : '')
      );
      await cargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setOcupado(null);
    }
  }

  async function borrar() {
    if (!window.confirm('¿Dejar de revisar la casilla de compras y borrar su clave?')) return;
    setOcupado('borrar');
    setError(null);
    setAviso(null);
    try {
      await borrarCorreoDeCompras();
      setEmail('');
      setClave('');
      await cargar();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setOcupado(null);
    }
  }

  return (
    <Panel className="space-y-4 p-5">
      <h3 className={sectionTitleClass}><Inbox size={14} /> Comprobantes de compra por correo</h3>
      <p className="text-xs text-text-soft">
        Una casilla de Gmail donde los proveedores mandan sus facturas (o adonde se las reenviás). Cada 10 minutos se
        revisan los mails sin leer con adjuntos: cada PDF o foto se lee con IA y queda en <b>Compras con IA</b> para
        revisar y confirmar. El mail queda marcado como leído. Hace falta una <b>contraseña de aplicación</b> de esa
        cuenta (Cuenta de Google → Seguridad → Verificación en dos pasos → Contraseñas de aplicaciones); se guarda
        cifrada y no se puede volver a ver.
      </p>

      <div className="flex flex-wrap items-center gap-3 text-xs font-semibold uppercase tracking-[0.06em]">
        {configurado ? (
          <span className="inline-flex items-center gap-1.5 text-state-ok"><Check size={14} /> Revisando {actual?.email}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-text-soft"><AlertTriangle size={14} /> Sin configurar</span>
        )}
        {actual?.ultima && (
          <span className="font-normal normal-case tracking-normal text-text-soft">
            Última revisión: {new Date(actual.ultima.fecha).toLocaleString('es-AR')} · {actual.ultima.comprobantes}{' '}
            comprobante{actual.ultima.comprobantes === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {error && <div className="border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}
      {aviso && <div className="border border-line-strong bg-panel-alt px-3 py-2 text-xs text-text">{aviso}</div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className={labelClass}>
          Casilla de Gmail
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="compras.taller@gmail.com"
            autoComplete="off"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          {actual?.tieneClave ? 'Reemplazar contraseña de aplicación' : 'Contraseña de aplicación'}
          <input
            type="password"
            value={clave}
            onChange={(e) => setClave(e.target.value)}
            placeholder={actual?.tieneClave ? 'Vacío: queda la que está' : 'xxxx xxxx xxxx xxxx'}
            autoComplete="new-password"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Se cargan como compra de
          <select value={tipo} onChange={(e) => setTipo(e.target.value as PurchaseKind)} className={inputClass}>
            <option value="ARTICULOS">Artículos</option>
            <option value="CONCEPTOS">Conceptos</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={guardar}
          disabled={!!ocupado || !email.trim() || (!actual?.tieneClave && !clave.trim())}
        >
          <Save size={16} /> {ocupado === 'guardar' ? 'Guardando…' : 'Guardar'}
        </Button>
        {configurado && (
          <>
            <Button type="button" variant="ghost" onClick={revisar} disabled={!!ocupado}>
              <RefreshCw size={16} /> {ocupado === 'revisar' ? 'Revisando…' : 'Revisar ahora'}
            </Button>
            <Button type="button" variant="ghost" onClick={borrar} disabled={!!ocupado}>
              <Trash2 size={16} /> Dejar de revisar
            </Button>
          </>
        )}
      </div>
    </Panel>
  );
}
