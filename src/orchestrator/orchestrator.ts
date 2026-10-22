// Orquestador de solicitudes (núcleo de Conta v2).
// Una solicitud por receptor y negocio: sabe qué falta, fija la regla vigente al empezar
// y pausa el bot si el operador escribe en ese chat.

import { Analytics, pseudonymize, type GlobalParams } from '../analytics/events.js';
import { FacturapiError } from '../adapters/facturapi/errors.js';
import {
  cfdiUsesFor,
  defaultCfdiUse,
  describeField,
  isCfdiUseAllowed,
  isTaxSystemAllowedForRfc,
  itemTaxes,
  taxSystemName,
  taxSystemShortName,
  taxSystemsFor,
} from '../domain/fiscal.js';
import { isValidRfc, isValidZip, normalizeRfc } from '../domain/rfc.js';
import { decideEmission } from '../domain/rules.js';
import type { Business, FiscalData, InvoiceRequest, Receptor, TicketData } from '../domain/types.js';
import { describeMime, formatDate, formatMoney, render, type MessageKey } from '../messages/catalog.js';
import type {
  Clock,
  CsfRejection,
  FacturapiPort,
  FiscalReader,
  IdGenerator,
  SatValidationError,
  Scheduler,
  Secrets,
  Store,
  WhatsAppSender,
} from '../ports.js';
import type { Inbound } from './inbound.js';

export interface OrchestratorConfig {
  /** phone_number_id del número «Conta Operación». */
  contaOpPhoneNumberId: string;
  /** Flow «Tus datos fiscales» (B3 y D2). */
  fiscalDataFlowId: string;
  /** Flow para corregir un campo rechazado por el SAT (C5). */
  fixFieldFlowId: string;
  /** Plantilla de utilidad para entregar fuera de la ventana de 24 h (ER33). */
  invoiceReadyTemplate: string;
  receptorSalt: string;
  /** Confianza mínima del lector para aceptar un ticket o una CSF. */
  minReadConfidence: number;
  /** Cuánto se pausa el bot cuando el operador escribe desde la app (ER11). */
  botPauseMs: number;
  /** Forma de pago con la que se timbran los tickets (c_FormaPago). */
  defaultPaymentForm: string;
  /** ER28: reintentos de timbrado y espera entre ellos. */
  stampMaxRetries: number;
  stampRetryDelayMs: number;
}

const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const OPEN_STATES_WAITING_TICKET: InvoiceRequest['state'][] = ['esperando_ticket'];

type ReceptorCtx = { business: Business; receptor: Receptor; msg: Inbound & { from: string } };

export class Orchestrator {
  constructor(
    private readonly cfg: OrchestratorConfig,
    private readonly store: Store,
    private readonly wa: WhatsAppSender,
    private readonly facturapi: FacturapiPort,
    private readonly reader: FiscalReader,
    private readonly secrets: Secrets,
    private readonly analytics: Analytics,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly scheduler: Scheduler,
  ) {}

  // ======================================================================
  // Entrada
  // ======================================================================

  /** Meta puede mandar el mismo webhook dos veces: solo se acepta la primera. */
  accept(msg: Inbound): Promise<boolean> {
    return this.store.markSeen(msg.id);
  }

  async handle(msg: Inbound): Promise<void> {
    if (await this.accept(msg)) await this.process(msg);
  }

  async process(msg: Inbound): Promise<void> {
    if (msg.kind === 'echo') return this.handleEcho(msg);
    if (msg.toPhoneNumberId === this.cfg.contaOpPhoneNumberId) return this.handleOperator(msg);

    const business = await this.store.businessByPhoneNumberId(msg.toPhoneNumberId);
    if (!business || !business.active) return;

    const pausedUntil = await this.store.botPausedUntil(business.id, msg.from);
    if (pausedUntil && pausedUntil > this.clock.now()) return; // el operador lleva este chat

    const receptor = await this.ensureReceptor(business, msg.from);
    return this.handleReceptor({ business, receptor, msg });
  }

  /** Facturapi avisa un cambio de estado (webhook invoice.status_updated). */
  async handleInvoiceStatus(event: {
    requestId: string;
    facturapiId: string;
    status: string;
    uuid?: string;
    total: number;
  }): Promise<void> {
    const req = await this.store.request(event.requestId);
    if (!req || req.state !== 'en_proceso_sat') return;
    const business = await this.mustBusiness(req.businessId);
    if (event.status === 'valid') {
      await this.deliver(business, req, { id: event.facturapiId, uuid: event.uuid, total: event.total });
    } else if (event.status === 'failed') {
      await this.notifyOperatorStampError(business, req, 'el timbrado', 'El SAT no respondió a tiempo.');
    }
  }

  // ======================================================================
  // Receptor · chat del número del negocio (B1–B5, D1, D2)
  // ======================================================================

  private async handleReceptor(ctx: ReceptorCtx): Promise<void> {
    const { business, receptor, msg } = ctx;
    const req = await this.store.openRequest(business.id, receptor.id);

    if (!req) return this.handleWithoutRequest(ctx);

    req.lastInboundAt = msg.at;
    switch (req.state) {
      case 'esperando_datos':
      case 'confirmando_datos':
        return this.handleFiscalStep(ctx, req);
      case 'esperando_ticket':
        return this.handleTicketStep(ctx, req);
      case 'confirmando_resumen':
        return this.handleSummaryStep(ctx, req);
      case 'en_aprobacion':
      case 'corrigiendo':
        await this.store.saveRequest(req);
        return this.say(business, receptor.phone, 'ER25_receptor');
      case 'timbrando':
      case 'en_proceso_sat':
        await this.store.saveRequest(req);
        return this.say(business, receptor.phone, 'enProceso');
      default:
        return;
    }
  }

