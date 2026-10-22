// CSF sintética con datos ficticios para probar el lector. Nunca uses una constancia real en las pruebas.

import { PDFDocument, StandardFonts } from 'pdf-lib';

export interface SyntheticCsf {
  rfc: string;
  curp?: string;
  names: string;
  firstLastName: string;
  secondLastName: string;
  zip: string;
  status?: string;
  issueDate?: string; // aaaa/mm/dd
  /** Renglones de la tabla de regímenes: «descripción dd/mm/aaaa [dd/mm/aaaa]». */
  regimes: string[];
  /** Si es false, se omite la página 2 (regímenes), como cuando solo mandan la primera hoja. */
  includePage2?: boolean;
}

export const FICTITIOUS_CSF: SyntheticCsf = {
  rfc: 'PEGJ800101AB1',
  curp: 'PEGJ800101HDFRMN09',
  names: 'JUAN',
  firstLastName: 'PEREZ',
  secondLastName: 'GOMEZ',
  zip: '06700',
  regimes: ['Régimen de Sueldos y Salarios e Ingresos Asimilados a Salarios 01/01/2010'],
};

export function syntheticCsfPages(csf: SyntheticCsf): string[][] {
  const fullName = `${csf.names} ${csf.firstLastName} ${csf.secondLastName}`;
  const issue = csf.issueDate ?? '2026/10/01';
  const page1 = [
    'CÉDULA DE IDENTIFICACIÓN FISCAL',
    csf.rfc,
    'Registro Federal de Contribuyentes',
    fullName,
    'Nombre, denominación o razón social',
    'idCIF: 12345678901',
    `VALIDA TU INFORMACIÓN FISCAL ${csf.rfc}`,
    'CONSTANCIA DE SITUACIÓN FISCAL',
    'Lugar y Fecha de Emisión',
    'CUAUHTEMOC , CIUDAD DE MEXICO A 01 DE OCTUBRE DE 2026',
    'Datos de Identificación del Contribuyente:',
    `RFC: ${csf.rfc}`,
    `CURP: ${csf.curp ?? ''}`,
    `Nombre (s): ${csf.names}`,
    `Primer Apellido: ${csf.firstLastName}`,
    `Segundo Apellido: ${csf.secondLastName}`,
    'Fecha inicio de operaciones: 01 DE ENERO DE 2010',
    `Estatus en el padrón: ${csf.status ?? 'ACTIVO'}`,
    'Fecha de último cambio de estado: 01 DE ENERO DE 2010',
    'Datos del domicilio registrado',
    `Código Postal: ${csf.zip} Tipo de Vialidad: CALLE`,
    'Nombre de Vialidad: FICTICIA Número Exterior: 1',
    'Página [1] de [2]',
  ];
  const page2 = [
    'Regímenes:',
    'Régimen Fecha Inicio Fecha Fin',
    ...csf.regimes,
    'Obligaciones:',
    'Descripción de la Obligación Descripción Vencimiento Fecha Inicio Fecha Fin',
    'Sus datos personales son incorporados y protegidos en los sistemas del SAT',
    'Cadena Original Sello:',
    `||${issue} 10:00:00|${csf.rfc}|CONSTANCIA DE SITUACIÓN FISCAL|1234567890|`,
    'Sello Digital:',
    'U0VMTE8gRklDVElDSU8gUEFSQSBQUlVFQkFT',
    'Página [2] de [2]',
  ];
  return csf.includePage2 === false ? [page1] : [page1, page2];
}

/** PDF real (con texto) de la CSF sintética. Se rellena para pasar el mínimo de 10 KB del lector. */
export async function syntheticCsfPdf(csf: SyntheticCsf = FICTITIOUS_CSF): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of syntheticCsfPages(csf)) {
    const page = doc.addPage([612, 792]);
    lines.forEach((text, i) => page.drawText(text, { x: 40, y: 750 - i * 18, size: 9, font }));
  }
  doc.setKeywords(['x'.repeat(12_000)]); // relleno en metadatos: no aparece en el texto
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
