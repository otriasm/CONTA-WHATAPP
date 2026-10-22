// Reglas de emisión (A4, ER20–ER22): ¿se timbra solo o pasa al operador?

import type { EmissionRule, InvoiceRequest, TicketData } from './types.js';

export type EmissionDecision =
  | { action: 'timbrar' }
  | { action: 'aprobar'; reason: NonNullable<InvoiceRequest['approvalReason']> };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Días completos entre la fecha del ticket y hoy, en la zona del negocio. */
export function ticketAgeDays(ticketDate: string, now: Date, timezone: string): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  const diff = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ticketDate}T00:00:00Z`);
  return Math.floor(diff / MS_PER_DAY);
}

export function decideEmission(params: {
  rule: EmissionRule;
  ticket: TicketData;
  now: Date;
  timezone: string;
  folioAlreadyInvoiced: boolean;
  csdExpired?: boolean;
}): EmissionDecision {
  const { rule, ticket } = params;
  if (params.folioAlreadyInvoiced) return { action: 'aprobar', reason: 'folio_repetido' };
  if (params.csdExpired) return { action: 'aprobar', reason: 'csd_vencido' };
  if (ticket.manual) return { action: 'aprobar', reason: 'captura_manual' };
  if (rule.mode === 'aprobacion') return { action: 'aprobar', reason: 'modo' };
  if (ticketAgeDays(ticket.date, params.now, params.timezone) > rule.maxTicketAgeDays) {
    return { action: 'aprobar', reason: 'antiguedad' };
  }
  if (ticket.total > rule.maxAmount) return { action: 'aprobar', reason: 'monto' };
  return { action: 'timbrar' };
}
