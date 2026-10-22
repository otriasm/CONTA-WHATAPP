import { describe, expect, it } from 'vitest';
import { quickIntent } from '../src/adapters/ai/claudeReader.js';
import {
  cfdiUsesFor,
  defaultCfdiUse,
  isTaxSystemAllowedForRfc,
  itemTaxes,
  IVA_WITHHOLDING_TWO_THIRDS,
  RESICO_ISR_WITHHOLDING,
} from '../src/domain/fiscal.js';
import { isValidRfc, personType } from '../src/domain/rfc.js';
import { decideEmission, ticketAgeDays } from '../src/domain/rules.js';
import { formatDate, render } from '../src/messages/catalog.js';
import { parseAmount } from '../src/orchestrator/orchestrator.js';

describe('RFC', () => {
  it('distingue persona física y moral', () => {
    expect(personType('PEGJ800101AB1')).toBe('fisica');
    expect(personType('CAM190314K82')).toBe('moral');
    expect(personType('pegj-800101-ab1')).toBe('fisica');
    expect(personType('ABC')).toBeNull();
  });

  it('rechaza fechas imposibles', () => {
    expect(isValidRfc('PEGJ801301AB1')).toBe(false);
    expect(isValidRfc('PEGJ800132AB1')).toBe(false);
    expect(isValidRfc('XAXX010101000')).toBe(true);
  });
});

describe('Motor fiscal', () => {
  it('P10: un receptor 605 solo ve S01, D01 a D10 y CN01; nunca G03', () => {
    const codes = cfdiUsesFor('605').map((u) => u.code);
    expect(codes).toContain('S01');
    expect(codes).toContain('D01');
    expect(codes).toContain('D10');
    expect(codes).toContain('CN01');
    expect(codes).not.toContain('G03');
    expect(defaultCfdiUse('605')).toBe('S01');
    expect(defaultCfdiUse('612')).toBe('G03');
  });

  it('ER17: el régimen debe corresponder al tipo de persona', () => {
    expect(isTaxSystemAllowedForRfc('605', 'PEGJ800101AB1')).toBe(true);
    expect(isTaxSystemAllowedForRfc('601', 'PEGJ800101AB1')).toBe(false);
    expect(isTaxSystemAllowedForRfc('601', 'CAM190314K82')).toBe(true);
    expect(isTaxSystemAllowedForRfc('626', 'CAM190314K82')).toBe(true);
  });

  it('IVA 16% sin retenciones entre personas morales', () => {
    expect(
      itemTaxes({ issuerRfc: 'CAM190314K82', issuerTaxSystem: '601', receptorRfc: 'XYZ010101AB1', kind: 'bienes' }),
    ).toEqual([{ type: 'IVA', rate: 0.16 }]);
  });

  it('RESICO persona física que presta servicios a una empresa retiene ISR 1.25% y 2/3 del IVA', () => {
    expect(
      itemTaxes({ issuerRfc: 'PEGJ800101AB1', issuerTaxSystem: '626', receptorRfc: 'CAM190314K82', kind: 'servicios' }),
    ).toEqual([
      { type: 'IVA', rate: 0.16 },
      { type: 'ISR', rate: RESICO_ISR_WITHHOLDING, withholding: true },
      { type: 'IVA', rate: IVA_WITHHOLDING_TWO_THIRDS, withholding: true },
    ]);
  });

  it('RESICO que vende bienes a una empresa solo retiene ISR', () => {
    expect(
      itemTaxes({ issuerRfc: 'PEGJ800101AB1', issuerTaxSystem: '626', receptorRfc: 'CAM190314K82', kind: 'bienes' }),
    ).toEqual([
      { type: 'IVA', rate: 0.16 },
      { type: 'ISR', rate: RESICO_ISR_WITHHOLDING, withholding: true },
    ]);
  });
});

describe('Reglas de emisión', () => {
  const rule = { version: 1, mode: 'automatico' as const, maxAmount: 2000, maxTicketAgeDays: 3 };
  const now = new Date('2026-10-22T18:00:00Z');
  const tz = 'America/Mexico_City';
  const ticket = { total: 500, date: '2026-10-22', folio: 'A1' };

  it('timbra solo cuando todo está dentro de la regla', () => {
    expect(decideEmission({ rule, ticket, now, timezone: tz, folioAlreadyInvoiced: false })).toEqual({ action: 'timbrar' });
  });

  it.each([
    ['monto', { ticket: { ...ticket, total: 2000.01 } }],
    ['antiguedad', { ticket: { ...ticket, date: '2026-10-18' } }],
    ['modo', { rule: { ...rule, mode: 'aprobacion' as const } }],
    ['folio_repetido', { folioAlreadyInvoiced: true }],
    ['captura_manual', { ticket: { ...ticket, manual: true } }],
  ])('pasa a aprobación por %s', (reason, override) => {
    expect(
      decideEmission({ rule, ticket, now, timezone: tz, folioAlreadyInvoiced: false, ...override }),
    ).toEqual({ action: 'aprobar', reason });
  });

  it('cuenta los días en la zona horaria del negocio', () => {
    // 22 oct 03:00 UTC todavía es 21 oct en Ciudad de México
    expect(ticketAgeDays('2026-10-21', new Date('2026-10-22T03:00:00Z'), tz)).toBe(0);
    expect(ticketAgeDays('2026-10-18', now, tz)).toBe(4);
  });
});

describe('Intérprete: atajos sin llamar al modelo', () => {
  it.each([
    ['Hola, quiero factura', 'pedir_factura'],
    ['me puedes facturar mi consumo?', 'pedir_factura'],
    ['mi factura', 'reenviar_factura'],
    ['me reenvías mi factura?', 'reenviar_factura'],
    ['no tengo mi constancia', 'sin_csf'],
    ['¿A qué hora abren?', null],
  ])('«%s» → %s', (text, expected) => {
    expect(quickIntent(text)).toBe(expected);
  });
});

describe('Utilidades de mensajes', () => {
  it('interpola variables y deja visibles las faltantes', () => {
    expect(render('ER23', { negocio: 'Café Ámbar' })).toContain('consumos de Café Ámbar');
    expect(render('ER23')).toContain('{negocio}');
  });

  it('formatea fechas cortas en español', () => {
    expect(formatDate('2026-10-22')).toBe('22 oct');
  });

  it('lee montos escritos por el receptor', () => {
    expect(parseAmount('fueron $1,250.50')).toBe(1250.5);
    expect(parseAmount('350')).toBe(350);
    expect(parseAmount('no sé')).toBeNull();
  });
});
