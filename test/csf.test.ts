import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { CsfFirstReader } from '../src/adapters/csf/csfFirstReader.js';
import { FakeReader } from './fakes.js';
import { FICTITIOUS_CSF, syntheticCsfPdf } from './fixtures/csf.js';

function reader() {
  const fallback = new FakeReader();
  const fallbacks: string[] = [];
  let aiCalls = 0;
  const original = fallback.readCsf.bind(fallback);
  fallback.readCsf = async () => {
    aiCalls += 1;
    return original();
  };
  const csfReader = new CsfFirstReader(fallback, undefined, (code) => fallbacks.push(code));
  return { csfReader, fallbacks, aiCalls: () => aiCalls };
}

describe('Lector de CSF con fiscalapi-csf', () => {
  it('lee un PDF con texto sin llamar a la IA y no expone la CURP', async () => {
    const { csfReader, aiCalls } = reader();
    const reading = await csfReader.readCsf(await syntheticCsfPdf());
    expect(reading).toMatchObject({
      rfc: 'PEGJ800101AB1',
      legalName: 'JUAN PEREZ GOMEZ',
      zip: '06700',
      taxSystem: '605',
      taxSystems: ['605'],
      confidence: 1,
      source: 'lector_csf',
    });
    expect(JSON.stringify(reading)).not.toContain(FICTITIOUS_CSF.curp);
    expect(aiCalls()).toBe(0);
  });

  it('devuelve todos los regímenes vigentes y descarta los que ya terminaron', async () => {
    const { csfReader } = reader();
    const pdf = await syntheticCsfPdf({
      ...FICTITIOUS_CSF,
      regimes: [
        'Régimen de Sueldos y Salarios e Ingresos Asimilados a Salarios 01/01/2010',
        'Régimen de Incorporación Fiscal 01/01/2015 31/12/2021',
        'Régimen Simplificado de Confianza 01/01/2022',
      ],
    });
    const reading = await csfReader.readCsf(pdf);
    expect(reading.taxSystems).toEqual(['605', '626']);
  });

  it('acepta el estatus REACTIVADO (P8) y rechaza un contribuyente inactivo sin pasar a la IA', async () => {
    const { csfReader, aiCalls } = reader();
    const reactivated = await csfReader.readCsf(await syntheticCsfPdf({ ...FICTITIOUS_CSF, status: 'REACTIVADO' }));
    expect(reactivated.source).toBe('lector_csf');
    expect(reactivated.rejection).toBeUndefined();

    const inactive = await csfReader.readCsf(await syntheticCsfPdf({ ...FICTITIOUS_CSF, status: 'SUSPENDIDO' }));
    expect(inactive.rejection).toBe('contribuyente_inactivo');
    expect(aiCalls()).toBe(0);
  });

  it('un PDF que no es una CSF pasa a la IA de respaldo', async () => {
    const { csfReader, fallbacks, aiCalls } = reader();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText('Factura de luz, periodo de septiembre', { x: 40, y: 700, size: 12, font });
    doc.setKeywords(['x'.repeat(12_000)]);
    const reading = await csfReader.readCsf(Buffer.from(await doc.save({ useObjectStreams: false })));
    expect(fallbacks).toEqual(['not-a-csf']);
    expect(aiCalls()).toBe(1);
    expect(reading.source).toBe('ia');
  });

  it('una CSF de una sola hoja también pasa a la IA, que detecta que falta el régimen', async () => {
    const { csfReader, fallbacks } = reader();
    await csfReader.readCsf(await syntheticCsfPdf({ ...FICTITIOUS_CSF, includePage2: false }));
    expect(fallbacks).toEqual(['not-a-csf']);
  });

  it('un archivo demasiado chico para ser CSF pasa a la IA', async () => {
    const { csfReader, fallbacks } = reader();
    await csfReader.readCsf(Buffer.from('%PDF-1.4 casi vacío'));
    expect(fallbacks).toEqual(['file-too-small']);
  });
});
