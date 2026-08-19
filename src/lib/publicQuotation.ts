import { supabase } from '@/src/lib/supabase';
import type { QuotationStatus } from '@/src/lib/quotations';

/**
 * Vista pública de una cotización, para el link que recibe el cliente.
 *
 * A diferencia del portal de seguimiento de la orden, acá sí se muestran los
 * importes: el cliente tiene que ver qué está aprobando. Lo que no sale nunca
 * es su CUIT ni el precio de compra.
 */
export interface PublicQuotation {
  number: string;
  status: QuotationStatus;
  component: string | null;
  notes: string | null;
  validUntil: string | null;
  createdAt: string;
  customerName: string | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  licensePlate: string | null;
  alreadyConverted: boolean;
}

export interface PublicQuotationItem {
  code: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** Resultado de la decisión del cliente, tal como lo resuelve la base. */
export type DecisionResult =
  | 'ACEPTADA'
  | 'RECHAZADA'
  | 'NO_EXISTE'
  | 'YA_RESUELTA'
  | 'YA_CONVERTIDA'
  | 'VENCIDA';

export const DECISION_MESSAGES: Record<DecisionResult, string> = {
  ACEPTADA: 'Presupuesto aceptado. El taller ya fue avisado y va a comenzar el trabajo.',
  RECHAZADA: 'Presupuesto rechazado. Si querés, podés comunicarte con el taller.',
  NO_EXISTE: 'Este link no corresponde a ningún presupuesto.',
  YA_RESUELTA: 'Este presupuesto ya fue respondido. Si necesitás cambiarlo, comunicate con el taller.',
  YA_CONVERTIDA: 'El trabajo de este presupuesto ya está en marcha.',
  VENCIDA: 'Este presupuesto venció. Pedile uno nuevo al taller.',
};

export async function fetchPublicQuotation(token: string): Promise<PublicQuotation | null> {
  const { data, error } = await supabase.rpc('get_public_quotation', { p_token: token });
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as any;
  if (!row) return null;

  return {
    number: row.number,
    status: row.status,
    component: row.component,
    notes: row.notes,
    validUntil: row.valid_until,
    createdAt: row.created_at,
    customerName: row.customer_name,
    vehicleBrand: row.vehicle_brand,
    vehicleModel: row.vehicle_model,
    licensePlate: row.license_plate,
    alreadyConverted: row.already_converted,
  };
}

export async function fetchPublicQuotationItems(token: string): Promise<PublicQuotationItem[]> {
  const { data, error } = await supabase.rpc('get_public_quotation_items', { p_token: token });
  if (error) throw error;

  return ((data ?? []) as any[]).map((r) => ({
    code: r.code,
    description: r.description,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price),
    subtotal: Number(r.subtotal),
  }));
}

/**
 * Decisión del cliente. Todas las validaciones viven en la base: que esté
 * vigente, que no se haya respondido antes y que no tenga ya una orden en
 * marcha. Acá solo se traduce el resultado.
 */
export async function decideQuotation(token: string, accept: boolean): Promise<DecisionResult> {
  const { data, error } = await supabase.rpc('decide_quotation', {
    p_token: token,
    p_accept: accept,
  });
  if (error) throw error;
  return data as DecisionResult;
}

/** Link del presupuesto para mandarle al cliente. */
export function quotationLink(publicToken: string): string {
  return `${window.location.origin}/presupuesto/${publicToken}`;
}
