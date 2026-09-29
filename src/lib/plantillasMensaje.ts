import React from 'react';
import { supabase } from '@/src/lib/supabase';

/**
 * Los textos de los mensajes de WhatsApp y mail, editables desde
 * Configuración. Cada uno es una plantilla con variables entre llaves; una
 * línea con alguna variable sin valor se omite entera. Ver
 * supabase/plantillas-de-mensajes.sql: la base aplica la misma regla a los
 * WhatsApp que arma ella.
 */

export interface VariablePlantilla {
  nombre: string;
  descripcion: string;
}

export interface DefinicionPlantilla {
  clave: string;
  grupo: 'Automáticos por WhatsApp' | 'Envío de comprobantes';
  titulo: string;
  descripcion: string;
  canal: 'whatsapp' | 'mail';
  variables: VariablePlantilla[];
}

const V = (nombre: string, descripcion: string): VariablePlantilla => ({ nombre, descripcion });

const DEL_COMPROBANTE = [
  V('cliente', 'Nombre del cliente o proveedor'),
  V('numero', 'Número del comprobante'),
  V('total', 'Importe total'),
];

export const PLANTILLAS: DefinicionPlantilla[] = [
  {
    clave: 'ot_alta',
    grupo: 'Automáticos por WhatsApp',
    titulo: 'Alta de la orden (link de seguimiento)',
    descripcion: 'Sale al cargar una orden de trabajo, y al reenviar el seguimiento.',
    canal: 'whatsapp',
    variables: [
      V('cliente', 'Nombre del cliente'),
      V('orden', 'Número de la orden'),
      V('vehiculo', 'Marca, modelo y patente'),
      V('componente', 'Trabajo a realizar'),
      V('mensaje_estado', 'El texto del estado en que está la orden (se edita abajo)'),
      V('link', 'Link para seguir la orden'),
    ],
  },
  {
    clave: 'ot_estado',
    grupo: 'Automáticos por WhatsApp',
    titulo: 'Cambio de estado de la orden',
    descripcion: 'Sale cuando la orden pasa a un estado marcado "avisa al cliente".',
    canal: 'whatsapp',
    variables: [
      V('cliente', 'Nombre del cliente'),
      V('orden', 'Número de la orden'),
      V('vehiculo', 'Marca, modelo y patente'),
      V('componente', 'Trabajo a realizar'),
      V('mensaje_estado', 'El texto del estado nuevo (se edita abajo)'),
      V('link', 'Link para seguir la orden'),
    ],
  },
  {
    clave: 'ot_cambio_precio',
    grupo: 'Automáticos por WhatsApp',
    titulo: 'Cambio de precio de la orden',
    descripcion: 'Sale al pedirle al cliente que autorice un monto distinto del presupuesto.',
    canal: 'whatsapp',
    variables: [
      V('cliente', 'Nombre del cliente'),
      V('orden', 'Número de la orden'),
      V('presupuesto_original', 'Monto presupuestado'),
      V('nuevo_monto', 'Monto nuevo'),
      V('link', 'Link para autorizar'),
    ],
  },
  {
    clave: 'cotizacion_autorizar',
    grupo: 'Automáticos por WhatsApp',
    titulo: 'Presupuesto para autorizar',
    descripcion: 'Sale con "Enviar para autorizar" desde la cotización o al cotizar la orden.',
    canal: 'whatsapp',
    variables: [
      V('cliente', 'Nombre del cliente'),
      V('numero', 'Número del presupuesto'),
      V('componente', 'Trabajo a realizar'),
      V('total', 'Total con IVA'),
      V('vencimiento', 'Válido hasta'),
      V('link', 'Link para verlo y aceptarlo o rechazarlo'),
    ],
  },
  {
    clave: 'retencion_pendiente',
    grupo: 'Automáticos por WhatsApp',
    titulo: 'Reclamo de retención pendiente',
    descripcion: 'Sale al reclamarle a un cliente el comprobante de una retención.',
    canal: 'whatsapp',
    variables: [
      V('cliente', 'Nombre del cliente'),
      V('numero', 'Número del recibo'),
      V('fecha', 'Fecha del recibo'),
      V('impuesto', 'Impuesto retenido'),
      V('importe', 'Importe retenido'),
    ],
  },
  ...(
    [
      ['factura', 'Factura', [V('tipo', 'Tipo de comprobante ("Factura B")'), ...DEL_COMPROBANTE]],
      ['recibo', 'Recibo', DEL_COMPROBANTE],
      ['nota_credito', 'Nota de crédito', DEL_COMPROBANTE],
      ['remito', 'Remito', DEL_COMPROBANTE.slice(0, 2)],
      ['presupuesto', 'Presupuesto', DEL_COMPROBANTE],
      ['orden_pago', 'Orden de pago', DEL_COMPROBANTE],
    ] as [string, string, VariablePlantilla[]][]
  ).flatMap(([base, nombre, variables]) => [
    {
      clave: `${base}_mail`,
      grupo: 'Envío de comprobantes' as const,
      titulo: `${nombre} por mail`,
      descripcion: 'Asunto y texto del mail; el comprobante va adjunto en PDF.',
      canal: 'mail' as const,
      variables,
    },
    {
      clave: `${base}_whatsapp`,
      grupo: 'Envío de comprobantes' as const,
      titulo: `${nombre} por WhatsApp`,
      descripcion: 'Texto que acompaña al PDF.',
      canal: 'whatsapp' as const,
      variables,
    },
  ]),
];

