import React from 'react';
import { XCircle, Camera, Trash2, Receipt, ArrowRight, ImageOff } from 'lucide-react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Button, PageHeader, Panel, SectionHeader, StateStrip } from '@/src/components/ui';
import { useAuth } from '@/src/lib/auth';
import { getErrorMessage } from '@/src/lib/workOrders';
import {
  convertIntakeToQuotation,
  deleteIntakePhoto,
  describeVehicleIntakeError,
  fetchVehicleIntake,
  getIntakePhotoUrl,
  updateVehicleIntake,
  uploadIntakePhoto,
  VEHICLE_INTAKE_STATUS_LABELS,
  VEHICLE_INTAKE_STATUS_STRIP,
  type VehicleIntakeDetail,
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

  const [component, setComponent] = React.useState('');
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
      setComponent(data?.component ?? '');
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
      await updateVehicleIntake(intake.id, { component, observations });
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
        <div className="border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <Panel className="p-5 space-y-4">
        <SectionHeader title="Datos del ingreso" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="text-xs font-bold uppercase tracking-wider text-text-soft">
            Componente
            <input
              value={component}
              onChange={(e) => setComponent(e.target.value)}
              disabled={!isAdmin}
              className="mt-1 w-full border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none disabled:bg-panel-alt"
              placeholder="Ej: Bomba de Inyección Common Rail"
            />
          </label>
        </div>
        <label className="block text-xs font-bold uppercase tracking-wider text-text-soft">
          Observaciones
          <textarea
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            disabled={!isAdmin}
            rows={3}
            className="mt-1 w-full resize-y border border-line bg-panel px-3 py-2 text-sm font-normal normal-case focus:border-accent-deep focus:outline-none disabled:bg-panel-alt"
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

      <PhotosSection intake={intake} isAdmin={isAdmin} onChanged={load} onError={setError} />
    </div>
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
