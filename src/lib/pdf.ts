import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

/**
 * Convierte un nodo del DOM (el mismo comprobante que ya se ve en pantalla,
 * con la clase print-document) en un PDF A4, paginado si no entra en una
 * hoja. Se usa para adjuntar la factura al mandarla por mail o WhatsApp: no
 * hay render del lado del servidor, así que el PDF se arma en el navegador
 * con lo que ya está dibujado.
 */
/** Un centímetro, en puntos: el margen que queda alrededor del comprobante. */
const MARGEN = 28.35;

async function renderElementToPdf(element: HTMLElement): Promise<jsPDF> {
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
  });

  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const anchoUtil = pdf.internal.pageSize.getWidth() - MARGEN * 2;
  const altoUtil = pdf.internal.pageSize.getHeight() - MARGEN * 2;

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