  private async handleWithoutRequest({ business, receptor, msg }: ReceptorCtx): Promise<void> {
    if (msg.kind !== 'text') return; // ER10: archivos sin contexto son para el negocio
    const intent = await this.reader.classifyIntent(msg.text, business.name);

    if (intent === 'reenviar_factura') return this.resendLastInvoice(business, receptor);
    if (intent !== 'pedir_factura' && intent !== 'sin_csf') return; // ER10: Conta no contesta

    const now = this.clock.now();
    const req: InvoiceRequest = {
      id: this.ids.next('sol'),
      businessId: business.id,
      receptorId: receptor.id,
      state: 'esperando_datos',
      rule: { ...business.rule },
      stampAttempts: 0,
      stampRetries: 0,
      ticketReadAttempts: 0,
      satValidationAttempts: 0,
      lastInboundAt: msg.at,
      openedAt: now,
      updatedAt: now,
    };
    await this.track('solicitud_iniciada', business, req, receptor, 'B1', {
      receptor_recurrente: Boolean(receptor.satValidatedAt),
    });

    if (receptor.fiscal && receptor.satValidatedAt) {
      // P13: receptor que regresa
      req.state = 'confirmando_datos';
      req.pendingFiscal = receptor.fiscal;
      await this.store.saveRequest(req);
      return this.wa.sendButtons(
        business.waPhoneNumberId,
        receptor.phone,
        render('receptorConocido', { nombre: receptor.fiscal.legalName }),
        [
          { id: `conocido_si:${req.id}`, title: 'Sí, esos datos' },
          { id: `conocido_no:${req.id}`, title: 'Otros datos' },
        ],
      );
    }

    await this.store.saveRequest(req);
    if (intent === 'sin_csf') return this.sendFiscalForm(business, receptor, req);
    return this.say(business, receptor.phone, 'bienvenida', {
      negocio: business.name,
      aviso: business.privacyNoticeUrl,
    });
  }

  // ---------- Datos fiscales: CSF, formulario y validación con el SAT ----------

  private async handleFiscalStep(ctx: ReceptorCtx, req: InvoiceRequest): Promise<void> {
    const { business, receptor, msg } = ctx;

    if (msg.kind === 'media') return this.readCsf(ctx, req, msg);

    if (msg.kind === 'button') {
      const [action, reqId, code] = msg.payload.split(':');
      if (reqId !== req.id) return;
      if (action === 'regimen' && code && req.pendingFiscal && isTaxSystemAllowedForRfc(code, req.pendingFiscal.rfc)) {
        req.pendingFiscal = { ...req.pendingFiscal, taxSystem: code };
        await this.store.saveRequest(req);
        return this.sendFiscalCard(business, receptor, req, req.pendingFiscal);
      }
      if ((action === 'datos_ok' || action === 'conocido_si') && req.pendingFiscal) {
        return this.validateFiscal(ctx, req, req.pendingFiscal);
      }
      if (action === 'datos_editar' || action === 'conocido_no') {
        await this.store.saveRequest(req);
        return this.sendFiscalForm(business, receptor, req, action === 'datos_editar' ? req.pendingFiscal : undefined);
      }
      return;
    }

    if (msg.kind === 'flow') {
      const fiscal = parseFiscalForm(msg.response);
      await this.track('datos_fiscales_editados', business, req, receptor, 'B3');
      const localError = checkFiscalLocally(fiscal);
      if (localError) {
        await this.store.saveRequest(req);
        await this.say(business, receptor.phone, localError);
        return this.sendFiscalForm(business, receptor, req, fiscal);
      }
      return this.validateFiscal(ctx, req, fiscal);
    }

    if (msg.kind === 'text') {
      const intent = await this.reader.classifyIntent(msg.text, business.name);
      await this.store.saveRequest(req);
      if (intent === 'sin_csf') return this.sendFiscalForm(business, receptor, req);
      return this.say(business, receptor.phone, 'noEntendi');
    }
  }

