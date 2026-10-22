import { describe, expect, it } from 'vitest';
import { FacturapiError } from '../src/adapters/facturapi/errors.js';
import { MESSAGES } from '../src/messages/catalog.js';
import { CLIENT, CONTA_OP_NUMBER, FISCAL, OPERATOR, setup } from './fakes.js';

const texts = (sent: { type: string; text?: string; body?: string }[]) =>
  sent.map((s) => s.text ?? s.body ?? '');

describe('Receptor: camino feliz (B1 → B5)', () => {
  it('pide factura, manda CSF y ticket, confirma y recibe PDF y XML', async () => {
    const t = setup();

    await t.client.text('Hola, quiero factura');
    expect(t.wa.last()).toMatchObject({ type: 'text', from: 'pn_negocio', to: CLIENT });
    expect(texts(t.wa.take())[0]).toContain('asistente de facturación de Café Ámbar');

    await t.client.file('application/pdf');
    const card = t.wa.take()[0]!;
    expect(card.type).toBe('buttons');
    expect(texts([card])[0]).toContain('RFC: PEGJ800101AB1');
    expect(texts([card])[0]).toContain('612 · Personas Físicas con Actividades Empresariales');

    const req = [...t.store.requests.values()][0]!;
    await t.client.button(`datos_ok:${req.id}`);
    expect(texts(t.wa.take())).toEqual([MESSAGES.pideTicket]);

    await t.client.file('image/jpeg', 'image');
    const summary = t.wa.take()[0]!;
    expect(summary.type).toBe('buttons');
    expect(texts([summary])[0]).toMatch(/Total: \$350\.00/);
    expect(texts([summary])[0]).toContain('Uso: G03 · Gastos en general');

    await t.client.button(`facturar:${req.id}`);
    const delivered = t.wa.take();
    expect(delivered.map((s) => s.type)).toEqual(['document', 'document']);
    expect(delivered.every((s) => s.to === CLIENT && s.from === 'pn_negocio')).toBe(true);

    expect(t.facturapi.invoiceCalls).toHaveLength(1);
    const call = t.facturapi.invoiceCalls[0]!;
    expect(call.idempotencyKey).toBe(`${req.id}-0`);
    expect(call.input).toMatchObject({ use: 'G03', paymentForm: '04', externalId: req.id });
    expect(call.input.items[0]!.product).toMatchObject({ price: 350, tax_included: true, product_key: '90101501' });

    const final = t.store.requests.get(req.id)!;
    expect(final.state).toBe('entregada');
    expect(final.issuedBy).toBe('automatico');
    expect(await t.store.folioInvoicedAt('neg_1', 'A-1001')).toBeDefined();
  });

  it('manda eventos de analítica sin datos personales', async () => {
    const t = setup();
    const reqId = await t.untilSummary();
    await t.client.button(`facturar:${reqId}`);

    const names = t.sink.events.map((e) => e.nombre);
    expect(names).toEqual([
      'solicitud_iniciada',
      'csf_recibida',
      'csf_leida',
      'validacion_sat_aprobada',
      'ticket_recibido',
      'ticket_leido',
      'resumen_confirmado',
      'factura_timbrada',
      'factura_entregada',
    ]);
    const serialized = JSON.stringify(t.sink.events);
    expect(serialized).not.toContain(FISCAL.rfc);
    expect(serialized).not.toContain(FISCAL.legalName);
    expect(serialized).not.toContain(CLIENT);
    expect(t.sink.events.every((e) => e.ambiente === 'test' && e.regla_version === 3)).toBe(true);
  });

  it('P13: el receptor que regresa confirma sus datos con un botón', async () => {
    const t = setup();
    const first = await t.untilSummary();
    await t.client.button(`facturar:${first}`);
    t.wa.take();

    t.reader.ticket = { ...t.reader.ticket, folio: 'A-1002' };
    await t.client.text('otra factura por favor');
    const ask = t.wa.take()[0]!;
    expect(texts([ask])[0]).toBe('¿Facturo con los datos de JUAN PEREZ GOMEZ?');

    const second = [...t.store.requests.values()].at(-1)!;
    await t.client.button(`conocido_si:${second.id}`);
    expect(texts(t.wa.take())).toEqual([MESSAGES.pideTicket]);
  });

  it('una solicitud repetida por el webhook se procesa una sola vez', async () => {
    const t = setup();
    const msg = { id: 'wamid.dup', at: t.clock.now(), kind: 'text' as const, from: CLIENT, toPhoneNumberId: 'pn_negocio', text: 'quiero factura' };
    await t.orchestrator.handle(msg);
    await t.orchestrator.handle(msg);
    expect(t.wa.sent).toHaveLength(1);
    expect(t.store.requests.size).toBe(1);
  });
});

