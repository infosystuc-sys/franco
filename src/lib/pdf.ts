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

/**
 * html2canvas dibuja una copia de la página dentro de un iframe, y esa copia
 * vuelve a pedir la hoja de estilos por la red. Con la pestaña abierta desde
 * antes de una publicación nueva en Vercel, esa hoja ya no existe (cada
 * publicación le cambia el nombre): la pantalla se ve bien porque la cargó
 * antes, pero la copia queda sin estilos y el PDF sale con el logo a toda
 * página y el texto desarmado.
 *
 * Por eso la copia no usa los <link> de estilos: lleva escritas las reglas que
 * esta pestaña ya tiene en memoria, que son las mismas con las que se ve la
 * pantalla. Las hojas de otro origen (las fuentes de Google) no se pueden leer
 * y se dejan como están.
 */
function usarEstilosYaCargados(copia: Document) {
  const reglas: string[] = [];
  const leidas = new Set<string>();
  for (const hoja of Array.from(document.styleSheets)) {
    try {
      reglas.push(Array.from(hoja.cssRules).map((r) => r.cssText).join('\n'));
      if (hoja.href) leidas.add(hoja.href);
    } catch {
      // Hoja de otro origen: no se puede leer, queda su <link>.
    }
  }
  for (const link of Array.from(copia.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
    if (leidas.has(link.href)) link.remove();
  }
  for (const estilo of Array.from(copia.querySelectorAll('style'))) estilo.remove();
  const estilo = copia.createElement('style');
  estilo.textContent = reglas.join('\n');
  copia.head.appendChild(estilo);
}

/**
 * html2canvas no entiende los colores oklab/oklch, que es como el navegador
 * devuelve un color con transparencia de Tailwind (bg-panel-head/60, que se
 * arma con color-mix): corta con "unsupported color function oklab" y no
 * hay PDF. Antes de fotografiar, cada color así de la copia se reemplaza por
 * su equivalente rgba, pintándolo en un canvas y leyendo el píxel.
 */
const PROPIEDADES_DE_COLOR = [
  'color', 'background-color', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color',
] as const;

function colorEnRgba(valor: string, cache: Map<string, string>, ctx: CanvasRenderingContext2D): string {
  const guardado = cache.get(valor);
  if (guardado) return guardado;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = valor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const rgba = `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
  cache.set(valor, rgba);
  return rgba;
}

function colorNoSoportado(valor: string): boolean {
  return /okl(ab|ch)|color\(|color-mix|lab\(|lch\(/i.test(valor);
}

function pasarColoresARgba(documento: Document, raiz: HTMLElement) {
  const vista = documento.defaultView;
  if (!vista) return;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const cache = new Map<string, string>();
  const elementos = [raiz, ...Array.from(raiz.querySelectorAll<HTMLElement>('*'))];
  for (const el of elementos) {
    const estilo = vista.getComputedStyle(el);
    for (const prop of PROPIEDADES_DE_COLOR) {
      const valor = estilo.getPropertyValue(prop);
      if (valor && colorNoSoportado(valor)) {
        el.style.setProperty(prop, colorEnRgba(valor, cache, ctx), 'important');
      }
    }
    // Sombras y degradados con esos colores no se pueden traducir de a uno:
    // se sacan, que en un PDF no hacen falta.
    for (const prop of ['box-shadow', 'background-image', 'text-shadow'] as const) {
      const valor = estilo.getPropertyValue(prop);
      if (valor && colorNoSoportado(valor)) el.style.setProperty(prop, 'none', 'important');
    }
  }
}

async function renderElementToPdf(element: HTMLElement): Promise<jsPDF> {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  // Con data-hojas-separadas, cada hijo es un comprobante y arranca en una
  // hoja nueva (la factura y su remito); si no, va todo seguido.
  const partes = element.hasAttribute('data-hojas-separadas')
    ? (Array.from(element.children) as HTMLElement[])
    : [element];
  for (let i = 0; i < partes.length; i++) {
    if (i > 0) pdf.addPage();
    await dibujarEnPdf(pdf, partes[i]);
  }
  return pdf;
}

async function dibujarEnPdf(pdf: jsPDF, element: HTMLElement): Promise<void> {
  const anchoUtil = pdf.internal.pageSize.getWidth() - MARGEN * 2;
  const altoUtil = pdf.internal.pageSize.getHeight() - MARGEN * 2;
  // Dónde se puede cortar la hoja sin partir un renglón, en píxeles de la
  // copia y medidos desde su borde de arriba; se llenan al armar la copia.
  let cortes: number[] = [];
  let altoDeLaCopia = 0;

  const canvas = await html2canvas(element, {
    // Tres píxeles por punto de pantalla: con dos, el QR de ARCA salía con los
    // bordes de los módulos borroneados y a algunos celulares les costaba leerlo.
    scale: 3,
    useCORS: true,
    backgroundColor: '#ffffff',
    windowWidth: VENTANA_DE_ESCRITORIO,
    // Alto de sobra: la copia se arma en un iframe de este tamaño y no quiere
    // quedar corta con un comprobante largo.
    windowHeight: 2000,
    onclone: (documento, copia) => {
      usarEstilosYaCargados(documento);
      // Y el ancho del comprobante se fija en el que va a ocupar impreso, para
      // que el PDF salga igual desde un celular que desde una PC: si se lo deja
      // tomar el ancho de su contenedor, cada pantalla da uno distinto y el
      // texto termina más grande o más chico según de dónde se lo bajó.
      copia.style.width = `${anchoUtil * PX_POR_PUNTO}px`;
      copia.style.maxWidth = 'none';
      // Lo que solo va en el papel (el membrete de los informes): la copia se
      // dibuja con los estilos de pantalla, donde está oculto.
      for (const el of Array.from(copia.querySelectorAll<HTMLElement>('[data-solo-pdf]'))) {
        el.style.setProperty('display', 'grid', 'important');
      }
      // Y lo que no va en el papel (un botón "Cobrar" junto al cliente) tampoco
      // va en el PDF que se le manda.
      for (const el of Array.from(copia.querySelectorAll<HTMLElement>('.no-print'))) {
        el.style.setProperty('display', 'none', 'important');
      }
      // Una tabla más ancha que la hoja (la composición de saldos, con sus
      // ocho columnas) quedaba recortada por su contenedor con scroll: en el
      // PDF faltaban Debe, Haber y Total. Sin el scroll, la copia se ensancha
      // hasta que entre todo y después se achica entera al ancho de la A4.
      for (const el of Array.from(copia.querySelectorAll<HTMLElement>('*'))) {
        const { overflowX } = documento.defaultView!.getComputedStyle(el);
        if (overflowX === 'auto' || overflowX === 'scroll') el.style.setProperty('overflow', 'visible', 'important');
      }
      if (copia.scrollWidth > copia.clientWidth) copia.style.width = `${copia.scrollWidth}px`;

      const arriba = copia.getBoundingClientRect().top;
      altoDeLaCopia = copia.getBoundingClientRect().height;
      cortes = [
        ...Array.from(copia.querySelectorAll('tr')).map((tr) => tr.getBoundingClientRect().bottom - arriba),
        ...Array.from(copia.querySelectorAll('section')).map((s) => s.getBoundingClientRect().top - arriba),
        ...Array.from(copia.children).map((c) => c.getBoundingClientRect().bottom - arriba),
      ];
      pasarColoresARgba(documento, copia);
    },
  });
  const pixelesPorPx = altoDeLaCopia > 0 ? canvas.height / altoDeLaCopia : 0;
  const cortesEnElDibujo = cortes.map((c) => Math.round(c * pixelesPorPx)).sort((a, b) => a - b);

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
    let alto = Math.min(altoDeUnaHoja, canvas.height - desde);
    // Si no es la última hoja, se corta en el último borde de renglón que
    // entra, para que ningún renglón quede partido entre dos hojas. Si no hay
    // ninguno en la segunda mitad de la hoja, se corta donde caiga.
    if (desde + alto < canvas.height) {
      const corte = cortesEnElDibujo.filter((c) => c > desde + alto / 2 && c <= desde + alto).pop();
      if (corte) alto = corte - desde;
    }

    const pedazo = document.createElement('canvas');
    pedazo.width = canvas.width;
    pedazo.height = alto;
    const ctx = pedazo.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pedazo.width, pedazo.height);
    ctx.drawImage(canvas, 0, desde, canvas.width, alto, 0, 0, canvas.width, alto);

    if (!primera) pdf.addPage();
    pdf.addImage(
      pedazo.toDataURL('image/jpeg', 0.95),
      'JPEG',
      MARGEN,
      MARGEN,
      anchoUtil,
      alto * escala
    );

    primera = false;
    desde += alto;
  }
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