  private async readCsf(
    { business, receptor }: ReceptorCtx,
    req: InvoiceRequest,
    msg: Extract<Inbound, { kind: 'media' }>,
  ): Promise<void> {
    await this.track('csf_recibida', business, req, receptor, 'B2', { tipo_archivo: msg.mimeType });
    if (msg.mimeType !== 'application/pdf') {
      await this.store.saveRequest(req);
      return this.say(business, receptor.phone, 'ER12', { tipo: describeMime(msg.mimeType) });
    }

    // La CSF solo vive en memoria: no se guarda (CURP y domicilio nunca se persisten).
    const media = await this.wa.downloadMedia(msg.mediaId);
    const reading = await this.reader.readCsf(media.data);
    const fieldsRead = [reading.rfc, reading.legalName, reading.zip, reading.taxSystem].filter(Boolean).length;
    await this.track('csf_leida', business, req, receptor, 'B2', {
      campos_leidos: fieldsRead,
      paginas: reading.pagesRead,
      origen_lectura: reading.source,
      regimenes_vigentes: reading.taxSystems.length,
      rechazo: reading.rejection ?? null,
    });

    if (reading.rejection) {
      await this.store.saveRequest(req);
      return this.say(business, receptor.phone, CSF_REJECTION_MESSAGES[reading.rejection]);
    }
    if (!reading.taxSystem && reading.rfc) {
      await this.store.saveRequest(req);
      return this.say(business, receptor.phone, 'ER13');
    }
    if (fieldsRead < 4 || reading.confidence < this.cfg.minReadConfidence) {
      await this.store.saveRequest(req);
      return this.sendFiscalForm(business, receptor, req, partialFiscal(reading));
    }

    const fiscal: FiscalData = {
      rfc: normalizeRfc(reading.rfc!),
      legalName: reading.legalName!.trim().toUpperCase(),
      zip: reading.zip!.trim(),
      taxSystem: reading.taxSystem!,
    };
    req.pendingFiscal = fiscal;
    req.state = 'confirmando_datos';

    // Varios regímenes vigentes: el receptor elige con cuál se factura; no adivinamos.
    const options = reading.taxSystems.filter((code) => isTaxSystemAllowedForRfc(code, fiscal.rfc));
    if (options.length > 1) {
      await this.store.saveRequest(req);
      if (options.length > 3) return this.sendFiscalForm(business, receptor, req, { ...fiscal, taxSystem: '' });
      return this.wa.sendButtons(
        business.waPhoneNumberId,
        receptor.phone,
        render('eligeRegimen', {
          regimenes: options.map((c) => `• ${c} · ${taxSystemName(c) ?? ''}`).join('\n'),
        }),
        options.map((code) => ({ id: `regimen:${req.id}:${code}`, title: `${code} ${taxSystemShortName(code)}` })),
      );
    }

    await this.store.saveRequest(req);
    return this.sendFiscalCard(business, receptor, req, fiscal);
  }

  private sendFiscalCard(business: Business, receptor: Receptor, req: InvoiceRequest, fiscal: FiscalData) {
    return this.wa.sendButtons(
      business.waPhoneNumberId,
      receptor.phone,
      render('datosLeidos', {
        rfc: fiscal.rfc,
        nombre: fiscal.legalName,
        cp: fiscal.zip,
        regimen: `${fiscal.taxSystem} · ${taxSystemName(fiscal.taxSystem) ?? ''}`.trim(),
      }),
      [
        { id: `datos_ok:${req.id}`, title: 'Sí, son correctos' },
        { id: `datos_editar:${req.id}`, title: 'Editar datos' },
      ],
    );
  }

  private async validateFiscal(ctx: ReceptorCtx, req: InvoiceRequest, fiscal: FiscalData): Promise<void> {
    const { business, receptor } = ctx;
    const apiKey = await this.secrets.facturapiKey(business.facturapiKeyRef);
    req.satValidationAttempts += 1;

    let errors: SatValidationError[] = [];
    let customerId = receptor.facturapiCustomerId;
    try {
      ({ id: customerId } = await this.facturapi.upsertCustomer(apiKey, fiscal, customerId));
      ({ errors } = await this.facturapi.validateCustomer(apiKey, customerId));
    } catch (err) {
      if (!(err instanceof FacturapiError) || err.status >= 500) throw err;
      errors = err.errors.length
        ? err.errors.map((e) => ({ path: e.path ?? err.path ?? '', message: e.message }))
        : [{ path: err.code ?? err.path ?? '', message: err.message }];
    }

    if (errors.length > 0) {
      await this.track('validacion_sat_rechazada', business, req, receptor, 'B3', {
        campo: errors[0]!.path,
        intento_n: req.satValidationAttempts,
      });
      req.pendingFiscal = fiscal;
      req.state = 'confirmando_datos';
      await this.store.saveRequest(req);
      const key = satErrorMessage(errors[0]!);
      await this.say(business, receptor.phone, key, { detalle: errors[0]!.message });
      return this.sendFiscalForm(business, receptor, req, fiscal);
    }

    receptor.fiscal = fiscal;
    receptor.facturapiCustomerId = customerId;
    receptor.satValidatedAt = this.clock.now();
    await this.store.saveReceptor(receptor);
    await this.track('validacion_sat_aprobada', business, req, receptor, 'B2', {
      intento_n: req.satValidationAttempts,
    });

    req.pendingFiscal = undefined;
    req.cfdiUse = req.cfdiUse && isCfdiUseAllowed(req.cfdiUse, fiscal.taxSystem)
      ? req.cfdiUse
      : defaultCfdiUse(fiscal.taxSystem);

    if (req.ticket) {
      // Venía de «Corregir» en el resumen: el ticket ya está leído.
      return this.sendSummary(business, receptor, req);
    }
    req.state = 'esperando_ticket';
    await this.store.saveRequest(req);
    return this.say(business, receptor.phone, 'pideTicket');
  }

