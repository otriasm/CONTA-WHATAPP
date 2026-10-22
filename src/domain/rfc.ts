// Validación local del formato del RFC. La existencia en el padrón la confirma el SAT vía Facturapi.

const RFC_PF = /^[A-ZÑ&]{4}\d{6}[A-Z\d]{3}$/;
const RFC_PM = /^[A-ZÑ&]{3}\d{6}[A-Z\d]{3}$/;

export const RFC_PUBLICO_GENERAL = 'XAXX010101000';
export const RFC_EXTRANJERO = 'XEXX010101000';

export type PersonType = 'fisica' | 'moral';

export function normalizeRfc(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

export function personType(rfc: string): PersonType | null {
  const r = normalizeRfc(rfc);
  if (RFC_PF.test(r)) return 'fisica';
  if (RFC_PM.test(r)) return 'moral';
  return null;
}

/** Valida formato y que la fecha embebida exista (AAMMDD). */
export function isValidRfc(rfc: string): boolean {
  const r = normalizeRfc(rfc);
  const type = personType(r);
  if (!type) return false;
  if (r === RFC_PUBLICO_GENERAL || r === RFC_EXTRANJERO) return true;
  const offset = type === 'fisica' ? 4 : 3;
  const mm = Number(r.slice(offset + 2, offset + 4));
  const dd = Number(r.slice(offset + 4, offset + 6));
  if (mm < 1 || mm > 12 || dd < 1) return false;
  // Año bisiesto no importa aquí: 29 feb se acepta y el SAT decide.
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1]!;
  return dd <= daysInMonth;
}

export function isValidZip(zip: string): boolean {
  return /^\d{5}$/.test(zip.trim());
}
