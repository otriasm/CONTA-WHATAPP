# Conta en WhatsApp · backend v2

El cliente de un negocio pide su factura CFDI 4.0 en el WhatsApp de ese negocio. Conta lee su Constancia de Situación Fiscal y la foto del ticket, valida los datos con el SAT a través de Facturapi, timbra la factura y la entrega en el mismo chat. El operador de caja solo interviene cuando hace falta. El diseño completo está en el lienzo «Conta en WhatsApp», en la página «Versión 2».

## Qué ya funciona (primer corte)

| Pantalla | Qué hace | Dónde |
| --- | --- | --- |
| B1 | Entiende «quiero factura», abre una solicitud y manda el aviso de privacidad | `orchestrator.ts` · `claudeReader.ts` |
| B2 | Lee la CSF en PDF con `fiscalapi-csf` (sin IA) y, si no se puede, con IA de visión. Muestra los 4 datos con 2 botones; si hay varios regímenes vigentes, el cliente elige | `csfFirstReader.ts` · `readCsf` |
| B3 · D2 | WhatsApp Flow «Tus datos fiscales». Valida el RFC, el CP y el régimen y luego los compara con el SAT | `sendFiscalForm` · `validateFiscal` |
| B4 | Lee la foto del ticket y aplica la regla de emisión: modo, máximo, antigüedad y folio repetido | `readTicket` · `domain/rules.ts` |
| B5 | Timbra con `idempotency_key` y manda el PDF y el XML. Fuera de la ventana de 24 h usa una plantilla | `stamp` · `deliver` |
| C1 | Si el operador escribe desde la app, el bot se pausa 2 h en ese chat (`smb_message_echoes`) | `handleEcho` |
| C2 | Manda la aprobación a «Conta Operación», pide el turno si no hay uno abierto y registra quién emitió | `requestApproval` · `approve` |
| C3 | El operador manda la foto del ticket y Conta la liga a la solicitud | `handleOperator` |
| C4 · C5 | Error del SAT: le dice al operador qué campo falla, le manda un Flow con las opciones válidas y reintenta con una llave nueva | `notifyOperatorStampError` · `applyFieldFix` |

Casos de error cubiertos con pruebas: ER10–ER14, ER17–ER23, ER26–ER29, ER33 y ER35. ER15, ER16, ER30 y ER36 también están implementados (validación local y reintentos con espera creciente), pero aún sin prueba propia. Todos los textos están en `src/messages/catalog.ts`.

## Arquitectura

```
src/
  domain/          RFC, motor fiscal (usos de CFDI por régimen, retenciones) y reglas de emisión. Sin dependencias.
  orchestrator/    Máquina de estados de cada solicitud; solo habla con los puertos.
  ports.ts         Contratos con WhatsApp, Facturapi, IA, datos, bóveda y cola.
  adapters/
    whatsapp/      Cloud API: firma del webhook, normalización y envío (texto, botones, documentos, Flows, plantillas).
    facturapi/     SDK oficial `facturapi`: clientes con validación del SAT, facturas, PDF/XML y firma de webhooks.
    csf/           `fiscalapi-csf`: lector determinista de la CSF. Descarta CURP, idCIF y domicilio.
    ai/            Claude con visión y salida estructurada (Zod): tickets, intención y CSF de respaldo. Nunca inventa montos.
    memory/        Store en memoria para desarrollo y pruebas.
  analytics/       Eventos del diccionario de tagueo, sin datos personales.
  http/            Fastify: /webhooks/whatsapp, /webhooks/facturapi, /health y la cola con reintentos.
db/migrations/     Esquema de Postgres con las tablas del lienzo.
```

## Correr en local

```bash
npm install
npm test           # 65 pruebas, sin red
npm run typecheck
cp .env.example .env   # llena las variables
npm run dev
```

Guía paso a paso para la primera prueba con WhatsApp real: [`docs/primera-prueba.md`](docs/primera-prueba.md). En resumen:

1. Crea en Meta un número de prueba para el negocio y otro para Conta Operación.
2. Publica los dos Flows («Tus datos fiscales» y «Corregir campo») y la plantilla de utilidad `tu_factura_lista`, con un documento en el encabezado.
3. Expón el puerto (por ejemplo con ngrok) y suscribe el webhook a `messages` y `smb_message_echoes`.
4. Usa la **Test Key** de Facturapi y datos ficticios.

## Pendiente (siguientes cortes)

- **Postgres y Redis**: implementar `Store` sobre `db/migrations/001_init.sql`. El estado y los repetidos pasan a Redis.
- **Panel web (A1–A5)**: BFF con alta, CSD, Embedded Signup, Carta Manifiesto, modo de emisión e historial.
- **Endpoint cifrado de los Flows**: hoy se usa la respuesta `nfm_reply`. Si el Flow necesita datos dinámicos, hay que implementar el endpoint con su cifrado.
- **Temporizadores**: recordatorio al operador a los 15 min y aviso al emisor a los 60 min (ER25), resumen diario (C6) y CSD por vencer (ER31).
- **ER32**: enlace firmado para el XML si WhatsApp no lo acepta como documento.
- **ER09**: si el número se desconecta (`account_update`), avisar al emisor.
- **Herramienta de analítica**: hoy los eventos salen por consola (`ConsoleSink`). Elegir entre Mixpanel, Amplitude, PostHog o GA4.

## Por validar antes de producción

- Que la coexistencia de WhatsApp funcione en México y que Conta sea Tech Provider de Meta.
- Las retenciones de RESICO (ISR 1.25% y 2/3 del IVA): confirmarlas con un contador.
- La forma de pago por defecto (`DEFAULT_PAYMENT_FORM`). El ticket debería decir si fue en efectivo o con tarjeta.
- La CSF de prueba del lienzo es real y tiene datos personales. No se sube a este repositorio; las pruebas usan datos ficticios.