  private async sendFiscalForm(
    business: Business,
    receptor: Receptor,
    req: InvoiceRequest,
    prefill?: Partial<FiscalData>,
  ): Promise<void> {
    if (prefill?.rfc) req.pendingFiscal = { rfc: '', legalName: '', zip: '', taxSystem: '', ...prefill };
    req.state = 'confirmando_datos';
    await this.store.saveRequest(req);
    await this.wa.sendFlow(business.waPhoneNumberId, receptor.phone, {
      flowId: this.cfg.fiscalDataFlowId,
      flowToken: `datos:${req.id}`,
      cta: 'Escribir mis datos',
      body: 'Escribe tus datos como aparecen en tu constancia.',
      screen: 'DATOS_FISCALES',
      data: {
        rfc: prefill?.rfc ?? '',
        nombre: prefill?.legalName ?? '',
        cp: prefill?.zip ?? '',
        regimen: prefill?.taxSystem ?? '',
        regimenes: (prefill?.rfc ? taxSystemsFor(prefill.rfc) : []).map((t) => ({
          id: t.code,
          title: `${t.code} · ${t.name}`,
        })),
      },
    });
  }

  // ---------- Ticket ----------

  private async handleTicketStep(ctx: ReceptorCtx, req: InvoiceRequest): Promise<void> {
    const { business, receptor, msg } = ctx;
    if (msg.kind === 'media') {
      return this.readTicket(business, receptor, req, msg.mediaId, msg.mimeType, 'receptor');
    }
    if (msg.kind === 'text' && req.ticketReadAttempts > 0) {
      // ER18: «o escríbelo». Un total escrito a mano siempre pasa por el operador.
      const total = parseAmount(msg.text);
      if (total) {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(this.clock.now());
        req.ticket = { total, date: today, folio: `manual-${req.id}`, manual: true };
        await this.track('ticket_leido', business, req, receptor, 'D1', { origen_datos: 'manual' });
        return this.sendSummary(business, receptor, req);
      }
    }
    await this.store.saveRequest(req);
    return this.say(business, receptor.phone, 'pideTicket');
  }

  private async readTicket(
    business: Business,
    receptor: Receptor,
    req: InvoiceRequest,
    mediaId: string,
    mimeType: string,
    sentBy: 'receptor' | 'operador',
  ): Promise<void> {
    await this.track('ticket_recibido', business, req, receptor, sentBy === 'receptor' ? 'B4' : 'C3', {
      tipo_archivo: mimeType.split('/')[1] ?? mimeType,
      enviado_por: sentBy,
    });

    if (!mimeType.startsWith('image/')) {
      await this.store.saveRequest(req);
      return this.say(business, receptor.phone, 'ER19', { tipo: describeMime(mimeType) });
    }

    const media = await this.wa.downloadMedia(mediaId);
    const reading = await this.reader.readTicket(media.data, media.mimeType, business.name);
    req.ticketReadAttempts += 1;

    if (reading.total === null || reading.confidence < this.cfg.minReadConfidence) {
      await this.store.saveRequest(req);
      return this.say(business, receptor.phone, 'ER18'); // nunca inventa un monto
    }
    if (!reading.matchesBusiness) {
      await this.store.saveRequest(req);
      return this.say(business, receptor.phone, 'ER23', { negocio: business.name });
    }

    req.ticket = {
      total: reading.total,
      date: reading.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(this.clock.now()),
      folio: reading.folio ?? `sinfolio-${req.id}`,
      merchantName: reading.merchantName ?? undefined,
    };
    await this.track('ticket_leido', business, req, receptor, sentBy === 'receptor' ? 'B4' : 'C3', {
      origen_datos: 'foto',
      monto: reading.total,
    });
    return this.sendSummary(business, receptor, req);
  }

  private async sendSummary(business: Business, receptor: Receptor, req: InvoiceRequest): Promise<void> {
    const ticket = req.ticket!;
    const fiscal = receptor.fiscal!;
    req.cfdiUse ??= defaultCfdiUse(fiscal.taxSystem);
    req.state = 'confirmando_resumen';
    await this.store.saveRequest(req);
    const useName = cfdiUsesFor(fiscal.taxSystem).find((u) => u.code === req.cfdiUse)?.name ?? '';
    return this.wa.sendButtons(
      business.waPhoneNumberId,
      receptor.phone,
      render('resumen', {
        negocio: business.name,
        folio: ticket.manual ? '(escrito a mano)' : ticket.folio,
        fecha: formatDate(ticket.date),
        total: formatMoney(ticket.total),
        nombre: fiscal.legalName,
        rfc: fiscal.rfc,
        uso: `${req.cfdiUse} · ${useName}`,
      }),
      [
        { id: `facturar:${req.id}`, title: 'Sí, facturar' },
        { id: `corregir:${req.id}`, title: 'Corregir' },
      ],
    );
  }

  // ---------- Resumen y emisión ----------

