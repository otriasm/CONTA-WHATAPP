// Lector de la CSF en dos pasos: primero `fiscalapi-csf` (determinista, gratis y en milisegundos);
// si el PDF no se puede leer así (escaneo, formato raro), la IA de respaldo.
// Los tickets y la intención siempre van a la IA.

import { extractPdfLines, parseCsf, readCsfFileBytes } from 'fiscalapi-csf';
import type { CsfReading, CsfRejection, FiscalReader, Intent, TicketReading } from '../../ports.js';

export type LineExtractor = (pdf: Buffer) => Promise<string[]>;

/** Códigos de `fiscalapi-csf` en los que la IA no ayuda: la constancia no sirve para facturar. */
const REJECTIONS: Record<string, CsfRejection> = {
  'password-protected': 'protegida',
  'inactive-taxpayer': 'contribuyente_inactivo',
  'missing-regimes-section': 'sin_regimen',
  'no-active-regimes': 'sin_regimen',
};

export class CsfFirstReader implements FiscalReader {
  constructor(
    private readonly fallback: FiscalReader,
    private readonly extractLines: LineExtractor = extractWithPdfJs,
    private readonly onFallback: (code: string) => void = () => {},
  ) {}

  classifyIntent(text: string, businessName: string): Promise<Intent> {
    return this.fallback.classifyIntent(text, businessName);
  }

  readTicket(image: Buffer, mimeType: string, businessName: string): Promise<TicketReading> {
    return this.fallback.readTicket(image, mimeType, businessName);
  }

  async readCsf(pdf: Buffer): Promise<CsfReading> {
    let lines: string[];
    try {
      lines = await this.extractLines(pdf);
      const csf = parseCsf(lines);
      const taxSystems = csf.activeRegimes.map((r) => r.code);
      // Solo salen RFC, nombre, CP y regímenes. CURP, idCIF y domicilio se quedan aquí (caso P4).
      return {
        rfc: csf.rfc,
        legalName: csf.legalName,
        zip: csf.zipCode,
        taxSystem: taxSystems[0] ?? null,
        taxSystems,
        pagesRead: 0,
        confidence: 1,
        source: 'lector_csf',
      };
    } catch (err) {
      const code = csfErrorCode(err);
      if (!code) throw err;
      const rejection = REJECTIONS[code];
      if (rejection) return rejected(rejection);
      this.onFallback(code);
      return this.fallback.readCsf(pdf);
    }
  }
}

/** Distingue por `name` y no por instanceof: puede haber una copia ESM y otra CJS del paquete. */
function csfErrorCode(err: unknown): string | null {
  return err instanceof Error && err.name === 'CsfValidationError' ? String((err as { code?: string }).code) : null;
}

function rejected(rejection: CsfRejection): CsfReading {
  return {
    rfc: null,
    legalName: null,
    zip: null,
    taxSystem: null,
    taxSystems: [],
    pagesRead: 0,
    confidence: 0,
    source: 'lector_csf',
    rejection,
  };
}

/** En Node se usa la build legacy de pdf.js; se carga solo la primera vez que llega una CSF. */
async function extractWithPdfJs(pdf: Buffer): Promise<string[]> {
  const bytes = await readCsfFileBytes(new File([new Uint8Array(pdf)], 'constancia.pdf', { type: 'application/pdf' }));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return extractPdfLines(pdfjs, bytes);
}
