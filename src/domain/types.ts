// Modelo de dominio de Conta v2. Los nombres siguen el lienzo «Conta en WhatsApp».

export type EmissionMode = 'automatico' | 'aprobacion';

/** Regla de emisión versionada (A4). Cada solicitud fija la versión vigente al abrirse. */
export interface EmissionRule {
  version: number;
  mode: EmissionMode;
  /** Monto máximo (MXN, con impuestos) que se timbra sin aprobación. */
  maxAmount: number;
  /** Antigüedad máxima del ticket, en días, para timbrar sin aprobación. */
  maxTicketAgeDays: number;
}

/** Concepto con el que el negocio factura sus tickets (clave guardada por negocio, B4). */
export interface ProductConfig {
  description: string;
  productKey: string;
  unitKey: string;
  unitName: string;
  /** Tipo de operación: decide qué retenciones aplican. */
  kind: 'bienes' | 'servicios' | 'arrendamiento';
}

export interface Business {
  id: string;
  /** Nombre comercial que ve el receptor («Café Ámbar»). */
  name: string;
  rfc: string;
  taxSystem: string;
  /** phone_number_id del número del negocio en la Cloud API (coexistencia). */
  waPhoneNumberId: string;
  /** Teléfono del operador en caja al que escribe Conta Operación (E.164 sin «+»). */
  operatorPhones: string[];
  /** Live Key de la organización del emisor en Facturapi (vive en la bóveda). */
  facturapiKeyRef: string;
  rule: EmissionRule;
  product: ProductConfig;
  /** URL del aviso de privacidad que se manda en el primer mensaje (B1). */
  privacyNoticeUrl: string;
  timezone: string;
  active: boolean;
}

export interface Operator {
  id: string;
  businessId: string;
  name: string;
  phone: string;
}

export interface Shift {
  businessId: string;
  operatorId: string;
  openedAt: Date;
}

/** Datos fiscales de un receptor, por negocio. Nunca guardamos CURP ni domicilio. */
export interface FiscalData {
  rfc: string;
  legalName: string;
  zip: string;
  taxSystem: string;
}

export interface Receptor {
  id: string;
  businessId: string;
  /** Seudónimo del teléfono (HMAC). El teléfono real solo vive en `phone`. */
  pseudoId: string;
  phone: string;
  fiscal?: FiscalData;
  email?: string;
  facturapiCustomerId?: string;
  satValidatedAt?: Date;
}

export interface TicketData {
  total: number;
  /** Fecha del ticket, YYYY-MM-DD. */
  date: string;
  folio: string;
  merchantName?: string;
  /** El receptor escribió el total porque la foto no se pudo leer (ER18). */
  manual?: boolean;
}

export type RequestState =
  | 'esperando_datos' // pidió factura; esperamos CSF o captura manual
  | 'confirmando_datos' // mostramos los 4 datos leídos de la CSF
  | 'esperando_ticket'
  | 'confirmando_resumen' // resumen con «Sí, facturar» y «Corregir»
  | 'en_aprobacion' // esperando al operador (C2)
  | 'corrigiendo' // el operador corrige un campo que rechazó el SAT (C5)
  | 'timbrando'
  | 'en_proceso_sat' // el SAT o el PAC no respondieron (ER28)
  | 'entregada'
  | 'abandonada';

export type IssuedBy = 'automatico' | 'operador';

export interface InvoiceRequest {
  id: string;
  businessId: string;
  receptorId: string;
  state: RequestState;
  /** Regla fijada al abrir la solicitud (cambiar el modo después no la afecta). */
  rule: EmissionRule;
  /** Datos leídos de la CSF que el receptor aún no confirma. */
  pendingFiscal?: FiscalData;
  ticket?: TicketData;
  cfdiUse?: string;
  stampAttempts: number;
  /** Reintentos con la misma llave cuando el SAT o Facturapi no responden (ER28, ER36). */
  stampRetries: number;
  ticketReadAttempts: number;
  satValidationAttempts: number;
  approvalReason?: 'monto' | 'antiguedad' | 'modo' | 'folio_repetido' | 'csd_vencido' | 'captura_manual';
  approvalRequestedAt?: Date;
  approvedByOperatorId?: string;
  issuedBy?: IssuedBy;
  invoiceId?: string;
  /** Última vez que el receptor escribió: define la ventana de 24 h de WhatsApp. */
  lastInboundAt: Date;
  openedAt: Date;
  confirmedAt?: Date;
  updatedAt: Date;
}

export interface Invoice {
  id: string;
  requestId: string;
  businessId: string;
  receptorId: string;
  facturapiId: string;
  uuid?: string;
  total: number;
  status: 'valid' | 'pending' | 'canceled' | 'failed';
  issuedBy: IssuedBy;
  operatorId?: string;
  createdAt: Date;
}
