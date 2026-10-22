// Catálogo de mensajes (error_catalog). Los textos salen del lienzo «Casos alternos y de error».
// En producción se cargan de la tabla error_catalog para cambiarlos sin desplegar; esto es el valor por defecto.

export const MESSAGES = {
  // B1 · el receptor pide su factura
  bienvenida:
    'Hola, soy el asistente de facturación de {negocio}. Para tu factura mándame tu Constancia de Situación Fiscal en PDF (las 2 páginas) o escribe «no tengo» y la capturamos. Aviso de privacidad: {aviso}',
  receptorConocido: '¿Facturo con los datos de {nombre}?',
  // B2 · CSF leída
  datosLeidos: 'Leí tu constancia:\nRFC: {rfc}\nNombre: {nombre}\nCP: {cp}\nRégimen: {regimen}\n¿Son correctos?',
  pideTicket: 'Listo, tus datos coinciden con el SAT. Ahora mándame una foto de tu ticket.',
  // B4 · resumen
  resumen:
    'Resumen de tu factura:\n{negocio} · ticket {folio} del {fecha}\nTotal: {total}\nA nombre de: {nombre} ({rfc})\nUso: {uso}\n¿Facturo?',
  // B5 · factura
  facturaLista: 'Aquí está tu factura de {negocio}. Folio fiscal: {uuid}',
  enRevision: 'Tu factura está en revisión. Te la mando en cuanto la aprueben.',
  enProceso: 'Tu factura está en proceso. Te la mando en cuanto el SAT responda.',
  // C2 · operador
  aprobacion:
    'Solicitud de factura · {negocio}\n{nombre} ({rfc})\nTicket {folio} del {fecha} · {total}\nMotivo: {motivo}',
  quienEnCaja: '¿Quién está en caja?',
  soporteSolicitado: 'Listo, avisé a soporte de Conta. Te escriben aquí mismo con el contexto de la factura.',
  errorSatOperador:
    'No se pudo timbrar la factura del ticket {folio}.\nQué falla: {campo}.\nDetalle del SAT: {detalle}',

  // Casos de error ER01–ER36 (solo los del chat; los del panel web viven en el BFF).
  ER10: '', // el mensaje no es para facturar: Conta no contesta
  ER12: 'Ese archivo es {tipo}. Mándame tu constancia en PDF.',
  ER13: 'Tu constancia no trae el régimen. Mándame las 2 páginas.',
  ER14: 'El nombre no coincide con el SAT. Escríbelo como en tu constancia.',
  ER15: 'Ese código postal no es el que tiene el SAT. Revísalo en tu constancia.',
  ER16: 'No encontré ese RFC en el SAT. Revisa que esté completo.',
  ER17: 'Ese régimen no corresponde a tu RFC. Elige el que dice tu constancia.',
  ER18: 'No alcanzo a leer el total. Mándame otra foto con buena luz o escríbelo.',
  ER19: 'Ese archivo es {tipo}, no una foto. Mándame una foto del ticket.',
  ER20: 'Ese ticket ya se facturó el {fecha}. El negocio lo va a revisar.',
  ER21: 'Tu ticket es del {fecha}. El negocio tiene que aprobarlo.',
  ER22: 'Tu factura está en revisión. Te la mando en cuanto la aprueben.',
  ER23: 'Este ticket parece de otro negocio. Solo puedo facturar consumos de {negocio}.',
  ER24: 'Tienes {n} solicitudes abiertas. ¿De cuál es este ticket?',
  ER25_operador: 'Recordatorio: hay una factura esperando tu aprobación (ticket {folio}).',
  ER25_receptor: 'Sigue en revisión.',
  ER28: 'Tu factura está en proceso. Te la mando en cuanto el SAT responda.',
  ER32: 'Aquí está tu XML: {url} (enlace seguro, vence en 7 días).',
  ER34: 'No pude enviarla a ese correo. ¿Tienes otro?',
  ER35: 'Aún no tienes facturas con {negocio}. ¿Quieres pedir una?',
  validacionGenerica: 'Tus datos no coinciden con el SAT: {detalle}',
  noEntendi: 'No entendí. ¿Me mandas tu constancia en PDF o escribes «no tengo»?',
} as const;

export type MessageKey = keyof typeof MESSAGES;

export function render(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[key].replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v === undefined ? `{${name}}` : String(v);
  });
}

const MIME_LABELS: Record<string, string> = {
  'application/msword': 'un documento de Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'un documento de Word',
  'application/vnd.ms-excel': 'una hoja de Excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'una hoja de Excel',
  'application/pdf': 'un PDF',
  'image/jpeg': 'una imagen',
  'image/png': 'una imagen',
  'audio/ogg': 'un audio',
  'video/mp4': 'un video',
};

export function describeMime(mime: string): string {
  return MIME_LABELS[mime.split(';')[0]!.trim()] ?? 'un archivo que no puedo leer';
}

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(amount);
}

export function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '');
}
