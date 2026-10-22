import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacturapiClient } from '../src/adapters/facturapi/client.js';
import { FacturapiError } from '../src/adapters/facturapi/errors.js';

type Call = { url: string; method: string; auth: string | null; body: any };

function stubFetch(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      auth: headers.get('authorization'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Adaptador de Facturapi (SDK oficial)', () => {
  const input = {
    customerId: 'cus_1',
    use: 'G03',
    paymentForm: '04',
    externalId: 'sol_1',
    items: [
      {
        quantity: 1,
        product: {
          description: 'Consumo',
          product_key: '90101501',
          unit_key: 'E48',
          unit_name: 'Unidad de servicio',
          price: 350,
          tax_included: true,
          taxes: [{ type: 'IVA', rate: 0.16 }],
        },
      },
    ],
  };

  it('timbra con la llave del emisor y manda la idempotency_key en el cuerpo', async () => {
    const calls = stubFetch(() => json({ id: 'inv_1', uuid: 'UUID-1', status: 'valid', total: 350 }));
    const client = new FacturapiClient();
    const invoice = await client.createInvoice('sk_test_emisor', input, 'sol_1-0');

    expect(invoice).toEqual({ id: 'inv_1', uuid: 'UUID-1', status: 'valid', total: 350 });
    expect(calls[0]).toMatchObject({
      url: 'https://www.facturapi.io/v2/invoices',
      method: 'POST',
      auth: 'Bearer sk_test_emisor',
      body: { customer: 'cus_1', use: 'G03', payment_form: '04', external_id: 'sol_1', idempotency_key: 'sol_1-0' },
    });
  });

  it('traduce el rechazo del SAT al error que entiende el orquestador (ER27)', async () => {
    stubFetch(() =>
      json(
        {
          message: 'El uso de CFDI no corresponde al régimen',
          code: 'invoice_stamping_validation_error',
          errors: [{ path: 'use', message: 'CFDI40161', source: 'sat' }],
        },
        400,
      ),
    );
    const err = await new FacturapiClient().createInvoice('sk_test', input, 'k').catch((e) => e);
    expect(err).toBeInstanceOf(FacturapiError);
    expect(err).toMatchObject({ status: 400, isStampingValidation: true, failingPath: 'use' });
  });

  it('marca como reintentable una caída de Facturapi (ER36)', async () => {
    stubFetch(() => json({ message: 'unavailable' }, 503));
    const err = await new FacturapiClient().createInvoice('sk_test', input, 'k').catch((e) => e);
    expect(err).toBeInstanceOf(FacturapiError);
    expect(err.isRetryable).toBe(true);
  });

  it('crea el cliente y lo valida contra el SAT', async () => {
    const calls = stubFetch((call) =>
      call.url.endsWith('/tax-info-validation')
        ? json({ is_valid: false, errors: [{ path: 'legal_name', message: 'No coincide' }] })
        : json({ id: 'cus_9' }),
    );
    const client = new FacturapiClient();
    const { id } = await client.upsertCustomer('sk_test', {
      rfc: 'PEGJ800101AB1',
      legalName: 'JUAN PEREZ GOMEZ',
      zip: '06700',
      taxSystem: '612',
    });
    const validation = await client.validateCustomer('sk_test', id);

    expect(calls[0]).toMatchObject({
      url: 'https://www.facturapi.io/v2/customers',
      body: { tax_id: 'PEGJ800101AB1', tax_system: '612', address: { zip: '06700' } },
    });
    expect(validation).toEqual({ isValid: false, errors: [{ path: 'legal_name', message: 'No coincide' }] });
  });

  it('descarga el PDF como Buffer', async () => {
    stubFetch(() => new Response('%PDF-fake', { headers: { 'content-type': 'application/pdf' } }));
    const pdf = await new FacturapiClient().downloadPdf('sk_test', 'inv_1');
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.toString()).toBe('%PDF-fake');
  });
});
