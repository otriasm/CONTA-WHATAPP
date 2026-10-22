import * as z from 'zod';

const Env = z.object({
  PORT: z.coerce.number().default(3000),
  AMBIENTE: z.enum(['test', 'live']).default('test'),

  // Meta · WhatsApp Cloud API
  WA_APP_SECRET: z.string().min(1),
  WA_VERIFY_TOKEN: z.string().min(1),
  WA_GRAPH_VERSION: z.string().default('v23.0'),
  WA_CONTA_OP_PHONE_NUMBER_ID: z.string().min(1),
  WA_CONTA_OP_TOKEN: z.string().min(1),
  WA_FLOW_DATOS_ID: z.string().min(1),
  WA_FLOW_CAMPO_ID: z.string().min(1),
  WA_TEMPLATE_FACTURA: z.string().default('tu_factura_lista'),

  // Facturapi
  FACTURAPI_WEBHOOK_SECRET: z.string().min(1),
  FACTURAPI_BASE_URL: z.string().url().default('https://www.facturapi.io/v2'),

  // Conta
  RECEPTOR_SALT: z.string().min(16),
  MIN_READ_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  BOT_PAUSE_MINUTES: z.coerce.number().default(120),
  DEFAULT_PAYMENT_FORM: z.string().default('01'),

  // Negocio de demostración para desarrollo local (sin Postgres todavía).
  DEMO_BUSINESS_NAME: z.string().default('Café Ámbar'),
  DEMO_BUSINESS_RFC: z.string().optional(),
  DEMO_BUSINESS_TAX_SYSTEM: z.string().default('626'),
  DEMO_WA_PHONE_NUMBER_ID: z.string().optional(),
  DEMO_WA_TOKEN: z.string().optional(),
  DEMO_OPERATOR_PHONE: z.string().optional(),
  DEMO_FACTURAPI_KEY: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Configuración inválida:\n  ${missing}`);
  }
  return parsed.data;
}
