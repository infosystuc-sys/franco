import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

/**
 * Convierte un nodo del DOM (el mismo comprobante que ya se ve en pantalla,
 * con la clase print-document) en un PDF A4, paginado si no entra en una
 * hoja. Se usa para adjuntar la factura al mandarla por mail o WhatsApp: no
 * hay render del lado del servidor, así que el PDF se arma en el navegador
 * con lo que ya está dibujado.
 *
 * El PDF sale igual desde cualquier dispositivo: la copia que se fotografía se
 * arma en una ventana de escritorio y con el ancho de una A4, no con el de la
 * pantalla de quien lo baja.
 */
/** Un centímetro, en puntos: el margen que queda alrededor del comprobante. */
const MARGEN = 28.35;

/**
 * Un punto de hoja, en píxeles de pantalla: 96 dpi contra los 72 dpi en que
 * jsPDF mide. Sirve para dibujar el comprobante exactamente del ancho que va a
 * ocupar impreso, así el texto sale del tamaño que dice su CSS en vez de
 * agrandarse o achicarse al pegarlo en la hoja.
 */
const PX_POR_PUNTO = 96 / 72;

/**
 * El ancho de ventana con el que se arma la copia que se fotografía. Las media
 * queries de Tailwind (sm:, md:) miran el ancho de la ventana, no el del
 * elemento: desde un celular todas daban falso y el comprobante salía en una
 * sola columna, con el membrete y los datos del cliente apilados, estirado
 * después a lo ancho de la hoja. Con una ventana de escritorio la copia sale
 * armada igual que en una PC, que es como está pensado el comprobante.
 */
const VENTANA_DE_ESCRITORIO = 1280;

async function renderElementToPdf(element: HTMLElement): Promise<jsPDF> {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const anchoUtil = pdf.internal.pageSize.getWidth() - MARGEN * 2;
  const altoUtil = pdf.internal.pageSize.getHeight() - MARGEN * 2;

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
    windowWidth: VENTANA_DE_ESCRITORIO,
    // Alto de sobra: la copia se arma en un iframe de este tamaño y no quiere
    // quedar corta con un comprobante largo.
    windowHeight: 2000,
    onclone: (_documento, copia) => {
      // Y el ancho del comprobante se fija en el que va a ocupar impreso, para
      // que el PDF salga igual desde un celular que desde una PC: si se lo deja
      // tomar el ancho de su contenedor, cada pantalla da uno distinto y el
      // texto termina más grande o más chico según de dónde se lo bajó.
      copia.style.width = `${anchoUtil * PX_POR_PUNTO}px`;
      copia.style.maxWidth = 'none';
    },
  });

  // Cuántos puntos de hoja mide un píxel del dibujo, para traducir de uno a
  // otro en los dos sentidos.
  const escala = anchoUtil / canvas.width;
  const altoDeUnaHoja = Math.floor(altoUtil / escala);

  // Se recorta el dibujo en pedazos de una hoja y cada pedazo va en su página.
  // Antes se mandaba el dibujo entero a cada página, corrido hacia arriba: eso
  // alcanzaba mientras el comprobante arrancaba pegado al borde, pero con
  // margen el sobrante de una página invade el margen de abajo y vuelve a
  // aparecer arriba de la siguiente, repetido.
  let desde = 0;
  let primera = true;

  while (desde < canvas.height) {
    const alto = Math.min(altoDeUnaHoja, canvas.height - desde);

    const pedazo = document.createElement('canvas');
    pedazo.width = canvas.width;
    pedazo.height = alto;
    const ctx = pedazo.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pedazo.width, pedazo.height);
    ctx.drawImage(canvas, 0, desde, canvas.width, alto, 0, 0, canvas.width, alto);

    if (!primera) pdf.addPage();
    pdf.addImage(
      pedazo.toDataURL('image/jpeg', 0.92),
      'JPEG',
      MARGEN,
      MARGEN,
      anchoUtil,
      alto * escala
    );

    primera = false;
    desde += alto;
  }

  return pdf;
}

export async function renderElementToPdfBase64(element: HTMLElement): Promise<string> {
  const pdf = await renderElementToPdf(element);
  return pdf.output('datauristring').split(',')[1];
}

/**
 * El mismo PDF, pero bajado como archivo.
 *
 * Lo usa el cliente desde el link que le llega por WhatsApp: entra, ve el
 * presupuesto y se lo guarda. Se arma en su propio navegador con lo que ya
 * está en pantalla, así que siempre baja la versión vigente —no una copia
 * congelada del día que se mandó el mensaje—.
 */
export async function downloadElementAsPdf(element: HTMLElement, fileName: string): Promise<void> {
  const pdf = await renderElementToPdf(element);
  pdf.save(fileName);
}
