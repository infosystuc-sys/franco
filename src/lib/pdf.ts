import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

/**
 * Convierte un nodo del DOM (el mismo comprobante que ya se ve en pantalla,
 * con la clase print-document) en un PDF A4, paginado si no entra en una
 * hoja. Se usa para adjuntar la factura al mandarla por mail o WhatsApp: no
 * hay render del lado del servidor, así que el PDF se arma en el navegador
 * con lo que ya está dibujado.
 */
export async function renderElementToPdfBase64(element: HTMLElement): Promise<string> {
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
  });

  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;
  const imgData = canvas.toDataURL('image/jpeg', 0.92);

  let heightLeft = imgHeight;
  let position = 0;

  pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;

  while (heightLeft > 0) {
    position -= pageHeight;
    pdf.addPage();
    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }

  return pdf.output('datauristring').split(',')[1];
}
