import React from 'react';
import { Plus, Trash2, Package, Search, X, Check, PackagePlus } from 'lucide-react';
import { ArticleModal } from '@/src/components/ArticleModal';
import { fetchSuppliers, type Supplier } from '@/src/lib/suppliers';
import { fetchDefaultMarkup } from '@/src/lib/priceLists';
import { fetchComboArticleIds } from '@/src/lib/articleCombos';
import { cn, formatMoney } from '@/src/lib/utils';
import { Button, SectionHeader } from '@/src/components/ui';
import { articulosExactos, buscarArticulos, ARTICULOS_A_MOSTRAR, type Article } from '@/src/lib/articles';
import type { WorkOrderItemInput } from '@/src/lib/workOrders';

/**
 * Las cantidades de una orden son piezas: tres toberas, un filtro. No hay
 * medio inyector. Se redondea hacia abajo y nunca baja de uno, así borrar el
 * campo no deja un renglón de cero unidades que igual suma al total.
 */
function enteroDeCantidad(valor: string): number {
  const n = Math.floor(Number(valor));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

const IVA_RATE = 0.21;

/**
 * Editor de renglones compartido por órdenes de trabajo y cotizaciones:
 * ambas se cargan igual (artículos del catálogo o líneas manuales).
 * Con `editable` en false se muestra en solo lectura.
 */
export function ItemsEditor({
  items,
  onChange,
  articles,
  editable,
  title = 'Renglones',
  totals,
  descripcionEditable = false,
}: {
  items: WorkOrderItemInput[];
  onChange: (items: WorkOrderItemInput[]) => void;
  articles: Article[];
  editable: boolean;
  title?: string;
  /**
   * Reemplaza el cuadro de totales. Lo usa la facturación, donde el IVA
   * depende de la letra del comprobante: en una factura C es cero y en una B
   * no se discrimina, así que el 21% fijo de acá no sirve.
   */
  totals?: React.ReactNode;
  /**
   * Deja corregir la descripción de un renglón de catálogo. La usa la
   * facturación: el texto cambia solo en ese comprobante, el artículo queda
   * como estaba.
   */
  descripcionEditable?: boolean;
}) {
  // El buscador abierto: null = cerrado. Con texto, lo abrió el campo código
  // porque no encontró un artículo exacto; vacío, la lupa con el campo vacío.
  const [picker, setPicker] = React.useState<string | null>(null);
  const codigoRef = React.useRef<HTMLInputElement>(null);
  // Artículos creados al vuelo desde el buscador: el catálogo que llega por
  // prop no se refresca solo, así que se suman acá para que aparezcan de
  // inmediato en la misma sesión de carga.
  const [extraArticles, setExtraArticles] = React.useState<Article[]>([]);
  const allArticles = React.useMemo(() => [...articles, ...extraArticles], [articles, extraArticles]);

  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const iva = total * IVA_RATE;

  function updateItem(index: number, patch: Partial<WorkOrderItemInput>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function addManualItem() {
    onChange([...items, { articleId: null, code: '', description: '', quantity: 1, unitPrice: 0 }]);
  }

  function addArticle(article: Article) {
    onChange([
      ...items,
      {
        articleId: article.id,
        code: article.code,
        description: article.description,
        quantity: 1,
        unitPrice: article.unitPrice,
      },
    ]);
  }

  function cerrarPicker() {
    setPicker(null);
    // Al volver, el foco queda en el campo para cargar el siguiente.
    setTimeout(() => codigoRef.current?.focus(), 0);
  }

  function handleArticleCreated(article: Article) {
    setExtraArticles((current) => [...current, article]);
    addArticle(article);
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title={title}
        actions={
          editable && (
            <>
              <Button type="button" variant="ghost" onClick={addManualItem} className="px-3">
                <Plus size={16} /> Línea manual
              </Button>
            </>
          )
        }
      />

      {editable && (
        <BuscadorDeArticulo
          articles={allArticles}
          inputRef={codigoRef}
          onElegir={addArticle}
          onAbrirCatalogo={() => setPicker('')}
          onArticuloCreado={(article) => {
            handleArticleCreated(article);
            setTimeout(() => codigoRef.current?.focus(), 0);
          }}
        />
      )}

      <div className="overflow-x-auto overflow-y-hidden rounded-md border border-line">
        <table className="table-stack w-full text-left text-[15px]">
          <thead className="h-9 bg-panel-head text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
            <tr>
              <th className="px-3 py-1 w-24">Código</th>
              <th className="px-3 py-1">Descripción</th>
              <th className="px-3 py-1 w-24 text-right">Cant.</th>
              <th className="px-3 py-1 w-32 text-right">Precio Unit.</th>
              <th className="px-3 py-1 w-32 text-right">Subtotal</th>
              {editable && <th className="px-3 py-1 w-12"></th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={editable ? 6 : 5} className="px-3 py-4 text-center text-text-soft">
                  Sin renglones cargados.
                </td>
              </tr>
            )}
            {items.map((item, idx) => (
              <tr key={idx} className={cn(
                "h-9 border-b border-line transition-colors",
                idx % 2 === 0 ? "bg-panel-alt" : "bg-panel"
              )}>
                {editable ? (
                  <>
                    {item.articleId ? (
                      <>
                        {/* Renglón de catálogo: código y descripción vienen del artículo */}
                        <td data-primary className="whitespace-nowrap px-3 py-1 font-mono font-semibold text-text-soft">
                          <span className="inline-flex items-center gap-1.5">
                            <Package size={12} className="text-accent-deep" />
                            {item.code}
                          </span>
                        </td>
                        {descripcionEditable ? (
                          <td data-label="Descripción" className="px-1 py-1">
                            <input
                              value={item.description}
                              onChange={(e) => updateItem(idx, { description: e.target.value })}
                              title="Cambia solo en este comprobante, no en el artículo"
                              className="w-full bg-transparent px-2 py-1"
                            />
                          </td>
                        ) : (
                          <td data-label="Descripción" className="px-3 py-1">{item.description}</td>
                        )}
                      </>
                    ) : (
                      <>
                        <td data-label="Cant." className="px-1 py-1">
                          <input value={item.code} onChange={(e) => updateItem(idx, { code: e.target.value })} placeholder="Código" className="w-full bg-transparent px-2 py-1 text-text-soft" />
                        </td>
                        <td data-label="P. unit." className="px-1 py-1">
                          <input value={item.description} onChange={(e) => updateItem(idx, { description: e.target.value })} placeholder="Descripción" className="w-full bg-transparent px-2 py-1" />
                        </td>
                      </>
                    )}
                    <td data-label="Cant." className="px-1 py-1">
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => updateItem(idx, { quantity: enteroDeCantidad(e.target.value) })}
                        className="w-full bg-transparent px-2 py-1 text-right"
                      />
                    </td>
                    <td data-label="P. unit." className="px-1 py-1">
                      <CampoImporte value={item.unitPrice} onChange={(n) => updateItem(idx, { unitPrice: n })} className="w-full bg-transparent px-2 py-1 text-right" />
                    </td>
                  </>
                ) : (
                  <>
                    <td data-primary className="px-3 py-1 text-text-soft">{item.code}</td>
                    <td data-label="Descripción" className="px-3 py-1">{item.description}</td>
                    <td data-label="Cant." className="px-3 py-1 text-right">{item.quantity}</td>
                    <td data-label="P. unit." className="px-3 py-1 text-right">$ {formatMoney(item.unitPrice)}</td>
                  </>
                )}
                <td data-label="Subtotal" className="px-3 py-1 text-right font-bold">$ {formatMoney(item.quantity * item.unitPrice)}</td>
                {editable && (
                  <td className="px-3 py-1 text-center">
                    <button type="button" onClick={() => removeItem(idx)} aria-label="Quitar renglón" className="text-text-soft transition-colors hover:text-danger">
                      <Trash2 size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot className="h-10 border-t-2 border-line-strong bg-panel-head">
            <tr>
              <td className="px-3 py-2 text-right text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft" colSpan={4}>
                Total neto
              </td>
              <td className="px-3 py-2 text-right font-display text-lg font-medium text-text">
                $ {formatMoney(total)}
              </td>
              {editable && <td></td>}
            </tr>
          </tfoot>
        </table>
      </div>

      {totals ?? (
        <div className="flex justify-end">
          <div className="w-full space-y-2 border border-line bg-panel-alt p-4 md:w-1/3">
            <div className="flex justify-between text-xs text-text-soft">
              <span>Subtotal</span>
              <span className="text-text">$ {formatMoney(total)}</span>
            </div>
            <div className="flex justify-between text-xs text-text-soft">
              <span>IVA 21%</span>
              <span className="text-text">$ {formatMoney(iva)}</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between border-t-2 border-accent pt-2">
              <span className="text-[13px] font-semibold uppercase tracking-[0.08em] text-text-soft">Total</span>
              <span className="font-display text-2xl font-medium text-text">
                $ {formatMoney(total + iva)}
              </span>
            </div>
          </div>
        </div>
      )}

      {picker !== null && (
        <ArticlePicker
          articles={allArticles}
          busquedaInicial={picker}
          cerrarAlElegir={picker !== ''}
          onPick={addArticle}
          onArticleCreated={handleArticleCreated}
          onClose={cerrarPicker}
          addedCount={items.length}
        />
      )}
    </div>
  );
}

function ArticlePicker({
  articles,
  busquedaInicial = '',
  cerrarAlElegir = false,
  onPick,
  onArticleCreated,
  onClose,
  addedCount,
}: {
  articles: Article[];
  /** Lo que se escribió en el campo código y no dio un artículo exacto. */
  busquedaInicial?: string;
  /** Abierto desde el campo código: se elige uno y vuelve al campo. */
  cerrarAlElegir?: boolean;
  onPick: (article: Article) => void;
  onArticleCreated: (article: Article) => void;
  onClose: () => void;
  addedCount: number;
}) {
  const [search, setSearch] = React.useState(busquedaInicial);
  const [justAdded, setJustAdded] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  /** Cuáles del catálogo son combos, para marcarlos en la lista. */
  const [combos, setCombos] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    // Si falla, la lista se ve igual pero sin la marca: no vale trabar la
    // carga de renglones por una etiqueta.
    fetchComboArticleIds().then(setCombos).catch(() => {});
  }, []);

  // Lo que filtra la lista va aparte de lo que muestra el campo. Al tipear,
  // el campo se actualiza en el acto y el filtrado va como transición, sin
  // trabar el teclado. Al elegir un artículo, en cambio, las dos se limpian
  // juntas y en el mismo instante: con una búsqueda "diferida" la lista vieja
  // quedaba un rato en pantalla antes de volver a mostrar todo el catálogo.
  const [busqueda, setBusqueda] = React.useState(busquedaInicial);
  const [, startTransition] = React.useTransition();
  // Exactos primero, después los que empiezan con lo escrito y al final el
  // resto de los que lo contienen.
  const filtered = React.useMemo(() => buscarArticulos(articles, busqueda), [articles, busqueda]);

  function buscar(valor: string) {
    setSearch(valor);
    startTransition(() => setBusqueda(valor));
  }

  // No se cierra al elegir: se puede seguir cargando renglones sin volver a
  // abrir la ventana. Se limpia la búsqueda y vuelve el foco, como si el
  // artículo elegido ya "saliera de la lista" para pasar al siguiente.
  // Estable entre renders (onPick llega nuevo cada vez): así los renglones,
  // memorizados, no se vuelven a dibujar cuando cambia la factura de atrás.
  const onPickRef = React.useRef(onPick);
  onPickRef.current = onPick;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const handlePick = React.useCallback((article: Article) => {
    onPickRef.current(article);
    // Abierto desde el campo código, se elige uno y se vuelve al campo para
    // seguir cargando, como en Tango.
    if (cerrarAlElegir) {
      onCloseRef.current();
      return;
    }
    setJustAdded(article.description);
    setSearch('');
    setBusqueda('');
    searchRef.current?.focus();
  }, [cerrarAlElegir]);

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-2xl flex flex-col max-h-[80vh]">
        <div className="flex justify-between items-center px-5 py-4 border-b border-line">
          <h2 className="text-base font-bold text-text">Agregar artículos del catálogo</h2>
          <button type="button" onClick={onClose} className="text-text-soft hover:text-text">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 pb-3 space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-soft" />
              <input
                ref={searchRef}
                autoFocus
                value={search}
                onChange={(e) => buscar(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
                placeholder="Buscar por código o descripción..."
                className="w-full h-9 pl-9 pr-3 border border-line text-sm"
              />
            </div>
            <NewArticleToggle onCreated={(article) => {
              onArticleCreated(article);
              setJustAdded(article.description);
            }} />
          </div>
          {justAdded && (
            <p className="flex items-center gap-1.5 text-xs text-state-done">
              <Check size={13} /> Se agregó "{justAdded}". Podés seguir eligiendo.
            </p>
          )}
        </div>

        <div className="overflow-y-auto px-5 pb-5">
          <table className="table-stack w-full text-left text-[14px]">
            <thead className="text-text-soft border-b border-line bg-panel-alt sticky top-0">
              <tr>
                <th className="p-2 font-bold w-28">Código</th>
                <th className="p-2 font-bold">Descripción</th>
                <th className="p-2 font-bold w-28 text-right">Precio</th>
                <th className="p-2 font-bold w-24 text-center">Stock</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-text-soft">
                    {articles.length === 0
                      ? 'No hay artículos activos en el catálogo. Creá uno con "+ Nuevo artículo", arriba.'
                      : 'Ningún artículo coincide con la búsqueda.'}
                  </td>
                </tr>
              )}
              {filtered.slice(0, ARTICULOS_A_MOSTRAR).map((article) => (
                <FilaDeArticulo key={article.id} article={article} esCombo={combos.has(article.id)} onPick={handlePick} />
              ))}
              {filtered.length > ARTICULOS_A_MOSTRAR && (
                <tr>
                  <td colSpan={4} className="p-3 text-center text-xs text-text-soft">
                    Se muestran {ARTICULOS_A_MOSTRAR} de {filtered.length.toLocaleString('es-AR')}. Escribí más para acotar la búsqueda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <span className="text-xs text-text-soft">
            {addedCount > 0 ? `${addedCount} renglón${addedCount === 1 ? '' : 'es'} cargado${addedCount === 1 ? '' : 's'}` : 'Sin renglones todavía'}
          </span>
          <Button type="button" onClick={onClose} className="px-4">Listo</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Alta de un artículo sin salir de la orden o la cotización.
 *
 * Abre la MISMA ficha que Inventario, no una versión reducida. Antes acá se
 * pedían solo código, descripción y precio, y el artículo nacía sin marca, sin
 * stock y sin proveedor: quien lo cargaba en el apuro de una recepción no
 * volvía después a completarlo, y el catálogo se llenaba de fichas a medias.
 */
function NewArticleToggle({
  onCreated,
  compacto = false,
}: {
  onCreated: (article: Article) => void;
  /** Solo el "+", del mismo tamaño que la lupa del campo producto. */
  compacto?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [defaultMarkup, setDefaultMarkup] = React.useState(0);

  React.useEffect(() => {
    if (!open) return;
    // Proveedores y utilidad por defecto son ayudas del formulario: si fallan,
    // el artículo se carga igual, solo que sin la vinculación ni el precio
    // sugerido.
    fetchSuppliers(true).then(setSuppliers).catch(() => {});
    fetchDefaultMarkup().then(setDefaultMarkup).catch(() => {});
  }, [open]);

  return (
    <>
      {compacto ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Nuevo artículo"
          aria-label="Nuevo artículo"
          className="flex h-10 w-11 items-center justify-center border border-l-0 border-line bg-panel-alt text-text-soft hover:text-text"
        >
          <Plus size={16} />
        </button>
      ) : (
        <Button type="button" variant="ghost" onClick={() => setOpen(true)} className="px-3 whitespace-nowrap">
          <PackagePlus size={16} /> Nuevo artículo
        </Button>
      )}

      {open && (
        <ArticleModal
          article={null}
          suppliers={suppliers}
          catalogo={[]}
          defaultMarkup={defaultMarkup}
          onClose={() => setOpen(false)}
          onSaved={(article) => {
            setOpen(false);
            onCreated(article);
          }}
        />
      )}
    </>
  );
}

/**
 * Un renglón del buscador. Memorizado: al elegir un artículo cambia la
 * factura de atrás y todo se vuelve a dibujar; los renglones que no cambiaron
 * no tienen por qué.
 */
const FilaDeArticulo = React.memo(function FilaDeArticulo({
  article,
  esCombo,
  onPick,
}: {
  article: Article;
  esCombo: boolean;
  onPick: (article: Article) => void;
}) {
  return (
    <tr
      onClick={() => onPick(article)}
      className="border-b border-line transition-colors hover:bg-panel-alt cursor-pointer"
    >
      <td data-primary className="p-2 font-bold">
        {/* El número de fábrica primero: es el que se busca y el
            que está escrito en la pieza. El nuestro es interno. */}
        <span className="font-mono">{article.factoryCode ?? article.code}</span>
        {esCombo && (
          // Se avisa acá porque el combo entra como un renglón
          // solo: sin la marca, quien carga no sabe que ese
          // renglón se lleva varias piezas del estante.
          <span className="ml-1.5 rounded-full bg-accent/25 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-accent-deep">
            Combo
          </span>
        )}
      </td>
      <td data-label="Descripción" className="p-2">{article.description}</td>
      <td data-label="Precio" className="p-2 text-right">$ {formatMoney(article.unitPrice)}</td>
      <td data-label="Stock" className="p-2 text-center">
        {article.tracksStock ? (
          <span className={cn(
            "px-2 py-0.5 text-[12px] font-bold",
            article.stockQuantity === 0 ? "bg-red-100 text-danger"
              : article.stockQuantity <= 5 ? "bg-orange-100 text-orange-700"
              : "bg-green-100 text-green-700"
          )}>
            {article.stockQuantity === 0 ? 'Sin stock' : article.stockQuantity}
          </span>
        ) : (
          <span className="text-text-faint text-[12px] uppercase tracking-wider">—</span>
        )}
      </td>
    </tr>
  );
});

/**
 * "1.234,56", "1234,56", "1.500" o "10.5" → el número. La coma es siempre el
 * decimal; un punto seguido de tres cifras se toma como separador de miles,
 * que es como se escribe acá, y si no, como decimal. Vacío o ilegible → 0.
 */
function leerImporte(texto: string): number {
  const limpio = texto.includes(',') || /\.\d{3}$/.test(texto)
    ? texto.replace(/\./g, '').replace(',', '.')
    : texto;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : 0;
}

function mostrarImporte(valor: number): string {
  return valor ? String(valor).replace('.', ',') : '';
}

/**
 * El precio de un renglón. Con un input numérico el cero quedaba escrito y
 * había que borrarlo para cargar el precio; acá, si vale cero, el campo
 * aparece vacío, al entrar se selecciona lo que tenga y se escribe libre,
 * con coma o punto decimal.
 */
function CampoImporte({
  value,
  onChange,
  className,
}: {
  value: number;
  onChange: (valor: number) => void;
  className?: string;
}) {
  const [texto, setTexto] = React.useState(() => mostrarImporte(value));
  const editando = React.useRef(false);

  // Si el precio cambia desde afuera (otro artículo en el renglón), se
  // muestra; mientras se escribe, manda lo tipeado.
  React.useEffect(() => {
    if (!editando.current) setTexto(mostrarImporte(value));
  }, [value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={texto}
      placeholder="0,00"
      onFocus={(e) => {
        editando.current = true;
        e.target.select();
      }}
      onBlur={() => {
        editando.current = false;
        setTexto(mostrarImporte(value));
      }}
      onChange={(e) => {
        const t = e.target.value.replace(/[^0-9.,]/g, '');
        setTexto(t);
        onChange(leerImporte(t));
      }}
      className={className}
    />
  );
}

/** Cuántas sugerencias muestra la lista que se despliega bajo el campo. */
const SUGERENCIAS = 50;

/**
 * El campo "Producto / servicio", como en Tango: a medida que se escribe se
 * despliega debajo la lista de artículos que coinciden por número de
 * fábrica, nuestro código o descripción ("CÓDIGO - DESCRIPCIÓN - ..."). Con
 * las flechas se recorre, Enter agrega el marcado y Escape la cierra; también
 * se elige con el mouse. Los que coinciden exacto van primero, así un código
 * completo + Enter entra directo.
 */
function BuscadorDeArticulo({
  articles,
  inputRef,
  onElegir,
  onAbrirCatalogo,
  onArticuloCreado,
}: {
  articles: Article[];
  inputRef: React.RefObject<HTMLInputElement>;
  onElegir: (article: Article) => void;
  onAbrirCatalogo: () => void;
  /** El "+" de al lado de la lupa: alta de un artículo que entra como renglón. */
  onArticuloCreado: (article: Article) => void;
}) {
  const [texto, setTexto] = React.useState('');
  const [busqueda, setBusqueda] = React.useState('');
  const [, startTransition] = React.useTransition();
  const [abierta, setAbierta] = React.useState(false);
  const [marcado, setMarcado] = React.useState(0);
  const listaRef = React.useRef<HTMLUListElement>(null);
  const id = React.useId();

  const sugerencias = React.useMemo(
    () => (busqueda.trim() === '' ? [] : buscarArticulos(articles, busqueda).slice(0, SUGERENCIAS)),
    [articles, busqueda]
  );

  const visible = abierta && sugerencias.length > 0;

  // El marcado siempre a la vista al moverse con las flechas.
  React.useEffect(() => {
    if (!visible) return;
    const item = listaRef.current?.children[marcado] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [marcado, visible]);

  function escribir(valor: string) {
    setTexto(valor);
    setAbierta(true);
    setMarcado(0);
    startTransition(() => setBusqueda(valor));
  }

  function elegir(article: Article) {
    onElegir(article);
    setTexto('');
    setBusqueda('');
    setAbierta(false);
    setMarcado(0);
    inputRef.current?.focus();
  }

  function alApretar(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!abierta) setAbierta(true);
      setMarcado((m) => Math.min(m + 1, sugerencias.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMarcado((m) => Math.max(m - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Lo escrito puede no haber llegado todavía a la lista (va como
      // transición): con un código completo se resuelve en el acto.
      if (busqueda !== texto) {
        const exactos = articulosExactos(articles, texto);
        if (exactos.length === 1) elegir(exactos[0]);
        else escribir(texto);
        return;
      }
      if (visible && sugerencias[marcado]) elegir(sugerencias[marcado]);
      else if (texto.trim() === '') onAbrirCatalogo();
    } else if (e.key === 'Escape') {
      setAbierta(false);
    }
  }

  return (
    <div className="max-w-2xl text-[13px] font-semibold uppercase tracking-[0.06em] text-text-soft">
      <label htmlFor={id}>Producto / servicio</label>
      <div className="relative mt-1 flex">
        <input
          id={id}
          ref={inputRef}
          value={texto}
          onChange={(e) => escribir(e.target.value)}
          onKeyDown={alApretar}
          onFocus={() => texto && setAbierta(true)}
          onBlur={() => setAbierta(false)}
          autoComplete="off"
          role="combobox"
          aria-expanded={visible}
          aria-controls={`${id}-lista`}
          placeholder="Código de fábrica, nuestro código o descripción"
          className="h-10 min-w-0 flex-1 border border-line bg-panel px-3 text-[15px] font-normal normal-case tracking-normal text-text focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={onAbrirCatalogo}
          title="Buscar en el catálogo"
          aria-label="Buscar en el catálogo"
          className="flex h-10 w-11 items-center justify-center border border-l-0 border-line bg-panel-alt text-text-soft hover:text-text"
        >
          <Search size={16} />
        </button>
        <NewArticleToggle compacto onCreated={onArticuloCreado} />

        {visible && (
          <ul
            id={`${id}-lista`}
            ref={listaRef}
            role="listbox"
            className="absolute left-0 right-[5.5rem] top-full z-40 max-h-64 overflow-y-auto border border-line bg-panel shadow-lg"
          >
            {sugerencias.map((a, i) => (
              <li
                key={a.id}
                role="option"
                aria-selected={i === marcado}
                // mousedown y no click: con click el campo pierde el foco
                // antes, la lista se cierra y la elección no llega.
                onMouseDown={(e) => {
                  e.preventDefault();
                  elegir(a);
                }}
                onMouseEnter={() => setMarcado(i)}
                className={cn(
                  'cursor-pointer truncate px-3 py-1.5 text-[14px] font-normal normal-case tracking-normal text-text',
                  i === marcado ? 'bg-panel-head' : 'hover:bg-panel-alt'
                )}
              >
                {[a.code, a.description, a.factoryCode, a.brand].filter(Boolean).join(' - ')}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