  private async handleSummaryStep(ctx: ReceptorCtx, req: InvoiceRequest): Promise<void> {
    const { business, receptor, msg } = ctx;
    if (msg.kind !== 'button') {
      await this.store.saveRequest(req);
      return this.sendSummary(business, receptor, req);
    }
    const [action, reqId] = msg.payload.split(':');
    if (reqId !== req.id) return;

    if (action === 'corregir') {
      await this.track('resumen_corregido', business, req, receptor, 'B4');
      return this.sendFiscalForm(business, receptor, req, receptor.fiscal);
    }
    if (action !== 'facturar') return;

    req.confirmedAt = this.clock.now();
    await this.track('resumen_confirmado', business, req, receptor, 'B4');
    const ticket = req.ticket!;
    const invoicedAt = ticket.manual ? undefined : await this.store.folioInvoicedAt(business.id, ticket.folio);
    const decision = decideEmission({
      rule: req.rule,
      ticket,
      now: this.clock.now(),
      timezone: business.timezone,
      folioAlreadyInvoiced: Boolean(invoicedAt),
    });

    if (decision.action === 'timbrar') {
      req.issuedBy = 'automatico';
      return this.stamp(business, receptor, req);
    }

    req.state = 'en_aprobacion';
    req.approvalReason = decision.reason;
    req.approvalRequestedAt = this.clock.now();
    await this.store.saveRequest(req);
    if (decision.reason === 'folio_repetido') {
      await this.say(business, receptor.phone, 'ER20', { fecha: formatDate(isoDate(invoicedAt!)) });
    } else if (decision.reason === 'antiguedad') {
      await this.say(business, receptor.phone, 'ER21', { fecha: formatDate(ticket.date) });
    } else {
      await this.say(business, receptor.phone, 'ER22');
    }
    return this.requestApproval(business, receptor, req);
  }

  private async stamp(business: Business, receptor: Receptor, req: InvoiceRequest): Promise<void> {
    req.state = 'timbrando';
    await this.store.saveRequest(req);
    const apiKey = await this.secrets.facturapiKey(business.facturapiKeyRef);
    const fiscal = receptor.fiscal!;
    const ticket = req.ticket!;

    try {
      const invoice = await this.facturapi.createInvoice(
        apiKey,
        {
          customerId: receptor.facturapiCustomerId!,
          use: req.cfdiUse ?? defaultCfdiUse(fiscal.taxSystem),
          paymentForm: this.cfg.defaultPaymentForm,
          externalId: req.id,
          items: [
            {
              quantity: 1,
              product: {
                description: business.product.description,
                product_key: business.product.productKey,
                unit_key: business.product.unitKey,
                unit_name: business.product.unitName,
                price: ticket.total,
                tax_included: true,
                taxes: itemTaxes({
                  issuerRfc: business.rfc,
                  issuerTaxSystem: business.taxSystem,
                  receptorRfc: fiscal.rfc,
                  kind: business.product.kind,
                }),
              },
            },
          ],
        },
        // Una llave por intento: un reintento tras corregir un campo usa una nueva (C5).
        `${req.id}-${req.stampAttempts}`,
      );

      await this.track('factura_timbrada', business, req, receptor, 'B5', {
        emitio: req.issuedBy,
        monto: invoice.total,
      });

      if (invoice.status === 'pending') {
        req.state = 'en_proceso_sat';
        await this.store.saveRequest(req);
        return this.say(business, receptor.phone, 'ER28');
      }
      return this.deliver(business, req, invoice);
    } catch (err) {
      if (!(err instanceof FacturapiError)) throw err;
      if (err.isIdempotencyConflict) return; // ER29: ya se está timbrando esa llave
      if (err.isStampingValidation) {
        req.state = 'corrigiendo';
        await this.store.saveRequest(req);
        await this.track('timbrado_rechazado', business, req, receptor, 'C4', {
          fuente_error: err.errors[0]?.source ?? 'sat',
          campo: err.failingPath,
        });
        await this.say(business, receptor.phone, 'enRevision');
        return this.notifyOperatorStampError(business, req, describeField(err.failingPath), err.message);
      }
      if (!err.isRetryable) throw err;
      // ER28, ER30, ER36: el receptor nunca ve un error técnico; se reintenta con la misma llave.
      const firstTime = req.stampRetries === 0;
      req.state = 'en_proceso_sat';
      await this.store.saveRequest(req);
      if (firstTime) await this.say(business, receptor.phone, 'enProceso');
      if (req.stampRetries < this.cfg.stampMaxRetries) {
        this.scheduler.schedule(`reintento:${req.id}`, this.cfg.stampRetryDelayMs, () => this.retryStamp(req.id));
      } else {
        await this.notifyOperatorStampError(business, req, 'el timbrado', 'El SAT o el PAC no respondieron.');
      }
    }
  }

  /** Reintento programado: misma idempotency_key, así nunca se crea una segunda factura. */
  async retryStamp(requestId: string): Promise<void> {
    const req = await this.store.request(requestId);
    if (!req || req.state !== 'en_proceso_sat') return;
    const business = await this.mustBusiness(req.businessId);
    const receptor = await this.mustReceptorById(business, req);
    req.stampRetries += 1;
    return this.stamp(business, receptor, req);
  }