export interface Plantilla {
  clave: string;
  asunto: string | null;
  cuerpo: string;
  asuntoOriginal: string | null;
  cuerpoOriginal: string;
}

export async function fetchPlantillas(): Promise<Map<string, Plantilla>> {
  const { data, error } = await supabase
    .from('plantillas_mensaje')
    .select('clave, asunto, cuerpo, asunto_original, cuerpo_original');
  if (error) throw error;
  return new Map(
    ((data ?? []) as any[]).map((r) => [
      r.clave,
      {
        clave: r.clave,
        asunto: r.asunto,
        cuerpo: r.cuerpo,
        asuntoOriginal: r.asunto_original,
        cuerpoOriginal: r.cuerpo_original,
      },
    ])
  );
}

export async function guardarPlantilla(clave: string, asunto: string | null, cuerpo: string): Promise<void> {
  const { error } = await supabase
    .from('plantillas_mensaje')
    .update({ asunto, cuerpo, updated_at: new Date().toISOString() })
    .eq('clave', clave);
  if (error) throw error;
}

/** Las variables que usa un texto, para avisar si alguna no existe. */
export function variablesUsadas(texto: string): string[] {
  return [...texto.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
}

/**
 * Reemplaza las variables y omite las líneas con alguna variable sin valor.
 * Es la misma regla que aplicar_plantilla() en la base.
 */
export function aplicarPlantilla(texto: string, vars: Record<string, string | number | null | undefined>): string {
  const lineas = texto.replace(/\r/g, '').split('\n').flatMap((linea) => {
    let vacia = false;
    const armada = linea.replace(/\{([a-z_]+)\}/g, (_, nombre: string) => {
      const valor = vars[nombre];
      if (valor === null || valor === undefined || String(valor).trim() === '') {
        vacia = true;
        return '';
      }
      return String(valor);
    });
    return vacia ? [] : [armada];
  });
  return lineas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

let cache: Promise<Map<string, Plantilla>> | null = null;

/** Para que Configuración, al guardar, haga que las pantallas lean lo nuevo. */
export function olvidarPlantillas(): void {
  cache = null;
}

/**
 * Arma el asunto y el texto con que se manda un comprobante. Si todavía no
 * cargaron las plantillas (o no se pudieron leer), devuelve null y la
 * pantalla usa su texto de siempre.
 */
export function usePlantillasDeEnvio() {
  const [plantillas, setPlantillas] = React.useState<Map<string, Plantilla> | null>(null);

  React.useEffect(() => {
    let vigente = true;
    cache ??= fetchPlantillas();
    cache.then((p) => vigente && setPlantillas(p)).catch(() => { cache = null; });
    return () => { vigente = false; };
  }, []);

  return React.useCallback(
    (
      base: 'factura' | 'recibo' | 'nota_credito' | 'remito' | 'presupuesto' | 'orden_pago',
      canal: 'email' | 'whatsapp',
      vars: Record<string, string | number | null | undefined>
    ): { asunto: string; texto: string } | null => {
      const mail = plantillas?.get(`${base}_mail`);
      const cuerpo = plantillas?.get(canal === 'email' ? `${base}_mail` : `${base}_whatsapp`);
      if (!mail || !cuerpo) return null;
      const asunto = (mail.asunto ?? '').trim() || mail.asuntoOriginal || '';
      const texto = cuerpo.cuerpo.trim() || cuerpo.cuerpoOriginal;
      return { asunto: aplicarPlantilla(asunto, vars), texto: aplicarPlantilla(texto, vars) };
    },
    [plantillas]
  );
}

// ---------------------------------------------------------------------------
// Texto por estado de la orden (notification_templates)
// ---------------------------------------------------------------------------

export async function fetchMensajesDeEstado(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('notification_templates').select('status_id, body');
  if (error) throw error;
  return new Map(((data ?? []) as any[]).map((r) => [r.status_id, r.body ?? '']));
}

export async function guardarMensajeDeEstado(statusId: string, body: string): Promise<void> {
  const { error } = await supabase
    .from('notification_templates')
    .upsert({ status_id: statusId, body }, { onConflict: 'status_id' });
  if (error) throw error;
}
