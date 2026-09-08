import React from 'react';
import { Camera, Upload, Trash2, X } from 'lucide-react';
import { Button } from '@/src/components/ui';
import {
  deleteVehiclePhoto,
  getVehiclePhotoUrl,
  type VehiclePhoto,
} from '@/src/lib/vehiclePhotos';

/**
 * Fotos del equipo que ingresa.
 *
 * Dos caminos para sacarlas, porque ninguno cubre todo:
 *
 *  - Subir archivo (`<input type="file">`): funciona en cualquier lado. En
 *    celular y tablet el propio sistema ofrece "sacar foto ahora".
 *  - Usar cámara (getUserMedia): es el único que abre la webcam de una
 *    notebook, donde el input de archivo solo muestra el explorador.
 *
 * Mientras el equipo no existe todavía —se está dando de alta— las fotos se
 * juntan acá y se suben recién cuando hay id contra el cual guardarlas. Es el
 * mismo criterio que las piezas recibidas del alta de OT.
 */
export function VehiclePhotos({
  vehicleId,
  guardadas,
  onGuardadasChange,
  pendientes,
  onPendientesChange,
  onError,
}: {
  /** Null mientras el equipo no se guardó: ahí solo hay pendientes. */
  vehicleId: string | null;
  guardadas: VehiclePhoto[];
  onGuardadasChange: (fotos: VehiclePhoto[]) => void;
  pendientes: File[];
  onPendientesChange: (archivos: File[]) => void;
  onError: (mensaje: string) => void;
}) {
  const [camaraAbierta, setCamaraAbierta] = React.useState(false);
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const inputArchivo = React.useRef<HTMLInputElement>(null);

  // El bucket es privado: cada foto guardada necesita su URL firmada.
  React.useEffect(() => {
    let cancelado = false;
    Promise.all(
      guardadas.map(async (f) => [f.id, await getVehiclePhotoUrl(f)] as const)
    ).then((pares) => {
      if (cancelado) return;
      const mapa: Record<string, string> = {};
      for (const [id, url] of pares) if (url) mapa[id] = url;
      setUrls(mapa);
    });
    return () => { cancelado = true; };
  }, [guardadas]);

  // Las vistas previas de lo pendiente son objetos en memoria: hay que
  // liberarlos o el navegador los retiene hasta recargar la página.
  const previas = React.useMemo(
    () => pendientes.map((archivo) => ({ archivo, url: URL.createObjectURL(archivo) })),
    [pendientes]
  );
  React.useEffect(() => {
    return () => { previas.forEach((p) => URL.revokeObjectURL(p.url)); };
  }, [previas]);

  function agregarArchivos(lista: FileList | null) {
    if (!lista || lista.length === 0) return;
    onPendientesChange([...pendientes, ...Array.from(lista)]);
    // Sin esto, elegir el mismo archivo dos veces seguidas no dispara change.
    if (inputArchivo.current) inputArchivo.current.value = '';
  }

  async function quitarGuardada(foto: VehiclePhoto) {
    if (!window.confirm('¿Borrar esta foto? No se puede deshacer.')) return;
    try {
      await deleteVehiclePhoto(foto);
      onGuardadasChange(guardadas.filter((f) => f.id !== foto.id));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'No se pudo borrar la foto.');
    }
  }

  const hayFotos = guardadas.length > 0 || previas.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line-strong bg-panel px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-soft transition-colors hover:bg-panel-alt">
          <Upload size={15} /> Subir archivo
          <input
            ref={inputArchivo}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => agregarArchivos(e.target.files)}
            className="hidden"
          />
        </label>
        <Button type="button" variant="ghost" onClick={() => setCamaraAbierta(true)}>
          <Camera size={15} /> Usar cámara
        </Button>
      </div>

      {!hayFotos && (
        <p className="text-xs text-text-soft">
          Todavía no hay fotos. Sirven para dejar asentado con qué estado llegó el equipo.
        </p>
      )}

      {hayFotos && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {guardadas.map((foto) => (
            <div key={foto.id} className="group relative overflow-hidden rounded-md border border-line">
              {urls[foto.id] ? (
                <img src={urls[foto.id]} alt="" className="h-28 w-full object-cover" />
              ) : (
                <div className="flex h-28 w-full items-center justify-center text-[11px] text-text-soft">Cargando…</div>
              )}
              <button
                type="button"
                onClick={() => quitarGuardada(foto)}
                aria-label="Borrar foto"
                className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          {previas.map((p, i) => (
            <div key={i} className="group relative overflow-hidden rounded-md border border-dashed border-accent-deep">
              <img src={p.url} alt="" className="h-28 w-full object-cover" />
              <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-center text-[10px] text-white">
                Se sube al guardar
              </span>
              <button
                type="button"
                onClick={() => onPendientesChange(pendientes.filter((_, j) => j !== i))}
                aria-label="Quitar foto"
                className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {camaraAbierta && (
        <CamaraEnVivo
          onCapturar={(archivo) => {
            onPendientesChange([...pendientes, archivo]);
            setCamaraAbierta(false);
          }}
          onCerrar={() => setCamaraAbierta(false)}
          onError={onError}
        />
      )}
    </div>
  );
}

/**
 * Cámara en vivo. Es el único camino que abre la webcam de una notebook: el
 * input de archivo con `capture` solo hace eso en celular y tablet.
 *
 * Pide la cámara trasera cuando existe (`environment`), que es la que sirve
 * para fotografiar un equipo; en una notebook no hay y el navegador entrega
 * la única que tenga.
 */
function CamaraEnVivo({
  onCapturar,
  onCerrar,
  onError,
}: {
  onCapturar: (archivo: File) => void;
  onCerrar: () => void;
  onError: (mensaje: string) => void;
}) {
  const video = React.useRef<HTMLVideoElement>(null);
  const [lista, setLista] = React.useState(false);

  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelado = false;

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (cancelado) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          video.current.play().catch(() => {});
        }
        setLista(true);
      })
      .catch(() => {
        if (cancelado) return;
        onError(
          'No se pudo abrir la cámara. Revisá que el navegador tenga permiso, ' +
          'o usá "Subir archivo".'
        );
        onCerrar();
      });

    // Apagar la cámara al cerrar es obligatorio: si no, la luz queda prendida
    // y el navegador sigue reteniendo el dispositivo.
    return () => {
      cancelado = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCerrar, onError]);

  function sacar() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const lienzo = document.createElement('canvas');
    lienzo.width = v.videoWidth;
    lienzo.height = v.videoHeight;
    lienzo.getContext('2d')?.drawImage(v, 0, 0);
    lienzo.toBlob((blob) => {
      if (!blob) return;
      onCapturar(new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col border border-line-strong bg-panel">
        <div className="flex items-center justify-between border-b border-line bg-panel-head px-5 py-3">
          <h2 className="font-display text-xl uppercase tracking-[0.04em] text-text-faint">Sacar foto</h2>
          <button type="button" onClick={onCerrar} aria-label="Cerrar" className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-5">
          <video ref={video} playsInline muted className="w-full rounded-md bg-black" />
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button type="button" variant="ghost" onClick={onCerrar}>Cancelar</Button>
          <Button type="button" onClick={sacar} disabled={!lista}>
            <Camera size={16} /> Sacar foto
          </Button>
        </div>
      </div>
    </div>
  );
}