  private async deliver(
    business: Business,
    req: InvoiceRequest,
    invoice: { id: string; uuid?: string; total: number },
  ): Promise<void> {
    const receptor = await this.mustReceptorById(business, req);
    const apiKey = await this.secrets.facturapiKey(business.facturapiKeyRef);
    const [pdf, xml] = await Promise.all([
      this.facturapi.downloadPdf(apiKey, invoice.id),
      this.facturapi.downloadXml(apiKey, invoice.id),
    ]);
    const now = this.clock.now();
    const base = invoice.uuid ?? invoice.id;
    const pdfDoc = { data: pdf, filename: `factura-${base}.pdf`, mimeType: 'application/pdf' };
    const xmlDoc = { data: xml, filename: `factura-${base}.xml`, mimeType: 'application/xml' };

    await this.store.saveInvoice({
      id: this.ids.next('fac'),
      requestId: req.id,
      businessId: business.id,
      receptorId: receptor.id,
      facturapiId: invoice.id,
      uuid: invoice.uuid,
      total: invoice.total,
      status: 'valid',
      issuedBy: req.issuedBy ?? 'automatico',
      operatorId: req.approvedByOperatorId,
      createdAt: now,
    });
    if (req.ticket && !req.ticket.manual) await this.store.registerFolio(business.id, req.ticket.folio, req.id, now);

    if (now.getTime() - req.lastInboundAt.getTime() > WINDOW_24H_MS) {
      // ER33: fuera de la ventana solo sale una plantilla; el XML se reenvía con «mi factura».
      await this.wa.sendTemplate(business.waPhoneNumberId, receptor.phone, {
        name: this.cfg.invoiceReadyTemplate,
        languageCode: 'es_MX',
        bodyParams: [business.name],
        headerDocument: pdfDoc,
      });
    } else {
      await this.wa.sendDocument(business.waPhoneNumberId, receptor.phone, {
        ...pdfDoc,
        caption: render('facturaLista', { negocio: business.name, uuid: invoice.uuid ?? '' }),
      });
      // ⚠️ ER32: WhatsApp no soporta oficialmente el XML como documento. Plan B: enlace firmado.
      await this.wa.sendDocument(business.waPhoneNumberId, receptor.phone, xmlDoc);
    }

    if (req.issuedBy === 'operador') {
      for (const phone of business.operatorPhones) {
        await this.wa.sendDocument(this.cfg.contaOpPhoneNumberId, phone, {
          ...pdfDoc,
          caption: `Factura emitida · ticket ${req.ticket?.folio ?? ''}`,
        });
      }
    }

    req.state = 'entregada';
    req.invoiceId = invoice.id;
    await this.store.saveRequest(req);
    await this.track('factura_entregada', business, req, receptor, 'B5', {
      segundos_desde_solicitud: seconds(req.openedAt, now),
      segundos_desde_confirmacion: req.confirmedAt ? seconds(req.confirmedAt, now) : null,
      emitio: req.issuedBy,
    });
  }

  private async resendLastInvoice(business: Business, receptor: Receptor): Promise<void> {
    const last = await this.store.lastInvoice(business.id, receptor.id);
    if (!last) return this.say(business, receptor.phone, 'ER35', { negocio: business.name });
    const apiKey = await this.secrets.facturapiKey(business.facturapiKeyRef);
    const [pdf, xml] = await Promise.all([
      this.facturapi.downloadPdf(apiKey, last.facturapiId),
      this.facturapi.downloadXml(apiKey, last.facturapiId),
    ]);
    const base = last.uuid ?? last.facturapiId;
    await this.wa.sendDocument(business.waPhoneNumberId, receptor.phone, {
      data: pdf,
      filename: `factura-${base}.pdf`,
      mimeType: 'application/pdf',
      caption: render('facturaLista', { negocio: business.name, uuid: last.uuid ?? '' }),
    });
    await this.wa.sendDocument(business.waPhoneNumberId, receptor.phone, {
      data: xml,
      filename: `factura-${base}.xml`,
      mimeType: 'application/xml',
    });
  }

  // ======================================================================
  // Operador · chat «Conta Operación» (C1–C5)
  // ======================================================================

  private async handleOperator(msg: Exclude<Inbound, { kind: 'echo' }>): Promise<void> {
    const business = await this.store.businessByOperatorPhone(msg.from);
    if (!business) return;

    if (msg.kind === 'button') {
      const [action, a, b] = msg.payload.split(':');
      if (action === 'turno' && a && b) {
        await this.store.setShift({ businessId: business.id, operatorId: a, openedAt: this.clock.now() });
        return this.approve(business, b, msg.from);
      }
      if (action === 'aprobar' && a) return this.approve(business, a, msg.from);
      if (action === 'corregir' && a) return this.sendFixFieldForm(business, a, msg.from);
      if (action === 'ticket_para' && a && b) return this.operatorTicket(business, a, b, 'image/jpeg');
      if (action === 'soporte' && a) {
        // TODO: abrir support_cases con el contexto de la solicitud y avisar al equipo de soporte.
        console.warn('soporte_solicitado', { negocio: business.id, solicitud: a });
        return this.wa.sendText(this.cfg.contaOpPhoneNumberId, msg.from, render('soporteSolicitado'));
      }
      return;
    }

    if (msg.kind === 'flow' && msg.flowToken?.startsWith('campo:')) {
      const reqId = msg.flowToken.slice('campo:'.length);
      return this.applyFieldFix(business, reqId, String(msg.response['uso_cfdi'] ?? ''), msg.from);
    }

    if (msg.kind === 'media' && msg.mediaType === 'image') {
      // C3: el operador manda la foto del ticket por el cliente.
      const waiting = (await this.store.openRequestsForBusiness(business.id)).filter((r) =>
        OPEN_STATES_WAITING_TICKET.includes(r.state),
      );
      if (waiting.length === 0) {
        return this.wa.sendText(this.cfg.contaOpPhoneNumberId, msg.from, 'No hay solicitudes esperando ticket.');
      }
      if (waiting.length === 1) return this.operatorTicket(business, waiting[0]!.id, msg.mediaId, msg.mimeType);
      // ER24: varias solicitudes abiertas (máximo 3 botones)
      return this.wa.sendButtons(
        this.cfg.contaOpPhoneNumberId,
        msg.from,
        render('ER24', { n: waiting.length }),
        waiting.slice(0, 3).map((r) => ({
          id: `ticket_para:${r.id}:${msg.mediaId}`,
          title: `Solicitud ${r.id.slice(-4)}`,
        })),
      );
    }
  }

