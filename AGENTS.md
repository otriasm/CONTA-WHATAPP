# Contexto para agentes (Antigravity, Claude Code u otros)

**Conta en WhatsApp**: el cliente escribe «quiero factura» al WhatsApp del negocio, manda su Constancia de Situación Fiscal (PDF) y la foto del ticket; Conta valida con el SAT vía Facturapi, timbra el CFDI 4.0 y devuelve PDF y XML en el mismo chat. El operador de caja solo aprueba cuando la regla de emisión lo pide.

Estado: primer corte listo (pantallas B1–B5 y C1–C5). Detalle en `README.md`.

## Cómo trabajar

```bash
npm install
npm test            # 65 pruebas, sin red; deben pasar siempre
npm run typecheck   # debe quedar limpio
npm run dev         # necesita .env (copiar de .env.example)
```

- Node 22+, TypeScript, ESM (`"type": "module"`, imports con extensión `.js`).
- Stack: Fastify, Zod, SDK oficial `facturapi`, `fiscalapi-csf`, `@anthropic-ai/sdk` (visión), Vitest.
- Antes de dar por terminado un cambio: `npm test` y `npm run typecheck` en verde.

## Arquitectura (puertos y adaptadores)

- `src/domain/`: reglas puras (RFC, motor fiscal, reglas de emisión). Sin dependencias externas.
- `src/orchestrator/`: máquina de estados de cada solicitud. Solo habla con interfaces de `src/ports.ts`.
- `src/adapters/`: implementaciones reales (WhatsApp Cloud API, Facturapi, lector de CSF, Claude, store en memoria).
- `src/http/`: Fastify con `/webhooks/whatsapp`, `/webhooks/facturapi`, `/health` y cola con reintentos.
- `src/messages/catalog.ts`: **todos** los textos que ve el usuario. No escribir textos sueltos en otro lado.
- `src/index.ts`: arranque; crea un negocio de demostración (`neg_demo`) desde las variables `DEMO_*`.
- `test/fakes.ts`: dobles de prueba de cada puerto. Las pruebas nuevas deben usarlos, no la red.

Reglas a respetar:

1. El orquestador nunca importa adaptadores; si necesita algo nuevo del exterior, primero se agrega al puerto.
2. La IA nunca inventa montos ni datos fiscales: si la confianza es menor a `MIN_READ_CONFIDENCE`, se pregunta al usuario.
3. Nada de datos personales en analítica ni en logs (CURP, idCIF y domicilio se descartan al leer la CSF).
4. Timbrado siempre con `idempotency_key`.
5. Nunca subir `.env`, llaves ni CSF reales. Las pruebas usan datos ficticios.

## Siguientes pasos (en orden sugerido)

1. **Prueba punta a punta** con número de prueba de Meta y Test Key de Facturapi: seguir `docs/primera-prueba.md`.
2. **Persistencia**: implementar `Store` sobre Postgres usando `db/migrations/001_init.sql`; estado efímero y deduplicación en Redis.
3. **Temporizadores**: recordatorio al operador a los 15 min, aviso al emisor a los 60 min (ER25), resumen diario (C6), CSD por vencer (ER31).
4. **ER09** (`account_update`: número desconectado) y **ER32** (enlace firmado para el XML).
5. **Endpoint cifrado de WhatsApp Flows** si los formularios necesitan datos dinámicos.
6. **Panel web A1–A5** (alta, CSD, Embedded Signup, Carta Manifiesto, modo de emisión, historial).
7. Elegir herramienta de analítica para reemplazar `ConsoleSink`.

Pendiente de validar con negocio: coexistencia de WhatsApp en México (Conta como Tech Provider), retenciones RESICO con un contador y forma de pago por defecto.

Origen: este código se movió desde `otriasm/Cuenta-Remunerada` (carpeta `conta-whatsapp/`) conservando su historial.
