// Arranque: une adaptadores reales con el orquestador. Store en memoria hasta conectar Postgres.

import { randomUUID } from 'node:crypto';
import { ClaudeFiscalReader } from './adapters/ai/claudeReader.js';
import { CsfFirstReader } from './adapters/csf/csfFirstReader.js';
import { FacturapiClient } from './adapters/facturapi/client.js';
import { FacturapiError } from './adapters/facturapi/errors.js';
import { MemoryStore } from './adapters/memory/store.js';
import { WhatsAppCloudClient, WhatsAppApiError } from './adapters/whatsapp/client.js';
import { Analytics, ConsoleSink } from './analytics/events.js';
import { loadConfig, loadDotEnv } from './config.js';
import { buildApp } from './http/app.js';
import { RetryQueue } from './http/queue.js';
import { Orchestrator } from './orchestrator/orchestrator.js';

loadDotEnv();
const cfg = loadConfig();
const store = new MemoryStore();

// Negocio de demostración: permite probar el flujo completo con un número de prueba de Meta.
if (cfg.DEMO_WA_PHONE_NUMBER_ID && cfg.DEMO_BUSINESS_RFC && cfg.DEMO_FACTURAPI_KEY) {
  store.businesses.set('neg_demo', {
    id: 'neg_demo',
    name: cfg.DEMO_BUSINESS_NAME,
    rfc: cfg.DEMO_BUSINESS_RFC,
    taxSystem: cfg.DEMO_BUSINESS_TAX_SYSTEM,
    waPhoneNumberId: cfg.DEMO_WA_PHONE_NUMBER_ID,
    operatorPhones: cfg.DEMO_OPERATOR_PHONE ? [cfg.DEMO_OPERATOR_PHONE] : [],
    facturapiKeyRef: 'DEMO_FACTURAPI_KEY',
    rule: { version: 1, mode: 'automatico', maxAmount: 2000, maxTicketAgeDays: 3 },
    product: {
      description: 'Consumo de alimentos y bebidas',
      productKey: '90101501',
      unitKey: 'E48',
      unitName: 'Unidad de servicio',
      kind: 'bienes',
    },
    privacyNoticeUrl: 'https://conta.example/privacidad',
    timezone: 'America/Mexico_City',
    active: true,
  });
  if (cfg.DEMO_OPERATOR_PHONE) {
    store.operatorList.push({ id: 'op_demo', businessId: 'neg_demo', name: 'Caja', phone: cfg.DEMO_OPERATOR_PHONE });
  }
}

const tokens = new Map<string, string>([[cfg.WA_CONTA_OP_PHONE_NUMBER_ID, cfg.WA_CONTA_OP_TOKEN]]);
if (cfg.DEMO_WA_PHONE_NUMBER_ID && cfg.DEMO_WA_TOKEN) tokens.set(cfg.DEMO_WA_PHONE_NUMBER_ID, cfg.DEMO_WA_TOKEN);

const wa = new WhatsAppCloudClient({
  graphVersion: cfg.WA_GRAPH_VERSION,
  mediaToken: cfg.WA_CONTA_OP_TOKEN,
  async tokenFor(phoneNumberId) {
    const token = tokens.get(phoneNumberId);
    if (!token) throw new Error(`Sin token para el número ${phoneNumberId}`);
    return token;
  },
});

const queue = new RetryQueue({
  maxAttempts: 4,
  baseDelayMs: 2000,
  isRetryable: (err) =>
    (err instanceof FacturapiError && err.isRetryable) ||
    (err instanceof WhatsAppApiError && (err.status >= 500 || err.status === 429)),
  onFailure: (err, label) => console.error('job_failed', label, err),
});

const orchestrator = new Orchestrator(
  {
    contaOpPhoneNumberId: cfg.WA_CONTA_OP_PHONE_NUMBER_ID,
    fiscalDataFlowId: cfg.WA_FLOW_DATOS_ID,
    fixFieldFlowId: cfg.WA_FLOW_CAMPO_ID,
    invoiceReadyTemplate: cfg.WA_TEMPLATE_FACTURA,
    receptorSalt: cfg.RECEPTOR_SALT,
    minReadConfidence: cfg.MIN_READ_CONFIDENCE,
    botPauseMs: cfg.BOT_PAUSE_MINUTES * 60_000,
    defaultPaymentForm: cfg.DEFAULT_PAYMENT_FORM,
    stampMaxRetries: 5,
    stampRetryDelayMs: 10 * 60_000,
  },
  store,
  wa,
  new FacturapiClient({ baseUrl: cfg.FACTURAPI_BASE_URL }),
  new CsfFirstReader(new ClaudeFiscalReader(), undefined, (code) => console.warn('csf_lector_respaldo_ia', code)),
  {
    // Bóveda: en desarrollo, la referencia es el nombre de una variable de entorno.
    async facturapiKey(ref) {
      const key = process.env[ref];
      if (!key) throw new Error(`Llave de Facturapi no encontrada: ${ref}`);
      return key;
    },
  },
  new Analytics(new ConsoleSink(), cfg.AMBIENTE),
  { now: () => new Date() },
  { next: (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}` },
  queue,
);

const app = buildApp({
  orchestrator,
  queue,
  waAppSecret: cfg.WA_APP_SECRET,
  waVerifyToken: cfg.WA_VERIFY_TOKEN,
  facturapiWebhookSecret: cfg.FACTURAPI_WEBHOOK_SECRET,
});

await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
