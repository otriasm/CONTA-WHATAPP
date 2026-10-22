import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyFacturapiSignature } from '../src/adapters/facturapi/client.js';
import { parseWebhook, verifyMetaSignature } from '../src/adapters/whatsapp/webhook.js';
import { buildApp } from '../src/http/app.js';
import { RetryQueue } from '../src/http/queue.js';
import { CLIENT, setup } from './fakes.js';

const APP_SECRET = 'meta-app-secret';
const FACTURAPI_SECRET = 'facturapi-secret';

function metaPayload(messages: unknown[], field = 'messages') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba_1',
        changes: [
          {
            field,
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'pn_negocio' },
              ...(field === 'smb_message_echoes' ? { message_echoes: messages } : { messages }),
            },
          },
        ],
      },
    ],
  };
}

const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('hex');

describe('Webhook de WhatsApp', () => {
  it('valida la firma X-Hub-Signature-256', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyMetaSignature(body, `sha256=${sign('{"a":1}', APP_SECRET)}`, APP_SECRET)).toBe(true);
    expect(verifyMetaSignature(body, `sha256=${sign('{"a":2}', APP_SECRET)}`, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(body, undefined, APP_SECRET)).toBe(false);
  });

  it('normaliza texto, documento, botón, Flow y ecos de la app', () => {
    const { messages } = parseWebhook(
      metaPayload([
        { id: 'w1', from: CLIENT, timestamp: '1792700000', type: 'text', text: { body: 'quiero factura' } },
        { id: 'w2', from: CLIENT, timestamp: '1792700001', type: 'document', document: { id: 'm1', mime_type: 'application/pdf', filename: 'csf.pdf' } },
        { id: 'w3', from: CLIENT, timestamp: '1792700002', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'datos_ok:sol_1', title: 'Sí' } } },
        {
          id: 'w4',
          from: CLIENT,
          timestamp: '1792700003',
          type: 'interactive',
          interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"flow_token":"datos:sol_1","rfc":"PEGJ800101AB1"}' } },
        },
      ]),
    );
    expect(messages.map((m) => m.kind)).toEqual(['text', 'media', 'button', 'flow']);
    expect(messages[1]).toMatchObject({ mediaId: 'm1', mimeType: 'application/pdf', toPhoneNumberId: 'pn_negocio' });
    expect(messages[3]).toMatchObject({ flowToken: 'datos:sol_1', response: { rfc: 'PEGJ800101AB1' } });

    const echoes = parseWebhook(metaPayload([{ id: 'e1', from: '5215500000000', to: CLIENT, timestamp: '1792700004' }], 'smb_message_echoes'));
    expect(echoes.messages[0]).toMatchObject({ kind: 'echo', to: CLIENT, id: 'echo:e1' });
  });
});

describe('Servidor HTTP', () => {
  function app() {
    const t = setup();
    const queue = new RetryQueue({ maxAttempts: 1, baseDelayMs: 1, isRetryable: () => false, onFailure: () => {} });
    const server = buildApp({
      orchestrator: t.orchestrator,
      queue,
      waAppSecret: APP_SECRET,
      waVerifyToken: 'verify-me',
      facturapiWebhookSecret: FACTURAPI_SECRET,
    });
    return { t, server, queue };
  }

  it('responde el challenge de Meta solo con el token correcto', async () => {
    const { server } = app();
    const ok = await server.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('42');
    const bad = await server.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42' });
    expect(bad.statusCode).toBe(403);
  });

  it('rechaza cuerpos sin firma válida y procesa los firmados', async () => {
    const { t, server, queue } = app();
    const body = JSON.stringify(
      metaPayload([{ id: 'w9', from: CLIENT, timestamp: '1792700000', type: 'text', text: { body: 'quiero factura' } }]),
    );
    const unsigned = await server.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(401);

    const signed = await server.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sign(body, APP_SECRET)}` },
    });
    expect(signed.statusCode).toBe(200);
    while (queue.size > 0) await new Promise((r) => setTimeout(r, 5));
    expect(t.wa.sent).toHaveLength(1);
  });

  it('valida la firma de Facturapi', () => {
    const body = '{"type":"invoice.status_updated"}';
    expect(verifyFacturapiSignature(Buffer.from(body), sign(body, FACTURAPI_SECRET), FACTURAPI_SECRET)).toBe(true);
    expect(verifyFacturapiSignature(Buffer.from(body), sign(body, 'otro'), FACTURAPI_SECRET)).toBe(false);
  });
});
