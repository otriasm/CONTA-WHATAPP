// Dobles de prueba para el orquestador. Datos ficticios: nunca usar una CSF real aquí.

import { FacturapiError } from '../src/adapters/facturapi/errors.js';
import { MemoryStore } from '../src/adapters/memory/store.js';
import { Analytics, MemorySink } from '../src/analytics/events.js';
import type { Business, FiscalData } from '../src/domain/types.js';
import type { Inbound } from '../src/orchestrator/inbound.js';
import { Orchestrator, type OrchestratorConfig } from '../src/orchestrator/orchestrator.js';
import type {
  Button,
  CreateInvoiceInput,
  CsfReading,
  FacturapiPort,
  FiscalReader,
  FlowMessage,
  Intent,
  OutgoingDocument,
  SatValidationError,
  Scheduler,
  StampedInvoice,
  TemplateMessage,
  TicketReading,
  WhatsAppSender,
} from '../src/ports.js';
import { quickIntent } from '../src/adapters/ai/claudeReader.js';

export const BUSINESS_NUMBER = 'pn_negocio';
export const CONTA_OP_NUMBER = 'pn_conta_op';
export const CLIENT = '5215511112222';
export const OPERATOR = '5215533334444';

export const FISCAL: FiscalData = {
  rfc: 'PEGJ800101AB1',
  legalName: 'JUAN PEREZ GOMEZ',
  zip: '06700',
  taxSystem: '612',
};

export type Sent =
  | { type: 'text'; from: string; to: string; text: string }
  | { type: 'buttons'; from: string; to: string; body: string; buttons: Button[] }
  | { type: 'document'; from: string; to: string; doc: OutgoingDocument }
  | { type: 'template'; from: string; to: string; template: TemplateMessage }
  | { type: 'flow'; from: string; to: string; flow: FlowMessage };

export class FakeWhatsApp implements WhatsAppSender {
  sent: Sent[] = [];
  media = new Map<string, { data: Buffer; mimeType: string }>();

  async sendText(from: string, to: string, text: string) {
    this.sent.push({ type: 'text', from, to, text });
  }
  async sendButtons(from: string, to: string, body: string, buttons: Button[]) {
    this.sent.push({ type: 'buttons', from, to, body, buttons });
  }
  async sendDocument(from: string, to: string, doc: OutgoingDocument) {
    this.sent.push({ type: 'document', from, to, doc });
  }
  async sendTemplate(from: string, to: string, template: TemplateMessage) {
    this.sent.push({ type: 'template', from, to, template });
  }
  async sendFlow(from: string, to: string, flow: FlowMessage) {
    this.sent.push({ type: 'flow', from, to, flow });
  }
  async downloadMedia(mediaId: string) {
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`media ${mediaId} no existe`);
    return m;
  }

  last(): Sent | undefined {
    return this.sent.at(-1);
  }
  to(phone: string): Sent[] {
    return this.sent.filter((s) => s.to === phone);
  }
  take(): Sent[] {
    const out = this.sent;
    this.sent = [];
    return out;
  }
}

export class FakeFacturapi implements FacturapiPort {
  customers = new Map<string, FiscalData>();
  validationErrors: SatValidationError[] = [];
  invoiceCalls: Array<{ input: CreateInvoiceInput; idempotencyKey: string }> = [];
  /** Respuestas en orden para createInvoice; la última se repite. */
  invoiceResults: Array<StampedInvoice | FacturapiError> = [
    { id: 'inv_1', uuid: 'UUID-0001', status: 'valid', total: 0 },
  ];

  async upsertCustomer(_key: string, fiscal: FiscalData, existingId?: string) {
    const id = existingId ?? `cus_${this.customers.size + 1}`;
    this.customers.set(id, fiscal);
    return { id };
  }
  async validateCustomer() {
    return { isValid: this.validationErrors.length === 0, errors: this.validationErrors };
  }
  async createInvoice(_key: string, input: CreateInvoiceInput, idempotencyKey: string) {
    this.invoiceCalls.push({ input, idempotencyKey });
    const idx = Math.min(this.invoiceCalls.length - 1, this.invoiceResults.length - 1);
    const result = this.invoiceResults[idx]!;
    if (result instanceof FacturapiError) throw result;
    return { ...result, total: result.total || input.items[0]!.product.price };
  }
  async downloadPdf() {
    return Buffer.from('%PDF-fake');
  }
  async downloadXml() {
    return Buffer.from('<cfdi:Comprobante/>');
  }
  async sendByEmail() {}
}

export class FakeReader implements FiscalReader {
  csf: CsfReading = {
    rfc: FISCAL.rfc,
    legalName: FISCAL.legalName,
    zip: FISCAL.zip,
    taxSystem: FISCAL.taxSystem,
    pagesRead: 2,
    confidence: 0.95,
  };
  ticket: TicketReading = {
    total: 350,
    date: '2026-10-22',
    folio: 'A-1001',
    merchantName: 'Café Ámbar',
    matchesBusiness: true,
    confidence: 0.92,
  };
  async classifyIntent(text: string): Promise<Intent> {
    return quickIntent(text) ?? 'otro';
  }
  async readCsf() {
    return this.csf;
  }
  async readTicket() {
    return this.ticket;
  }
}

