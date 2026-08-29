import React from 'react';
import { XCircle, Camera, Trash2, Receipt, ArrowRight, ImageOff, Plus, Check } from 'lucide-react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { cn } from '@/src/lib/utils';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  addIntakePart,
  convertIntakeToQuotation,
  deleteIntakePart,
  deleteIntakePhoto,
  describeVehicleIntakeError,
  fetchVehicleIntake,
  getIntakePhotoUrl,
  updateIntakePart,
  updateVehicleIntake,
  uploadIntakePhoto,
  VEHICLE_INTAKE_STATUS_LABELS,
  VEHICLE_INTAKE_STATUS_STRIP,
  type VehicleIntakeDetail,
  type VehicleIntakePart,
  type VehicleIntakePhoto,
} from '@/src/lib/vehicleIntakes';

export function VehicleIntakeDetails() {
  const { id } = useParams();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const navigate = useNavigate();

  const [intake, setIntake] = React.useState<VehicleIntakeDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [observations, setObservations] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const [converting, setConverting] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchVehicleIntake(id);
      setIntake(data);
      setObservations(data?.observations ?? '');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    if (!intake) return;
    setSaving(true);
    setError(null);
    try {
      await updateVehicleIntake(intake.id, { observations });
      await load();
    } catch (err) {
      setError(describeVehicleIntakeError(getErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  async function handleConvert() {
    if (!intake) return;
    setConverting(true);
    setError(null);
    try {
      const quotation = await convertIntakeToQuotation(intake);
      navigate(`/cotizacion/${quotation.number}`);
    } catch (err) {
      setError(describeVehicleIntakeError(getErrorMessage(err)));
      setConverting(false);
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">Cargando ingreso...</div>;
  }

  if (!intake) {
    return (
      <div className="mx-auto max-w-5xl p-8 text-center text-text-soft">
        No se encontró el ingreso {id}.{' '}
        <Link to="/ingresos" className="text-accent-deep underline">Volver</Link>
      </div>
    );
  }

  const isPending = intake.status === 'PENDIENTE';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={<span className="font-mono text-3xl font-medium tracking-normal text-text">{intake.number}</span>}
        meta={
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-text-soft">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5"
              style={{ backgroundColor: VEHICLE_INTAKE_STATUS_STRIP[intake.status] }}
            />
            {VEHICLE_INTAKE_STATUS_LABELS[intake.status]}
          </span>
        }
        subtitle={`${intake.customerName} — ${intake.vehicleLabel}`}
        actions={
          <>
            <Link to="/ingresos">
              <Button variant="ghost" type="button"><XCircle size={16} /> Volver</Button>
            </Link>
            {intake.quotationNumber && (
              <Link to={`/cotizacion/${intake.quotationNumber}`}>
                <Button variant="secondary" type="button">
                  <Receipt size={16} /> {intake.quotationNumber}
                </Button>
              </Link>
            )}
            {isAdmin && isPending && (
              <Button onClick={handleConvert} disabled={converting}>
                <Receipt size={16} /> {converting ? 'Creando...' : 'Crear cotización'} <ArrowRight size={14} />
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="p-5 space-y-4">
        <SectionHeader title="Datos del ingreso" />
        <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
          Observaciones
          <textarea
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            disabled={!isAdmin}
            rows={3}
            className="mt-1 w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none disabled:bg-panel-alt"
          />
        </label>
        {isAdmin && (
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          </div>
        )}
      </Panel>

      <PartsSection intake={intake} isAdmin={isAdmin} onChanged={load} onError={setError} />

      <PhotosSection intake={intake} isAdmin={isAdmin} onChanged={load} onError={setError} />
    </div>
  );
}

/**
 * Piezas del ingreso (inyector, bomba...), identificadas por N° de serie.
 * No hace falta cargarlas al recibir el vehículo: se agregan, corrigen o
 * borran en cualquier momento desde acá.
 */
function PartsSection({
  intake,
  isAdmin,
  onChanged,
  onError,
}: {
  intake: VehicleIntakeDetail;
  isAdmin: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = React.useState('');
  const [serialNumber, setSerialNumber] = React.useState('');
  const [adding, setAdding] = React.useState(false);

  async function handleAdd() {
    if (!name.trim() || !serialNumber.trim()) return;
    setAdding(true);
    onError('');
    try {
      await addIntakePart(intake.id, { name: name.trim(), serialNumber: serialNumber.trim() });
      setName('');
      setSerialNumber('');
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Panel className="p-5 space-y-4">
      <SectionHeader title={`Piezas${intake.parts.length > 0 ? ` (${intake.parts.length})` : ''}`} />

      {isAdmin && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex-1 text-xs font-bold uppercase tracking-wider text-text-soft">
            Pieza
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Inyector, Bomba"
              className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none"
            />
          </label>
          <label className="flex-1 text-xs font-bold uppercase tracking-wider text-text-soft">
            N° de serie
            <input
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
              placeholder="Ej: A1B2C3"
              className="mt-1 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm font-mono focus:border-accent-deep focus:outline-none"
            />
          </label>
          <Button
            type="button"
            onClick={handleAdd}
            disabled={adding || !name.trim() || !serialNumber.trim()}
          >
            <Plus size={15} /> {adding ? 'Agregando…' : 'Agregar'}
          </Button>
        </div>
      )}

      {intake.parts.length === 0 ? (
        <p className="py-4 text-center text-sm text-text-soft">Todavía no hay piezas cargadas.</p>
      ) : (
        <ul className="space-y-2">
          {intake.parts.map((part) => (
            <PartRow key={part.id} part={part} isAdmin={isAdmin} onChanged={onChanged} onError={onError} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PartRow({
  part,
  isAdmin,
  onChanged,
  onError,
}: {
  part: VehicleIntakePart;
  isAdmin: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = React.useState(part.name);
  const [serialNumber, setSerialNumber] = React.useState(part.serialNumber);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const dirty = name !== part.name || serialNumber !== part.serialNumber;
  const fieldClass =
    'flex-1 min-w-[8rem] rounded border border-transparent bg-transparent px-2 py-1 text-sm ' +
    'focus:border-accent-deep focus:bg-panel focus:outline-none disabled:text-text-soft';

  async function handleSave() {
    if (!name.trim() || !serialNumber.trim() || !dirty) return;
    setSaving(true);
    onError('');
    try {
      await updateIntakePart(part.id, { name: name.trim(), serialNumber: serialNumber.trim() });
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('¿Eliminar esta pieza?')) return;
    setDeleting(true);
    onError('');
    try {
      await deleteIntakePart(part.id);
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel-alt px-3 py-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={!isAdmin}
        className={fieldClass}
      />
      <input
        value={serialNumber}
        onChange={(e) => setSerialNumber(e.target.value)}
        disabled={!isAdmin}
        className={cn(fieldClass, 'font-mono')}
      />
      {isAdmin && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {dirty && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              title="Guardar cambios"
              className="text-text-soft transition-colors hover:text-accent-deep"
            >
              <Check size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            title="Eliminar pieza"
            className="text-text-soft transition-colors hover:text-danger"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </li>
  );
}

function PhotosSection({
  intake,
  isAdmin,
  onChanged,
  onError,
}: {
  intake: VehicleIntakeDetail;
  isAdmin: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    onError('');
    try {
      for (const file of Array.from(files)) {
        await uploadIntakePhoto(intake.id, file);
      }
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <Panel className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeader title={`Fotos${intake.photos.length > 0 ? ` (${intake.photos.length})` : ''}`} />
        {isAdmin && (
          <label className="cursor-pointer">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(e) => handleFiles(e.target.files)}
              disabled={uploading}
              className="hidden"
            />
            <span className="inline-flex items-center gap-1.5 bg-accent px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-accent-ink hover:bg-accent-deep hover:text-white transition-colors">
              <Camera size={15} /> {uploading ? 'Subiendo...' : 'Agregar foto'}
            </span>
          </label>
        )}
      </div>

      {intake.photos.length === 0 ? (
        <p className="flex flex-col items-center gap-2 py-8 text-sm text-text-soft">
          <ImageOff size={22} className="text-text-faint" />
          Todavía no hay fotos cargadas.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {intake.photos.map((photo) => (
            <PhotoThumb key={photo.id} photo={photo} isAdmin={isAdmin} onChanged={onChanged} onError={onError} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function PhotoThumb({
  photo,
  isAdmin,
  onChanged,
  onError,
}: {
  photo: VehicleIntakePhoto;
  isAdmin: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    getIntakePhotoUrl(photo.storagePath)
      .then((signed) => !cancelled && setUrl(signed))
      .catch(() => {/* la miniatura queda vacía; no vale la pena cortar el resto de la pantalla */});
    return () => { cancelled = true; };
  }, [photo.storagePath]);

  async function handleDelete() {
    if (!window.confirm('¿Eliminar esta foto?')) return;
    setDeleting(true);
    try {
      await deleteIntakePhoto(photo);
      onChanged();
    } catch (err) {
      onError(getErrorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <div className="group relative aspect-square overflow-hidden border border-line bg-panel-alt">
      {url ? (
        <img src={url} alt="Foto del ingreso" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-text-faint">
          <Camera size={20} />
        </div>
      )}
      {isAdmin && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          title="Eliminar foto"
          className="absolute right-1 top-1 bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-danger group-hover:opacity-100 disabled:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}
