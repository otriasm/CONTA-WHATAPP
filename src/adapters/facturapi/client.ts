// Cliente de Facturapi API v2. Cada emisor usa la Live Key de su organización.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FiscalData } from '../../domain/types.js';
import type {
  CreateInvoiceInput,
  FacturapiPort,
  SatValidationError,
  StampedInvoice,
} from '../../ports.js';
import { FacturapiError } from './errors.js';

export interface FacturapiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class FacturapiClient implements FacturapiPort {
  private readonly base: string;
  private readonly http: typeof fetch;

  constructor(opts: FacturapiClientOptions = {}) {
    this.base = opts.baseUrl ?? 'https://www.facturapi.io/v2';
    this.http = opts.fetch ?? fetch;
  }

  async upsertCustomer(apiKey: string, fiscal: FiscalData, existingId?: string): Promise<{ id: string }> {
    const body = {
      legal_name: fiscal.legalName,
      tax_id: fiscal.rfc,
      tax_system: fiscal.taxSystem,
      address: { zip: fiscal.zip },
    };
    const res = existingId
      ? await this.request<{ id: string }>(apiKey, 'PUT', `/customers/${existingId}`, body)
      : await this.request<{ id: string }>(apiKey, 'POST', '/customers', body);
    return { id: res.id };
  }

  async validateCustomer(
    apiKey: string,
    customerId: string,
  ): Promise<{ isValid: boolean; errors: SatValidationError[] }> {
    const res = await this.request<{ is_valid: boolean; errors?: SatValidationError[] }>(
      apiKey,
      'GET',
      `/customers/${customerId}/tax-info-validation`,
    );
    return { isValid: res.is_valid, errors: res.is_valid ? [] : (res.errors ?? []) };
  }

  async createInvoice(apiKey: string, input: CreateInvoiceInput, idempotencyKey: string): Promise<StampedInvoice> {
    const res = await this.request<{ id: string; uuid?: string; status: StampedInvoice['status']; total: number }>(
      apiKey,
      'POST',
      '/invoices',
      {
        customer: input.customerId,
        items: input.items,
        use: input.use,
        payment_form: input.paymentForm,
        folio_number: input.folioNumber,
        external_id: input.externalId,
        idempotency_key: idempotencyKey,
      },
    );
    return { id: res.id, uuid: res.uuid, status: res.status, total: res.total };
  }

  downloadPdf(apiKey: string, invoiceId: string): Promise<Buffer> {
    return this.binary(apiKey, `/invoices/${invoiceId}/pdf`);
  }

  downloadXml(apiKey: string, invoiceId: string): Promise<Buffer> {
    return this.binary(apiKey, `/invoices/${invoiceId}/xml`);
  }

  async sendByEmail(apiKey: string, invoiceId: string, email: string): Promise<void> {
    await this.request(apiKey, 'POST', `/invoices/${invoiceId}/email`, { email });
  }

  private async request<T>(apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.http(this.base + path, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new FacturapiError(`Facturapi no responde: ${(err as Error).message}`, 0);
    }
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  private async binary(apiKey: string, path: string): Promise<Buffer> {
    const res = await this.http(this.base + path, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw await toError(res);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function toError(res: Response): Promise<FacturapiError> {
  const text = await res.text().catch(() => '');
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return new FacturapiError(
    body.message || text || res.statusText,
    res.status,
    body.code,
    body.path,
    Array.isArray(body.errors) ? body.errors : [],
    res.headers.get('x-facturapi-log-id') ?? undefined,
  );
}

/** Valida la firma de los webhooks de Facturapi: HMAC-SHA256 en hex del cuerpo crudo. */
export function verifyFacturapiSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
