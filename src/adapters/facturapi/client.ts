// Adaptador de Facturapi sobre su SDK oficial de Node (`facturapi`). Cada emisor usa la Live Key de su organización.

import { createHmac, timingSafeEqual } from 'node:crypto';
import facturapiPkg, { FacturapiError as SdkError } from 'facturapi';
import type { FiscalData } from '../../domain/types.js';
import type {
  CreateInvoiceInput,
  FacturapiPort,
  SatValidationError,
  StampedInvoice,
} from '../../ports.js';
import { FacturapiError } from './errors.js';

// El SDK se publica como CommonJS con __esModule: desde ESM de Node la clase queda en `.default`,
// mientras que los bundlers (Vitest) ya la entregan como import por defecto. Aceptamos ambos.
type FacturapiCtor = typeof facturapiPkg.default;
type Facturapi = InstanceType<FacturapiCtor>;
const Facturapi: FacturapiCtor =
  (facturapiPkg as unknown as { default?: FacturapiCtor }).default ?? (facturapiPkg as unknown as FacturapiCtor);

export interface FacturapiClientOptions {
  /** Solo para pruebas o un proxy; por defecto, la URL del SDK (https://www.facturapi.io/v2). */
  baseUrl?: string;
}

export class FacturapiClient implements FacturapiPort {
  /** Un cliente del SDK por llave: cada emisor es una organización distinta. */
  private readonly clients = new Map<string, Facturapi>();

  constructor(private readonly opts: FacturapiClientOptions = {}) {}

  upsertCustomer(apiKey: string, fiscal: FiscalData, existingId?: string): Promise<{ id: string }> {
    const body = {
      legal_name: fiscal.legalName,
      tax_id: fiscal.rfc,
      tax_system: fiscal.taxSystem,
      address: { zip: fiscal.zip },
    };
    return this.call(async (sdk) => {
      const customer = existingId ? await sdk.customers.update(existingId, body) : await sdk.customers.create(body);
      return { id: customer.id };
    }, apiKey);
  }

  validateCustomer(apiKey: string, customerId: string): Promise<{ isValid: boolean; errors: SatValidationError[] }> {
    return this.call(async (sdk) => {
      const res = await sdk.customers.validateTaxInfo(customerId);
      return { isValid: res.is_valid, errors: res.is_valid ? [] : res.errors };
    }, apiKey);
  }

  createInvoice(apiKey: string, input: CreateInvoiceInput, idempotencyKey: string): Promise<StampedInvoice> {
    return this.call(async (sdk) => {
      const invoice = await sdk.invoices.create({
        customer: input.customerId,
        items: input.items,
        use: input.use,
        payment_form: input.paymentForm,
        folio_number: input.folioNumber,
        external_id: input.externalId,
        idempotency_key: idempotencyKey,
      });
      return {
        id: invoice.id,
        uuid: invoice.uuid || undefined,
        status: invoice.status as StampedInvoice['status'],
        total: invoice.total,
      };
    }, apiKey);
  }

  downloadPdf(apiKey: string, invoiceId: string): Promise<Buffer> {
    return this.call(async (sdk) => toBuffer(await sdk.invoices.downloadPdf(invoiceId)), apiKey);
  }

  downloadXml(apiKey: string, invoiceId: string): Promise<Buffer> {
    return this.call(async (sdk) => toBuffer(await sdk.invoices.downloadXml(invoiceId)), apiKey);
  }

  async sendByEmail(apiKey: string, invoiceId: string, email: string): Promise<void> {
    await this.call((sdk) => sdk.invoices.sendByEmail(invoiceId, { email }), apiKey);
  }

  private sdk(apiKey: string): Facturapi {
    let client = this.clients.get(apiKey);
    if (!client) {
      client = new Facturapi(apiKey);
      if (this.opts.baseUrl) client.BASE_URL = this.opts.baseUrl;
      this.clients.set(apiKey, client);
    }
    return client;
  }

  /** Traduce los errores del SDK al FacturapiError de Conta, que es el que entiende el orquestador. */
  private async call<T>(fn: (sdk: Facturapi) => Promise<T>, apiKey: string): Promise<T> {
    try {
      return await fn(this.sdk(apiKey));
    } catch (err) {
      if (err instanceof SdkError) {
        throw new FacturapiError(
          err.message,
          err.status ?? 0,
          err.code,
          err.path,
          (err.errors ?? []).map((e) => ({ ...e, message: e.message ?? '' })),
          err.logId,
        );
      }
      if (err instanceof TypeError && err.message === 'fetch failed') {
        // fetch de Node rechaza con TypeError('fetch failed') cuando no hay red: falla temporal (ER36).
        throw new FacturapiError(`Facturapi no responde: ${err.message}`, 0);
      }
      throw err;
    }
  }
}

/** El SDK entrega un stream en Node y un Blob en otros entornos. */
async function toBuffer(download: unknown): Promise<Buffer> {
  if (download instanceof Blob) return Buffer.from(await download.arrayBuffer());
  if (download && typeof (download as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of download as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Descarga de Facturapi con un formato inesperado');
}

/** Valida la firma de los webhooks de Facturapi: HMAC-SHA256 en hex del cuerpo crudo (mismo algoritmo que el SDK). */
export function verifyFacturapiSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