  private async operatorTicket(business: Business, reqId: string, mediaId: string, mimeType: string) {
    const req = await this.store.request(reqId);
    if (!req || req.businessId !== business.id || req.state !== 'esperando_ticket') return;
    const receptor = await this.mustReceptorById(business, req);
    await this.track('ticket_asignado', business, req, receptor, 'C3', {}, 'operador');
    return this.readTicket(business, receptor, req, mediaId, mimeType, 'operador');
  }

  private async approve(business: Business, reqId: string, operatorPhone: string): Promise<void> {
    const req = await this.store.request(reqId);
    if (!req || req.businessId !== business.id || req.state !== 'en_aprobacion') return; // ER29

    const shift = await this.store.openShift(business.id);
    if (!shift) {
      // ER26: no se acepta la aprobación hasta saber quién está en caja.
      const operators = await this.store.operators(business.id);
      return this.wa.sendButtons(
        this.cfg.contaOpPhoneNumberId,
        operatorPhone,
        render('quienEnCaja'),
        operators.slice(0, 3).map((o) => ({ id: `turno:${o.id}:${req.id}`, title: o.name.slice(0, 20) })),
      );
    }

    const receptor = await this.mustReceptorById(business, req);
    req.approvedByOperatorId = shift.operatorId;
    req.issuedBy = 'operador';
    await this.track('aprobacion_respondida', business, req, receptor, 'C2', {
      respuesta: 'aprobada',
      segundos_respuesta: req.approvalRequestedAt ? seconds(req.approvalRequestedAt, this.clock.now()) : null,
    }, 'operador', shift.operatorId);
    return this.stamp(business, receptor, req);
  }

  private async requestApproval(business: Business, receptor: Receptor, req: InvoiceRequest): Promise<void> {
    const ticket = req.ticket!;
    await this.track('aprobacion_solicitada', business, req, receptor, 'C2', { motivo: req.approvalReason });
    const body = render('aprobacion', {
      negocio: business.name,
      nombre: receptor.fiscal!.legalName,
      rfc: receptor.fiscal!.rfc,
      folio: ticket.manual ? '(escrito a mano)' : ticket.folio,
      fecha: formatDate(ticket.date),
      total: formatMoney(ticket.total),
      motivo: APPROVAL_REASONS[req.approvalReason ?? 'modo'],
    });
    for (const phone of business.operatorPhones) {
      await this.wa.sendButtons(this.cfg.contaOpPhoneNumberId, phone, body, [
        { id: `aprobar:${req.id}`, title: 'Sí, facturar' },
        { id: `corregir:${req.id}`, title: 'Corregir' },
      ]);
    }
  }

  private async notifyOperatorStampError(business: Business, req: InvoiceRequest, field: string, detail: string) {
    const body = render('errorSatOperador', { folio: req.ticket?.folio ?? '', campo: field, detalle: detail });
    for (const phone of business.operatorPhones) {
      await this.wa.sendButtons(this.cfg.contaOpPhoneNumberId, phone, body, [
        { id: `corregir:${req.id}`, title: 'Corregir uso de CFDI' },
        { id: `soporte:${req.id}`, title: 'Hablar con soporte' },
      ]);
    }
  }

  private async sendFixFieldForm(business: Business, reqId: string, operatorPhone: string): Promise<void> {
    const req = await this.store.request(reqId);
    if (!req || req.businessId !== business.id) return;
    if (req.state !== 'corrigiendo' && req.state !== 'en_aprobacion') return;
    const receptor = await this.mustReceptorById(business, req);
    // C5: solo el campo que falla y sus opciones válidas por régimen.
    return this.wa.sendFlow(this.cfg.contaOpPhoneNumberId, operatorPhone, {
      flowId: this.cfg.fixFieldFlowId,
      flowToken: `campo:${req.id}`,
      cta: 'Corregir',
      body: 'Elige el uso de CFDI correcto para este receptor.',
      screen: 'CORREGIR_CAMPO',
      data: {
        usos: cfdiUsesFor(receptor.fiscal!.taxSystem).map((u) => ({ id: u.code, title: `${u.code} · ${u.name}` })),
        actual: req.cfdiUse ?? '',
      },
    });
  }

  private async applyFieldFix(business: Business, reqId: string, use: string, operatorPhone: string) {
    const req = await this.store.request(reqId);
    if (!req || req.businessId !== business.id) return;
    if (req.state !== 'corrigiendo' && req.state !== 'en_aprobacion') return;
    const receptor = await this.mustReceptorById(business, req);
    if (!isCfdiUseAllowed(use, receptor.fiscal!.taxSystem)) {
      return this.sendFixFieldForm(business, reqId, operatorPhone);
    }
    req.cfdiUse = use;
    await this.track('campo_corregido', business, req, receptor, 'C5', { campo: 'use' }, 'operador');
    if (req.state === 'corrigiendo') {
      req.stampAttempts += 1; // nueva idempotency_key para el reintento
      req.issuedBy = 'operador';
      return this.stamp(business, receptor, req);
    }
    await this.store.saveRequest(req);
    return this.approve(business, req.id, operatorPhone);
  }

