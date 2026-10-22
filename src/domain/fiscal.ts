// Motor fiscal: regímenes, usos de CFDI válidos por régimen e impuestos por concepto.
// Catálogos c_RegimenFiscal y c_UsoCFDI del SAT (CFDI 4.0).
// ⚠️ Las retenciones de RESICO están pendientes de confirmar con un contador (nota del lienzo).

import { personType, type PersonType } from './rfc.js';
import type { ProductConfig } from './types.js';

export interface TaxSystem {
  code: string;
  name: string;
  fisica: boolean;
  moral: boolean;
}

export const TAX_SYSTEMS: TaxSystem[] = [
  { code: '601', name: 'General de Ley Personas Morales', fisica: false, moral: true },
  { code: '603', name: 'Personas Morales con Fines no Lucrativos', fisica: false, moral: true },
  { code: '605', name: 'Sueldos y Salarios e Ingresos Asimilados a Salarios', fisica: true, moral: false },
  { code: '606', name: 'Arrendamiento', fisica: true, moral: false },
  { code: '607', name: 'Régimen de Enajenación o Adquisición de Bienes', fisica: true, moral: false },
  { code: '608', name: 'Demás ingresos', fisica: true, moral: false },
  { code: '610', name: 'Residentes en el Extranjero sin Establecimiento Permanente en México', fisica: true, moral: true },
  { code: '611', name: 'Ingresos por Dividendos (socios y accionistas)', fisica: true, moral: false },
  { code: '612', name: 'Personas Físicas con Actividades Empresariales y Profesionales', fisica: true, moral: false },
  { code: '614', name: 'Ingresos por intereses', fisica: true, moral: false },
  { code: '615', name: 'Régimen de los ingresos por obtención de premios', fisica: true, moral: false },
  { code: '616', name: 'Sin obligaciones fiscales', fisica: true, moral: false },
  { code: '620', name: 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos', fisica: false, moral: true },
  { code: '621', name: 'Incorporación Fiscal', fisica: true, moral: false },
  { code: '622', name: 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras', fisica: false, moral: true },
  { code: '623', name: 'Opcional para Grupos de Sociedades', fisica: false, moral: true },
  { code: '624', name: 'Coordinados', fisica: false, moral: true },
  { code: '625', name: 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas', fisica: true, moral: false },
  { code: '626', name: 'Régimen Simplificado de Confianza', fisica: true, moral: true },
];

const BUSINESS_REGIMES = ['601', '603', '606', '612', '620', '621', '622', '623', '624', '625', '626'];
const DEDUCTION_REGIMES = ['605', '606', '608', '611', '612', '614', '607', '615', '625'];

export interface CfdiUse {
  code: string;
  name: string;
  regimes: string[];
}

// Uso P01 ya no existe en CFDI 4.0; CP01 solo aplica a complementos de pago y no se ofrece aquí.
export const CFDI_USES: CfdiUse[] = [
  { code: 'G01', name: 'Adquisición de mercancías', regimes: BUSINESS_REGIMES },
  { code: 'G02', name: 'Devoluciones, descuentos o bonificaciones', regimes: BUSINESS_REGIMES },
  { code: 'G03', name: 'Gastos en general', regimes: BUSINESS_REGIMES },
  { code: 'I01', name: 'Construcciones', regimes: BUSINESS_REGIMES },
  { code: 'I02', name: 'Mobiliario y equipo de oficina por inversiones', regimes: BUSINESS_REGIMES },
  { code: 'I03', name: 'Equipo de transporte', regimes: BUSINESS_REGIMES },
  { code: 'I04', name: 'Equipo de computo y accesorios', regimes: BUSINESS_REGIMES },
  { code: 'I05', name: 'Dados, troqueles, moldes, matrices y herramental', regimes: BUSINESS_REGIMES },
  { code: 'I06', name: 'Comunicaciones telefónicas', regimes: BUSINESS_REGIMES },
  { code: 'I07', name: 'Comunicaciones satelitales', regimes: BUSINESS_REGIMES },
  { code: 'I08', name: 'Otra maquinaria y equipo', regimes: BUSINESS_REGIMES },
  { code: 'D01', name: 'Honorarios médicos, dentales y gastos hospitalarios', regimes: DEDUCTION_REGIMES },
  { code: 'D02', name: 'Gastos médicos por incapacidad o discapacidad', regimes: DEDUCTION_REGIMES },
  { code: 'D03', name: 'Gastos funerales', regimes: DEDUCTION_REGIMES },
  { code: 'D04', name: 'Donativos', regimes: DEDUCTION_REGIMES },
  { code: 'D05', name: 'Intereses reales por créditos hipotecarios (casa habitación)', regimes: DEDUCTION_REGIMES },
  { code: 'D06', name: 'Aportaciones voluntarias al SAR', regimes: DEDUCTION_REGIMES },
  { code: 'D07', name: 'Primas por seguros de gastos médicos', regimes: DEDUCTION_REGIMES },
  { code: 'D08', name: 'Gastos de transportación escolar obligatoria', regimes: DEDUCTION_REGIMES },
  { code: 'D09', name: 'Depósitos en cuentas para el ahorro, primas de pensiones', regimes: DEDUCTION_REGIMES },
  { code: 'D10', name: 'Pagos por servicios educativos (colegiaturas)', regimes: DEDUCTION_REGIMES },
  { code: 'S01', name: 'Sin efectos fiscales', regimes: TAX_SYSTEMS.map((t) => t.code) },
  { code: 'CN01', name: 'Nómina', regimes: ['605'] },
];

export function taxSystemName(code: string): string | undefined {
  return TAX_SYSTEMS.find((t) => t.code === code)?.name;
}

const SHORT_NAMES: Record<string, string> = {
  '601': 'General PM',
  '603': 'No lucrativas',
  '605': 'Sueldos',
  '606': 'Arrendamiento',
  '607': 'Enajenación',
  '608': 'Demás ingresos',
  '610': 'Extranjero',
  '611': 'Dividendos',
  '612': 'Empresarial',
  '614': 'Intereses',
  '615': 'Premios',
  '616': 'Sin obligaciones',
  '620': 'Cooperativas',
  '621': 'RIF',
  '622': 'Agropecuario',
  '623': 'Grupos',
  '624': 'Coordinados',
  '625': 'Plataformas',
  '626': 'RESICO',
};

/** Nombre corto para un botón de WhatsApp (máx. 20 caracteres con la clave). */
export function taxSystemShortName(code: string): string {
  return SHORT_NAMES[code] ?? '';
}

/** Regímenes que puede tener un RFC según sea persona física o moral (ER17). */
export function taxSystemsFor(rfc: string): TaxSystem[] {
  const type = personType(rfc);
  if (!type) return [];
  return TAX_SYSTEMS.filter((t) => (type === 'fisica' ? t.fisica : t.moral));
}

export function isTaxSystemAllowedForRfc(taxSystem: string, rfc: string): boolean {
  return taxSystemsFor(rfc).some((t) => t.code === taxSystem);
}

/** Usos de CFDI válidos para el régimen del receptor (P10: un 605 no ve G03). */
export function cfdiUsesFor(taxSystem: string): CfdiUse[] {
  return CFDI_USES.filter((u) => u.regimes.includes(taxSystem));
}

export function isCfdiUseAllowed(use: string, taxSystem: string): boolean {
  return cfdiUsesFor(taxSystem).some((u) => u.code === use);
}

/** Uso por defecto: «Gastos en general» si aplica; si no, «Sin efectos fiscales». */
export function defaultCfdiUse(taxSystem: string): string {
  return isCfdiUseAllowed('G03', taxSystem) ? 'G03' : 'S01';
}

export interface ItemTax {
  type: 'IVA' | 'ISR';
  rate: number;
  withholding?: boolean;
}

export const IVA_RATE = 0.16;
export const RESICO_ISR_WITHHOLDING = 0.0125;
/** Dos terceras partes del IVA (16% × 2/3). */
export const IVA_WITHHOLDING_TWO_THIRDS = 0.106667;

/**
 * Impuestos del concepto. Reglas:
 * - IVA trasladado 16% siempre (la renta de casa habitación queda fuera del alcance de esta versión).
 * - Emisor persona física en RESICO (626) que factura a una persona moral: retención de ISR 1.25%.
 * - Persona física que presta servicios u otorga el uso de bienes a una persona moral: retiene 2/3 del IVA.
 */
export function itemTaxes(params: {
  issuerRfc: string;
  issuerTaxSystem: string;
  receptorRfc: string;
  kind: ProductConfig['kind'];
}): ItemTax[] {
  const issuer: PersonType | null = personType(params.issuerRfc);
  const receptor: PersonType | null = personType(params.receptorRfc);
  const taxes: ItemTax[] = [{ type: 'IVA', rate: IVA_RATE }];
  if (issuer !== 'fisica' || receptor !== 'moral') return taxes;
  if (params.issuerTaxSystem === '626') {
    taxes.push({ type: 'ISR', rate: RESICO_ISR_WITHHOLDING, withholding: true });
  }
  if (params.kind === 'servicios' || params.kind === 'arrendamiento') {
    taxes.push({ type: 'IVA', rate: IVA_WITHHOLDING_TWO_THIRDS, withholding: true });
  }
  return taxes;
}

/** Traduce a palabras simples el campo que rechazó el SAT (C4). */
export function describeField(path: string): string {
  if (path.includes('use')) return 'el uso de CFDI';
  if (path.includes('tax_system')) return 'el régimen fiscal';
  if (path.includes('zip')) return 'el código postal';
  if (path.includes('legal_name')) return 'el nombre o razón social';
  if (path.includes('tax_id')) return 'el RFC';
  if (path.includes('product_key')) return 'la clave del producto';
  return 'un dato de la factura';
}