describe('Receptor: casos alternos', () => {
  it('ER10: un mensaje que no es para facturar no recibe respuesta', async () => {
    const t = setup();
    await t.client.text('¿A qué hora abren mañana?');
    expect(t.wa.sent).toHaveLength(0);
    expect(t.store.requests.size).toBe(0);
  });

  it('ER12: un Word en lugar de la CSF', async () => {
    const t = setup();
    await t.client.text('quiero factura');
    t.wa.take();
    await t.client.file('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(texts(t.wa.take())).toEqual(['Ese archivo es un documento de Word. Mándame tu constancia en PDF.']);
  });

  it('ER13: la CSF trae una sola página y no se ve el régimen', async () => {
    const t = setup();
    t.reader.csf = { ...t.reader.csf, taxSystem: null, pagesRead: 1 };
    await t.client.text('quiero factura');
    t.wa.take();
    await t.client.file('application/pdf');
    expect(texts(t.wa.take())).toEqual([MESSAGES.ER13]);
  });

  it('D2: sin CSF abre el formulario y valida localmente el régimen (ER17)', async () => {
    const t = setup();
    await t.client.text('no tengo mi constancia, quiero factura');
    const form = t.wa.take()[0]!;
    expect(form).toMatchObject({ type: 'flow', flow: { flowId: 'flow_datos' } });
    const req = [...t.store.requests.values()][0]!;

    // 601 es de persona moral; el RFC es de persona física
    await t.client.flow(`datos:${req.id}`, { rfc: FISCAL.rfc, nombre: FISCAL.legalName, cp: FISCAL.zip, regimen: '601' });
    const [err, again] = t.wa.take();
    expect(texts([err!])).toEqual([MESSAGES.ER17]);
    expect(again!.type).toBe('flow');

    await t.client.flow(`datos:${req.id}`, { rfc: FISCAL.rfc, nombre: FISCAL.legalName, cp: FISCAL.zip, regimen: '612' });
    expect(texts(t.wa.take())).toEqual([MESSAGES.pideTicket]);
  });

  it('ER14: el nombre no coincide con el SAT y se reabre el formulario', async () => {
    const t = setup();
    t.facturapi.validationErrors = [{ path: 'legal_name', message: 'El nombre no coincide' }];
    await t.client.text('quiero factura');
    await t.client.file('application/pdf');
    const req = [...t.store.requests.values()][0]!;
    t.wa.take();

    await t.client.button(`datos_ok:${req.id}`);
    const [err, form] = t.wa.take();
    expect(texts([err!])).toEqual([MESSAGES.ER14]);
    expect(form).toMatchObject({ type: 'flow', flow: { data: { nombre: FISCAL.legalName } } });
    expect(t.sink.events.find((e) => e.nombre === 'validacion_sat_rechazada')).toMatchObject({ intento_n: 1 });
  });

  it('ER19: un Excel en lugar de la foto del ticket', async () => {
    const t = setup();
    await t.client.text('quiero factura');
    await t.client.file('application/pdf');
    const req = [...t.store.requests.values()][0]!;
    await t.client.button(`datos_ok:${req.id}`);
    t.wa.take();
    await t.client.file('application/vnd.ms-excel');
    expect(texts(t.wa.take())).toEqual(['Ese archivo es una hoja de Excel, no una foto. Mándame una foto del ticket.']);
  });

  it('ER18: foto ilegible; el total escrito a mano pasa a aprobación', async () => {
    const t = setup();
    t.reader.ticket = { ...t.reader.ticket, total: null, confidence: 0.2 };
    await t.client.text('quiero factura');
    await t.client.file('application/pdf');
    const req = [...t.store.requests.values()][0]!;
    await t.client.button(`datos_ok:${req.id}`);
    await t.client.file('image/jpeg', 'image');
    expect(texts(t.wa.take()).at(-1)).toBe(MESSAGES.ER18);

    await t.client.text('fueron $1,250.50');
    expect(texts(t.wa.take())[0]).toMatch(/Total: \$1,250\.50/);

    await t.client.button(`facturar:${req.id}`);
    expect(t.facturapi.invoiceCalls).toHaveLength(0);
    expect(t.store.requests.get(req.id)!.approvalReason).toBe('captura_manual');
  });

  it('ER23: ticket de otro negocio', async () => {
    const t = setup();
    t.reader.ticket = { ...t.reader.ticket, matchesBusiness: false };
    await t.client.text('quiero factura');
    await t.client.file('application/pdf');
    const req = [...t.store.requests.values()][0]!;
    await t.client.button(`datos_ok:${req.id}`);
    t.wa.take();
    await t.client.file('image/jpeg', 'image');
    expect(texts(t.wa.take())).toEqual(['Este ticket parece de otro negocio. Solo puedo facturar consumos de Café Ámbar.']);
  });

  it('«Corregir» en el resumen reabre los datos y vuelve al resumen sin pedir otra vez el ticket', async () => {
    const t = setup();
    const reqId = await t.untilSummary();
    t.wa.take();
    await t.client.button(`corregir:${reqId}`);
    expect(t.wa.take()[0]!.type).toBe('flow');
    await t.client.flow(`datos:${reqId}`, { rfc: FISCAL.rfc, nombre: FISCAL.legalName, cp: '06600', regimen: '612' });
    const summary = t.wa.take()[0]!;
    expect(summary.type).toBe('buttons');
    expect(texts([summary])[0]).toContain('Resumen de tu factura');
  });
});

describe('Reglas de emisión y operador (C2–C5)', () => {
  it('ER22: arriba del máximo pasa a aprobación; ER26 pide el turno; luego timbra y entrega a los dos chats', async () => {
    const t = setup();
    t.reader.ticket = { ...t.reader.ticket, total: 2500 };
    const reqId = await t.untilSummary();
    t.wa.take();

    await t.client.button(`facturar:${reqId}`);
    const sent = t.wa.take();
    expect(texts(sent.filter((s) => s.to === CLIENT))).toEqual([MESSAGES.ER22]);
    const approval = sent.find((s) => s.to === OPERATOR)!;
    expect(approval).toMatchObject({ type: 'buttons', from: CONTA_OP_NUMBER });
    expect(texts([approval])[0]).toContain('Motivo: monto arriba del máximo');

    await t.operator.button(`aprobar:${reqId}`);
    const ask = t.wa.take()[0]!;
    expect(texts([ask])).toEqual([MESSAGES.quienEnCaja]);
    expect(ask).toMatchObject({ buttons: [{ id: `turno:op_ana:${reqId}`, title: 'Ana' }] });

    await t.operator.button(`turno:op_ana:${reqId}`);
    const delivered = t.wa.take();
    expect(delivered.filter((s) => s.to === CLIENT && s.type === 'document')).toHaveLength(2);
    expect(delivered.filter((s) => s.to === OPERATOR && s.type === 'document')).toHaveLength(1);
    const req = t.store.requests.get(reqId)!;
    expect(req).toMatchObject({ state: 'entregada', issuedBy: 'operador', approvedByOperatorId: 'op_ana' });

    // ER29: un segundo toque no crea otra factura
    await t.operator.button(`aprobar:${reqId}`);
    expect(t.facturapi.invoiceCalls).toHaveLength(1);
  });

  it('ER20: un folio que ya se facturó no se timbra', async () => {
    const t = setup();
    await t.store.registerFolio('neg_1', 'A-1001', 'sol_viejo', new Date('2026-10-20T15:00:00Z'));
    const reqId = await t.untilSummary();
    t.wa.take();
    await t.client.button(`facturar:${reqId}`);
    expect(texts(t.wa.to(CLIENT))).toEqual(['Ese ticket ya se facturó el 20 oct. El negocio lo va a revisar.']);
    expect(t.facturapi.invoiceCalls).toHaveLength(0);
  });

  it('ER21: ticket más viejo de lo permitido', async () => {
    const t = setup();
    t.reader.ticket = { ...t.reader.ticket, date: '2026-10-15' };
    const reqId = await t.untilSummary();
    t.wa.take();
    await t.client.button(`facturar:${reqId}`);
    expect(texts(t.wa.to(CLIENT))).toEqual(['Tu ticket es del 15 oct. El negocio tiene que aprobarlo.']);
  });

  it('ER27: el SAT rechaza el uso de CFDI; el operador lo corrige y se reintenta con otra llave', async () => {
    const t = setup();
    t.facturapi.invoiceResults = [
      new FacturapiError('El uso de CFDI no corresponde al régimen', 400, 'invoice_stamping_validation_error', undefined, [
        { path: 'use', message: 'CFDI40161', source: 'sat' },
      ]),
      { id: 'inv_2', uuid: 'UUID-0002', status: 'valid', total: 0 },
    ];
    const reqId = await t.untilSummary();
    t.wa.take();

    await t.client.button(`facturar:${reqId}`);
    const sent = t.wa.take();
    expect(texts(sent.filter((s) => s.to === CLIENT))).toEqual([MESSAGES.enRevision]);
    const opMsg = sent.find((s) => s.to === OPERATOR)!;
    expect(texts([opMsg])[0]).toContain('Qué falla: el uso de CFDI');
    expect(t.store.requests.get(reqId)!.state).toBe('corrigiendo');

    await t.operator.button(`corregir:${reqId}`);
    const form = t.wa.take()[0]!;
    expect(form).toMatchObject({ type: 'flow', flow: { flowId: 'flow_campo' } });

    await t.operator.flow(`campo:${reqId}`, { uso_cfdi: 'G01' });
    expect(t.facturapi.invoiceCalls.map((c) => c.idempotencyKey)).toEqual([`${reqId}-0`, `${reqId}-1`]);
    expect(t.facturapi.invoiceCalls[1]!.input.use).toBe('G01');
    expect(t.store.requests.get(reqId)!.state).toBe('entregada');
  });

  it('ER28: si Facturapi no responde, avisa una vez y reintenta con la misma llave', async () => {
    const t = setup();
    t.facturapi.invoiceResults = [
      new FacturapiError('Service unavailable', 503),
      { id: 'inv_3', uuid: 'UUID-0003', status: 'valid', total: 0 },
    ];
    const reqId = await t.untilSummary();
    t.wa.take();

    await t.client.button(`facturar:${reqId}`);
    expect(texts(t.wa.take())).toEqual([MESSAGES.enProceso]);
    expect(t.scheduler.jobs).toHaveLength(1);

    await t.scheduler.runAll();
    expect(t.facturapi.invoiceCalls.map((c) => c.idempotencyKey)).toEqual([`${reqId}-0`, `${reqId}-0`]);
    expect(t.wa.take().map((s) => s.type)).toEqual(['document', 'document']);
  });

  it('ER11: si el operador escribe desde la app, el bot se pausa en ese chat', async () => {
    const t = setup();
    await t.operator.echo(CLIENT);
    await t.client.text('quiero factura');
    expect(t.wa.sent).toHaveLength(0);

    t.clock.current = new Date(t.clock.current.getTime() + 3 * 60 * 60 * 1000);
    await t.client.text('quiero factura');
    expect(t.wa.sent).toHaveLength(1);
  });

  it('modo aprobación: toda factura pasa por el operador aunque esté abajo del máximo', async () => {
    const t = setup({ rule: { version: 4, mode: 'aprobacion', maxAmount: 2000, maxTicketAgeDays: 3 } });
    const reqId = await t.untilSummary();
    await t.client.button(`facturar:${reqId}`);
    expect(t.store.requests.get(reqId)!.approvalReason).toBe('modo');
    expect(t.facturapi.invoiceCalls).toHaveLength(0);
  });

  it('cambiar el modo no afecta una solicitud abierta (regla fijada al abrir)', async () => {
    const t = setup();
    const reqId = await t.untilSummary();
    t.business.rule = { version: 4, mode: 'aprobacion', maxAmount: 2000, maxTicketAgeDays: 3 };
    await t.client.button(`facturar:${reqId}`);
    expect(t.store.requests.get(reqId)!.state).toBe('entregada');
  });
});

describe('Reenvío y ventana de 24 h', () => {
  it('ER35: «mi factura» sin facturas antes', async () => {
    const t = setup();
    await t.client.text('mi factura');
    expect(texts(t.wa.take())).toEqual(['Aún no tienes facturas con Café Ámbar. ¿Quieres pedir una?']);
  });

  it('P15: «mi factura» reenvía el PDF y el XML de la última', async () => {
    const t = setup();
    const reqId = await t.untilSummary();
    await t.client.button(`facturar:${reqId}`);
    t.wa.take();
    await t.client.text('mi factura');
    expect(t.wa.take().map((s) => s.type)).toEqual(['document', 'document']);
  });

  it('ER33: si pasaron más de 24 h, la factura llega como plantilla', async () => {
    const t = setup();
    t.reader.ticket = { ...t.reader.ticket, total: 2500 };
    const reqId = await t.untilSummary();
    await t.client.button(`facturar:${reqId}`);
    await t.store.setShift({ businessId: 'neg_1', operatorId: 'op_ana', openedAt: t.clock.now() });
    t.wa.take();

    t.clock.current = new Date(t.clock.current.getTime() + 25 * 60 * 60 * 1000);
    await t.operator.button(`aprobar:${reqId}`);
    const toClient = t.wa.take().filter((s) => s.to === CLIENT);
    expect(toClient).toHaveLength(1);
    expect(toClient[0]).toMatchObject({ type: 'template', template: { name: 'tu_factura_lista' } });
  });
});
