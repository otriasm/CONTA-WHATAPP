// Store en memoria para desarrollo local y pruebas. Producción: Postgres (db/migrations) + Redis.

import type {
  Business,
  Invoice,
  InvoiceRequest,
  Operator,
  Receptor,
  Shift,
} from '../../domain/types.js';
import type { Store } from '../../ports.js';

const CLOSED: InvoiceRequest['state'][] = ['entregada', 'abandonada'];

export class MemoryStore implements Store {
  readonly businesses = new Map<string, Business>();
  readonly operatorList: Operator[] = [];
  readonly shifts = new Map<string, Shift>();
  readonly receptors = new Map<string, Receptor>();
  readonly requests = new Map<string, InvoiceRequest>();
  readonly folios = new Map<string, { requestId: string; at: Date }>();
  readonly invoices: Invoice[] = [];
  readonly pauses = new Map<string, Date>();
  readonly seen = new Set<string>();

  async businessByPhoneNumberId(phoneNumberId: string) {
    return [...this.businesses.values()].find((b) => b.waPhoneNumberId === phoneNumberId);
  }
  async business(id: string) {
    return this.businesses.get(id);
  }
  async businessByOperatorPhone(phone: string) {
    return [...this.businesses.values()].find((b) => b.operatorPhones.includes(phone));
  }

  async operators(businessId: string) {
    return this.operatorList.filter((o) => o.businessId === businessId);
  }
  async openShift(businessId: string) {
    return this.shifts.get(businessId);
  }
  async setShift(shift: Shift) {
    this.shifts.set(shift.businessId, shift);
  }

  async receptor(businessId: string, phone: string) {
    return [...this.receptors.values()].find((r) => r.businessId === businessId && r.phone === phone);
  }
  async receptorById(id: string) {
    return this.receptors.get(id);
  }
  async saveReceptor(receptor: Receptor) {
    this.receptors.set(receptor.id, structuredClone(receptor));
  }

  async openRequest(businessId: string, receptorId: string) {
    const found = [...this.requests.values()].find(
      (r) => r.businessId === businessId && r.receptorId === receptorId && !CLOSED.includes(r.state),
    );
    return found && structuredClone(found);
  }
  async openRequestsForBusiness(businessId: string) {
    return [...this.requests.values()]
      .filter((r) => r.businessId === businessId && !CLOSED.includes(r.state))
      .map((r) => structuredClone(r));
  }
  async request(id: string) {
    const r = this.requests.get(id);
    return r && structuredClone(r);
  }
  async saveRequest(request: InvoiceRequest) {
    this.requests.set(request.id, structuredClone(request));
  }

  async folioInvoicedAt(businessId: string, folio: string) {
    return this.folios.get(`${businessId}:${folio}`)?.at;
  }
  async registerFolio(businessId: string, folio: string, requestId: string, at: Date) {
    this.folios.set(`${businessId}:${folio}`, { requestId, at });
  }

  async saveInvoice(invoice: Invoice) {
    this.invoices.push(structuredClone(invoice));
  }
  async lastInvoice(businessId: string, receptorId: string) {
    return this.invoices
      .filter((i) => i.businessId === businessId && i.receptorId === receptorId && i.status === 'valid')
      .at(-1);
  }

  async pauseBot(businessId: string, receptorPhone: string, until: Date) {
    this.pauses.set(`${businessId}:${receptorPhone}`, until);
  }
  async botPausedUntil(businessId: string, receptorPhone: string) {
    return this.pauses.get(`${businessId}:${receptorPhone}`);
  }

  async markSeen(eventId: string) {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
}