  /** ER11: el operador escribió en ese chat desde la app; el bot se hace a un lado. */
  private async handleEcho(msg: Extract<Inbound, { kind: 'echo' }>): Promise<void> {
    const business = await this.store.businessByPhoneNumberId(msg.toPhoneNumberId);
    if (!business) return;
    await this.store.pauseBot(business.id, msg.to, new Date(this.clock.now().getTime() + this.cfg.botPauseMs));
    await this.analytics.track('bot_pausado', { negocio_id: business.id, rol: 'operador', canal: 'wa_negocio', pantalla: 'C1' }, {}, this.clock.now());
  }

  // ======================================================================
  // Utilidades
  // ======================================================================

  private async ensureReceptor(business: Business, phone: string): Promise<Receptor> {
    const existing = await this.store.receptor(business.id, phone);
    if (existing) return existing;
    const receptor: Receptor = {
      id: this.ids.next('rcp'),
      businessId: business.id,
      pseudoId: pseudonymize(phone, this.cfg.receptorSalt),
      phone,
    };
    await this.store.saveReceptor(receptor);
    return receptor;
  }

  private async mustBusiness(id: string): Promise<Business> {
    const b = await this.store.business(id);
    if (!b) throw new Error(`Negocio ${id} no existe`);
    return b;
  }

  private async mustReceptorById(business: Business, req: InvoiceRequest): Promise<Receptor> {
    const r = await this.store.receptorById(req.receptorId);
    if (!r || r.businessId !== business.id) throw new Error(`Receptor ${req.receptorId} no existe`);
    return r;
  }

  private say(business: Business, to: string, key: MessageKey, vars?: Record<string, string | number>) {
    return this.wa.sendText(business.waPhoneNumberId, to, render(key, vars));
  }

  private track(
    name: string,
    business: Business,
    req: InvoiceRequest,
    receptor: Receptor,
    screen: string,
    params: Record<string, unknown> = {},
    role: GlobalParams['rol'] = 'receptor',
    operatorId?: string,
  ) {
    const globals: GlobalParams = {
      negocio_id: business.id,
      solicitud_id: req.id,
      receptor_id: receptor.pseudoId,
      operador_id: operatorId ?? req.approvedByOperatorId,
      rol: role,
      canal: role === 'operador' ? 'wa_conta_operacion' : 'wa_negocio',
      pantalla: screen,
      modo_emision: req.rule.mode,
      regla_version: req.rule.version,
    };
    return this.analytics.track(name, globals, params, this.clock.now());
  }
}

const APPROVAL_REASONS: Record<NonNullable<InvoiceRequest['approvalReason']>, string> = {
  monto: 'monto arriba del máximo',
  antiguedad: 'ticket más viejo de lo permitido',
  modo: 'el negocio aprueba todas las facturas',
  folio_repetido: 'ese folio ya se facturó',
  csd_vencido: 'el CSD está vencido',
  captura_manual: 'el cliente escribió el total a mano',
};

const CSF_REJECTION_MESSAGES: Record<CsfRejection, MessageKey> = {
  protegida: 'csfProtegida',
  contribuyente_inactivo: 'csfInactiva',
  sin_regimen: 'ER13',
};

function satErrorMessage(error: SatValidationError): MessageKey {
  const p = error.path;
  if (p.includes('legal_name')) return 'ER14';
  if (p.includes('zip')) return 'ER15';
  if (p.includes('tax_system')) return 'ER17';
  if (p.includes('tax_id')) return 'ER16';
  return 'validacionGenerica';
}

function checkFiscalLocally(f: FiscalData): MessageKey | null {
  if (!isValidRfc(f.rfc)) return 'ER16';
  if (!isValidZip(f.zip)) return 'ER15';
  if (!isTaxSystemAllowedForRfc(f.taxSystem, f.rfc)) return 'ER17';
  if (f.legalName.trim().length < 2) return 'ER14';
  return null;
}

function parseFiscalForm(response: Record<string, unknown>): FiscalData {
  return {
    rfc: normalizeRfc(String(response['rfc'] ?? '')),
    legalName: String(response['nombre'] ?? '').trim().toUpperCase(),
    zip: String(response['cp'] ?? '').trim(),
    taxSystem: String(response['regimen'] ?? '').trim(),
  };
}

function partialFiscal(r: { rfc: string | null; legalName: string | null; zip: string | null; taxSystem: string | null }) {
  return {
    rfc: r.rfc ? normalizeRfc(r.rfc) : undefined,
    legalName: r.legalName ?? undefined,
    zip: r.zip ?? undefined,
    taxSystem: r.taxSystem ?? undefined,
  };
}

/** «$1,250.50», «1250.5», «1 250» → 1250.5. */
export function parseAmount(text: string): number | null {
  const m = text.replace(/\s/g, '').match(/\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const value = Number(`${m[1]!.replace(/,/g, '')}.${m[2] ?? '0'}`);
  return value > 0 ? value : null;
}

function seconds(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 1000);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
