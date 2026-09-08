/**
 * Enter avanza al campo siguiente, en toda la aplicación.
 *
 * Quien carga datos todo el día lo hace con las dos manos en el teclado: pedir
 * Tab entre campo y campo, o peor el mouse, cuesta horas por semana. Enter es
 * la tecla que la mano ya está buscando.
 *
 * Se engancha UNA vez, en la raíz. La alternativa era tocar los quince
 * formularios y las pantallas de carga que ni siquiera son <form>; eso deja el
 * comportamiento disparejo y a la larga alguien agrega una pantalla y se
 * olvida.
 *
 * En el último campo envía el formulario, así la carga entera —tipear, avanzar
 * y guardar— se hace sin soltar el teclado. En una pantalla que no es <form>
 * no hay nada que enviar, así que ahí simplemente no hace nada.
 */

/** Los campos por los que Enter avanza. Los botones quedan afuera a propósito:
 *  si el recorrido terminara en "Cancelar", Enter borraría el trabajo. */
const SELECTOR_CAMPOS = 'input, select, textarea';

/** Tipos de input donde Enter tiene que seguir haciendo lo suyo. */
const TIPOS_QUE_NO_AVANZAN = new Set(['submit', 'button', 'reset', 'image', 'file', 'hidden']);

function esVisible(el: HTMLElement): boolean {
  // offsetParent en null cubre display:none y todo lo que esté dentro de algo
  // oculto. Un campo que no se ve no puede recibir el foco.
  return !!el.offsetParent && !el.hasAttribute('hidden');
}

function puedeRecibirFoco(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if ((el as HTMLInputElement).disabled) return false;
  if (el.tabIndex < 0) return false;
  if (el instanceof HTMLInputElement && TIPOS_QUE_NO_AVANZAN.has(el.type)) return false;
  return esVisible(el);
}

/**
 * Hasta dónde llega el recorrido. Importa acotarlo: sin esto, el último campo
 * de un modal saltaría al buscador del encabezado, que está en otra parte de
 * la pantalla y no tiene nada que ver con lo que se está cargando.
 *
 * El formulario manda. Si no hay, el modal. Si tampoco, el contenido de la
 * página —nunca el encabezado ni el menú lateral—.
 */
function ambito(campo: HTMLElement): HTMLElement {
  return (
    campo.closest('form') ??
    campo.closest<HTMLElement>('.fixed.inset-0') ??
    campo.closest('main') ??
    document.body
  );
}

function manejarEnter(evento: KeyboardEvent) {
  if (evento.key !== 'Enter') return;
  // Alguien ya lo resolvió a su manera (por ejemplo, renombrar un concepto
  // apretando Enter). No se le pisa.
  if (evento.defaultPrevented) return;
  // Ctrl+Enter y compañía son atajos de otra cosa.
  if (evento.ctrlKey || evento.metaKey || evento.altKey) return;

  const campo = evento.target;
  if (!(campo instanceof HTMLElement)) return;

  // En un textarea Enter es un salto de línea, no un avance. Y sobre un botón
  // o un enlace, Enter los activa: interceptarlo dejaría media aplicación sin
  // poder confirmarse con el teclado.
  if (campo instanceof HTMLTextAreaElement) return;
  if (!(campo instanceof HTMLInputElement) && !(campo instanceof HTMLSelectElement)) return;
  if (campo instanceof HTMLInputElement && TIPOS_QUE_NO_AVANZAN.has(campo.type)) return;

  const alcance = ambito(campo);
  const campos = Array.from(alcance.querySelectorAll(SELECTOR_CAMPOS)).filter(puedeRecibirFoco);
  const posicion = campos.indexOf(campo);
  if (posicion === -1) return;

  const siguiente = campos[posicion + 1];
  if (siguiente) {
    evento.preventDefault();
    siguiente.focus();
    return;
  }

  // Era el último: se guarda. requestSubmit dispara onSubmit y además corre la
  // validación del navegador, a diferencia de llamar a submit() a mano.
  const formulario = campo.closest('form');
  if (formulario) {
    evento.preventDefault();
    formulario.requestSubmit();
  }
}

/** Se llama una sola vez, desde la raíz de la aplicación. */
export function activarEnterAvanzaCampos(): () => void {
  document.addEventListener('keydown', manejarEnter);
  return () => document.removeEventListener('keydown', manejarEnter);
}
