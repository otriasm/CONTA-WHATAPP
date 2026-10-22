// Intérprete y lector con Claude: entiende «quiero factura» y lee la CSF y los tickets.
// Nunca timbra ni inventa datos: si no está seguro, baja la confianza y el orquestador pregunta.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod';
import type { CsfReading, FiscalReader, Intent, TicketReading } from '../../ports.js';

const MODEL = 'claude-opus-5-5';

const IntentSchema = z.object({
  intent: z.enum(['pedir_factura', 'reenviar_factura', 'sin_csf', 'otro']),
});

const CsfSchema = z.object({
  rfc: z.string().nullable(),
  legal_name: z.string().nullable(),
  zip: z.string().nullable(),
  tax_system_code: z.string().nullable(),
  pages_read: z.number().int(),
  confidence: z.number(),
});

const TicketSchema = z.object({
  total: z.number().nullable(),
  date: z.string().nullable(),
  folio: z.string().nullable(),
  merchant_name: z.string().nullable(),
  matches_business: z.boolean(),
  confidence: z.number(),
});

const CSF_PROMPT = `Lee esta Constancia de Situación Fiscal (CSF) del SAT de México.
Extrae solo:
- rfc: el RFC tal como aparece.
- legal_name: nombre o razón social, en mayúsculas y sin régimen de capital (sin «SA DE CV»).
- zip: código postal del domicilio fiscal, 5 dígitos.
- tax_system_code: la clave de 3 dígitos del régimen vigente (por ejemplo 605, 612, 626). El régimen suele venir en la página 2; si esa página no está, devuelve null.
- pages_read: cuántas páginas de la constancia recibiste.
- confidence: de 0 a 1, qué tan seguro estás de los cuatro datos.
No extraigas CURP, domicilio completo ni idCIF. Si un dato no se ve, devuelve null; no lo adivines.`;

function ticketPrompt(businessName: string): string {
  return `Lee esta foto de un ticket de compra. El negocio que va a facturar es «${businessName}».
Extrae:
- total: el total pagado con impuestos, como número (sin signo de pesos).
- date: la fecha del ticket en formato YYYY-MM-DD.
- folio: el folio, número de ticket u orden.
- merchant_name: el nombre del negocio impreso en el ticket.
- matches_business: true si el ticket parece de «${businessName}»; false si es claramente de otro negocio.
- confidence: de 0 a 1, qué tan seguro estás del total.
Si no alcanzas a leer el total, devuelve null y una confianza baja. Nunca inventes un monto.`;
}

type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
const IMAGE_MIMES: ImageMime[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export class ClaudeFiscalReader implements FiscalReader {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async classifyIntent(text: string, businessName: string): Promise<Intent> {
    const quick = quickIntent(text);
    if (quick) return quick;

    const parsed = await this.parse(
      IntentSchema,
      'low',
      [
        {
          type: 'text',
          text:
            `Un cliente escribió esto al WhatsApp de «${businessName}». ` +
            'Clasifica su intención: pedir_factura (quiere factura de una compra), ' +
            'reenviar_factura (quiere que le reenvíen una factura ya emitida), ' +
            'sin_csf (dice que no tiene su constancia fiscal) u otro (cualquier otra cosa: pedidos, horarios, saludos).\n\n' +
            `Mensaje: «${text.slice(0, 1000)}»`,
        },
      ],
      256,
    );
    return parsed?.intent ?? 'otro';
  }

  async readCsf(pdf: Buffer): Promise<CsfReading> {
    const parsed = await this.parse(CsfSchema, 'medium', [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
      },
      { type: 'text', text: CSF_PROMPT },
    ]);
    if (!parsed) return { rfc: null, legalName: null, zip: null, taxSystem: null, pagesRead: 0, confidence: 0 };
    return {
      rfc: parsed.rfc,
      legalName: parsed.legal_name,
      zip: parsed.zip,
      taxSystem: parsed.tax_system_code,
      pagesRead: parsed.pages_read,
      confidence: clamp(parsed.confidence),
    };
  }

  async readTicket(image: Buffer, mimeType: string, businessName: string): Promise<TicketReading> {
    const mediaType = IMAGE_MIMES.find((m) => m === mimeType);
    if (!mediaType) {
      return { total: null, date: null, folio: null, merchantName: null, matchesBusiness: true, confidence: 0 };
    }
    const parsed = await this.parse(TicketSchema, 'medium', [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
      { type: 'text', text: ticketPrompt(businessName) },
    ]);
    if (!parsed) {
      return { total: null, date: null, folio: null, merchantName: null, matchesBusiness: true, confidence: 0 };
    }
    return {
      total: parsed.total,
      date: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null,
      folio: parsed.folio,
      merchantName: parsed.merchant_name,
      matchesBusiness: parsed.matches_business,
      confidence: clamp(parsed.confidence),
    };
  }

  private async parse<S extends z.ZodType>(
    schema: S,
    effort: 'low' | 'medium',
    content: Anthropic.Beta.BetaContentBlockParam[],
    maxTokens = 4096,
  ): Promise<z.infer<S> | null> {
    const response = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: betaZodOutputFormat(schema) },
      messages: [{ role: 'user', content }],
    });
    // Una negativa o un corte nunca se convierten en datos: el orquestador pide otra foto o captura a mano.
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
    return (response.parsed_output as z.infer<S> | null) ?? null;
  }
}

/** Atajos baratos antes de llamar al modelo. */
export function quickIntent(text: string): Intent | null {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (/\bno (la )?tengo\b|\bsin (mi )?constancia\b|\bno tengo (mi )?(csf|constancia)\b/.test(t)) return 'sin_csf';
  if (/\b(mi|la) factura\b/.test(t) && /\b(reenv|manda(me)?|otra vez|de nuevo|perdi)/.test(t)) return 'reenviar_factura';
  if (/^\s*mi factura\s*$/.test(t)) return 'reenviar_factura';
  if (/\bfactur/.test(t)) return 'pedir_factura';
  return null;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
