// Puertos: lo que el núcleo necesita del exterior. Cada adaptador (Meta, Facturapi, IA, Postgres) los implementa.

import type {
  Business,
  FiscalData,
  Invoice,
  InvoiceRequest,
  Operator,
  Receptor,
  Shift,
} from './domain/types.js';

// ---------- WhatsApp Cloud API ----------

export interface Button {
  /** Payload que regresa en button_reply.id (máx. 256). */
  id: string;
  /** Texto del botón (máx. 20 caracteres en WhatsApp). */
  title: string;
}

export interface OutgoingDocument {
  data: Buffer;
  filename: string;
  mimeType: string;
  caption?: string;
}

export interface TemplateMessage {
  name: string;
  languageCode: string;
  bodyParams: string[];
  headerDocument?: OutgoingDocument;
}

export interface FlowMessage {
  flowId: string;
  /** Token que regresa en nfm_reply para ligar la respuesta a la solicitud. */
  flowToken: string;
  cta: string;
  body: string;
  screen: string;
  data?: Record<string, unknown>;
}

export interface WhatsAppSender {
  sendText(fromPhoneNumberId: string, to: string, text: string): Promise<void>;
  sendButtons(fromPhoneNumberId: string, to: string, body: string, buttons: Button[]): Promise<void>;
  sendDocument(fromPhoneNumberId: string, to: string, doc: OutgoingDocument): Promise<void>;
  /** Plantilla aprobada: lo único que se puede mandar fuera de la ventana de 24 h (ER33). */
  sendTemplate(fromPhoneNumberId: string, to: string, template: TemplateMessage): Promise<void>;
  sendFlow(fromPhoneNumberId: string, to: string, flow: FlowMessage): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

// ---------- Facturapi ----------

export interface SatValidationError {
  /** Campo que falla, p. ej. `legal_name` o `address.zip`. */
  path: string;
  message: string;
}

export interface CreateInvoiceInput {
  customerId: string;
  use: string;
  paymentForm: string;
  folioNumber?: string;
  externalId: string;
  items: Array<{
    quantity: number;
    product: {
      description: string;
      product_key: string;
      unit_key: string;
      unit_name: string;
      price: number;
      tax_included: boolean;
      taxes: Array<{ type: string; rate: number; withholding?: boolean }>;
    };
  }>;
}

export interface StampedInvoice {
  id: string;
  uuid?: string;
  status: 'valid' | 'pending' | 'canceled' | 'draft';
  total: number;
}

export interface FacturapiPort {
  upsertCustomer(apiKey: string, fiscal: FiscalData, existingId?: string): Promise<{ id: string }>;
  validateCustomer(
    apiKey: string,
    customerId: string,
  ): Promise<{ isValid: boolean; errors: SatValidationError[] }>;
  createInvoice(apiKey: string, input: CreateInvoiceInput, idempotencyKey: string): Promise<StampedInvoice>;
  downloadPdf(apiKey: string, invoiceId: string): Promise<Buffer>;
  downloadXml(apiKey: string, invoiceId: string): Promise<Buffer>;
  sendByEmail(apiKey: string, invoiceId: string, email: string): Promise<void>;
}

// ---------- Intérprete y lector (IA con visión) ----------

export type Intent = 'pedir_factura' | 'reenviar_factura' | 'sin_csf' | 'otro';

export interface CsfReading {
  rfc: string | null;
  legalName: string | null;
  zip: string | null;
  /** Régimen principal: el único vigente, o el primero si hay varios. */
  taxSystem: string | null;
  /** Todos los regímenes vigentes (si hay más de uno, el receptor elige). */
  taxSystems: string[];
  pagesRead: number;
  confidence: number;
  /** Quién leyó la constancia: el lector determinista o la IA de respaldo. */
  source: 'lector_csf' | 'ia';
  /** La constancia no sirve para facturar y no vale la pena intentar con IA. */
  rejection?: CsfRejection;
}

export type CsfRejection =
  | 'protegida' // PDF con contraseña
  | 'contribuyente_inactivo' // estatus distinto de ACTIVO o REACTIVADO
  | 'sin_regimen'; // falta la página de regímenes (ER13)

export interface TicketReading {
  total: number | null;
  date: string | null;
  folio: string | null;
  merchantName: string | null;
  matchesBusiness: boolean;
  confidence: number;
}

export interface FiscalReader {
  classifyIntent(text: string, businessName: string): Promise<Intent>;
  readCsf(pdf: Buffer): Promise<CsfReading>;
  readTicket(image: Buffer, mimeType: string, businessName: string): Promise<TicketReading>;
}

// ---------- Datos ----------

export interface Store {
  businessByPhoneNumberId(phoneNumberId: string): Promise<Business | undefined>;
  business(id: string): Promise<Business | undefined>;
  businessByOperatorPhone(phone: string): Promise<Business | undefined>;

  operators(businessId: string): Promise<Operator[]>;
  openShift(businessId: string): Promise<Shift | undefined>;
  setShift(shift: Shift): Promise<void>;

  receptor(businessId: string, phone: string): Promise<Receptor | undefined>;
  receptorById(id: string): Promise<Receptor | undefined>;
  saveReceptor(receptor: Receptor): Promise<void>;

  /** La solicitud abierta (no entregada ni abandonada) de un receptor en un negocio. */
  openRequest(businessId: string, receptorId: string): Promise<InvoiceRequest | undefined>;
  openRequestsForBusiness(businessId: string): Promise<InvoiceRequest[]>;
  request(id: string): Promise<InvoiceRequest | undefined>;
  saveRequest(request: InvoiceRequest): Promise<void>;

  /** Fecha en que ya se facturó ese folio en el negocio, si existe (ER20). */
  folioInvoicedAt(businessId: string, folio: string): Promise<Date | undefined>;
  registerFolio(businessId: string, folio: string, requestId: string, at: Date): Promise<void>;

  saveInvoice(invoice: Invoice): Promise<void>;
  lastInvoice(businessId: string, receptorId: string): Promise<Invoice | undefined>;

  /** Pausa del bot en un chat porque el operador escribió desde la app (ER11). */
  pauseBot(businessId: string, receptorPhone: string, until: Date): Promise<void>;
  botPausedUntil(businessId: string, receptorPhone: string): Promise<Date | undefined>;

  /** Control de repetidos de webhooks. Regresa false si el id ya se vio. */
  markSeen(eventId: string): Promise<boolean>;
}

export interface Secrets {
  /** Resuelve la Live Key de Facturapi del emisor desde la bóveda. */
  facturapiKey(ref: string): Promise<string>;
}

/** Trabajo diferido (reintentos de timbrado, recordatorios). En producción, la cola de eventos. */
export interface Scheduler {
  schedule(label: string, delayMs: number, job: () => Promise<void>): void;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}