export class FakeScheduler implements Scheduler {
  jobs: Array<{ label: string; delayMs: number; job: () => Promise<void> }> = [];
  schedule(label: string, delayMs: number, job: () => Promise<void>) {
    this.jobs.push({ label, delayMs, job });
  }
  async runAll() {
    const jobs = this.jobs;
    this.jobs = [];
    for (const j of jobs) await j.job();
  }
}

export function demoBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'neg_1',
    name: 'Café Ámbar',
    rfc: 'CAM190314K82',
    taxSystem: '601',
    waPhoneNumberId: BUSINESS_NUMBER,
    operatorPhones: [OPERATOR],
    facturapiKeyRef: 'key_ref',
    rule: { version: 3, mode: 'automatico', maxAmount: 2000, maxTicketAgeDays: 3 },
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
    ...overrides,
  };
}

export const CONFIG: OrchestratorConfig = {
  contaOpPhoneNumberId: CONTA_OP_NUMBER,
  fiscalDataFlowId: 'flow_datos',
  fixFieldFlowId: 'flow_campo',
  invoiceReadyTemplate: 'tu_factura_lista',
  receptorSalt: 'sal-de-prueba-123456',
  minReadConfidence: 0.7,
  botPauseMs: 2 * 60 * 60 * 1000,
  defaultPaymentForm: '04',
  stampMaxRetries: 5,
  stampRetryDelayMs: 10 * 60 * 1000,
};

export function setup(businessOverrides: Partial<Business> = {}) {
  const store = new MemoryStore();
  const business = demoBusiness(businessOverrides);
  store.businesses.set(business.id, business);
  store.operatorList.push({ id: 'op_ana', businessId: business.id, name: 'Ana', phone: OPERATOR });

  const wa = new FakeWhatsApp();
  const facturapi = new FakeFacturapi();
  const reader = new FakeReader();
  const sink = new MemorySink();
  const scheduler = new FakeScheduler();
  const clock = { current: new Date('2026-10-22T18:00:00Z'), now() { return this.current; } };
  let seq = 0;
  let msgSeq = 0;

  const orchestrator = new Orchestrator(
    CONFIG,
    store,
    wa,
    facturapi,
    reader,
    { facturapiKey: async () => 'sk_test_fake' },
    new Analytics(sink, 'test'),
    clock,
    { next: (prefix) => `${prefix}_${++seq}` },
    scheduler,
  );

  const base = () => ({ id: `wamid.${++msgSeq}`, at: clock.now() });
  const client = {
    text: (text: string, from = CLIENT) =>
      orchestrator.handle({ ...base(), kind: 'text', from, toPhoneNumberId: BUSINESS_NUMBER, text }),
    file: (mimeType: string, mediaType: 'document' | 'image' = 'document', from = CLIENT) => {
      const mediaId = `media_${msgSeq + 1}`;
      wa.media.set(mediaId, { data: Buffer.from('archivo'), mimeType });
      return orchestrator.handle({
        ...base(),
        kind: 'media',
        from,
        toPhoneNumberId: BUSINESS_NUMBER,
        mediaType,
        mediaId,
        mimeType,
      });
    },
    button: (payload: string, from = CLIENT) =>
      orchestrator.handle({ ...base(), kind: 'button', from, toPhoneNumberId: BUSINESS_NUMBER, payload }),
    flow: (flowToken: string, response: Record<string, unknown>, from = CLIENT) =>
      orchestrator.handle({
        ...base(),
        kind: 'flow',
        from,
        toPhoneNumberId: BUSINESS_NUMBER,
        flowToken,
        response: { flow_token: flowToken, ...response },
      }),
  };
  const operator = {
    button: (payload: string) =>
      orchestrator.handle({ ...base(), kind: 'button', from: OPERATOR, toPhoneNumberId: CONTA_OP_NUMBER, payload }),
    flow: (flowToken: string, response: Record<string, unknown>) =>
      orchestrator.handle({
        ...base(),
        kind: 'flow',
        from: OPERATOR,
        toPhoneNumberId: CONTA_OP_NUMBER,
        flowToken,
        response,
      }),
    echo: (to = CLIENT) =>
      orchestrator.handle({ ...base(), kind: 'echo', toPhoneNumberId: BUSINESS_NUMBER, to } as Inbound),
  };

  /** Lleva una solicitud nueva hasta el resumen (B1 → B4). */
  async function untilSummary() {
    await client.text('Hola, quiero factura');
    await client.file('application/pdf');
    const req = [...store.requests.values()].at(-1)!;
    await client.button(`datos_ok:${req.id}`);
    await client.file('image/jpeg', 'image');
    return req.id;
  }

  return { store, business, wa, facturapi, reader, sink, scheduler, clock, orchestrator, client, operator, untilSummary };
}
