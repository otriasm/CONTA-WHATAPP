// Entrada HTTP: webhooks de WhatsApp y Facturapi. Responde 200 rápido y procesa en la cola.

import Fastify, { type FastifyInstance } from 'fastify';
import { verifyFacturapiSignature } from '../adapters/facturapi/client.js';
import { parseWebhook, verifyMetaSignature, type AccountUpdate } from '../adapters/whatsapp/webhook.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { RetryQueue } from './queue.js';

export interface AppDeps {
  orchestrator: Orchestrator;
  queue: RetryQueue;
  waAppSecret: string;
  waVerifyToken: string;
  facturapiWebhookSecret: string;
  onAccountUpdate?(update: AccountUpdate): Promise<void>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

  // Guardamos el cuerpo crudo: las firmas se calculan sobre los bytes exactos.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.get('/health', async () => ({ ok: true, pendientes: deps.queue.size }));

  // Verificación de la suscripción (Meta manda hub.challenge una vez).
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === deps.waVerifyToken) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    const raw = req.body as Buffer;
    if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, deps.waAppSecret)) {
      return reply.code(401).send();
    }
    const { messages, accountUpdates } = parseWebhook(JSON.parse(raw.toString('utf8')));
    for (const msg of messages) {
      if (!(await deps.orchestrator.accept(msg))) continue; // repetido
      deps.queue.enqueue(`wa:${msg.kind}:${msg.id}`, () => deps.orchestrator.process(msg));
    }
    for (const update of accountUpdates) {
      req.log.warn({ wabaId: update.wabaId, event: update.event }, 'account_update');
      if (deps.onAccountUpdate) deps.queue.enqueue(`wa:account:${update.wabaId}`, () => deps.onAccountUpdate!(update));
    }
    return reply.code(200).send();
  });

  app.post('/webhooks/facturapi', async (req, reply) => {
    const raw = req.body as Buffer;
    const signature = req.headers['facturapi-signature'] as string | undefined;
    if (!verifyFacturapiSignature(raw, signature, deps.facturapiWebhookSecret)) {
      return reply.code(401).send();
    }
    const event = JSON.parse(raw.toString('utf8')) as {
      type?: string;
      data?: { object?: { id: string; status: string; uuid?: string; total: number; external_id?: string } };
    };
    const invoice = event.data?.object;
    if (event.type === 'invoice.status_updated' && invoice?.external_id) {
      deps.queue.enqueue(`facturapi:${invoice.id}:${invoice.status}`, () =>
        deps.orchestrator.handleInvoiceStatus({
          requestId: invoice.external_id!,
          facturapiId: invoice.id,
          status: invoice.status,
          uuid: invoice.uuid,
          total: invoice.total,
        }),
      );
    }
    return reply.code(200).send();
  });

  return app;
}
