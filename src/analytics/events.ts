// Tagueo de analítica (lienzo «Tagueo: reglas, parámetros y métricas»).
// Reglas: objeto_accion en participio, sin datos personales, evento_id único, tiempos calculados en el back.

import { createHmac, randomUUID } from 'node:crypto';

export type Role = 'emisor' | 'operador' | 'receptor' | 'sistema';
export type Channel = 'panel_web' | 'wa_negocio' | 'wa_conta_operacion' | 'back';

export interface GlobalParams {
  negocio_id: string;
  solicitud_id?: string;
  receptor_id?: string;
  operador_id?: string;
  rol: Role;
  canal: Channel;
  pantalla?: string;
  modo_emision?: 'automatico' | 'aprobacion';
  regla_version?: number;
}

export interface AnalyticsEvent extends GlobalParams {
  nombre: string;
  evento_id: string;
  ocurrido_en: string;
  ambiente: 'test' | 'live';
  [param: string]: unknown;
}

export interface AnalyticsSink {
  send(event: AnalyticsEvent): Promise<void>;
}

/** Parámetros prohibidos: si alguno se cuela, el evento no sale. */
const FORBIDDEN = ['rfc', 'nombre_receptor', 'cp', 'curp', 'domicilio', 'telefono', 'correo', 'email', 'phone'];

export class Analytics {
  constructor(
    private readonly sink: AnalyticsSink,
    private readonly environment: 'test' | 'live',
  ) {}

  async track(
    nombre: string,
    globals: GlobalParams,
    params: Record<string, unknown> = {},
    occurredAt: Date = new Date(),
  ): Promise<void> {
    const leaked = Object.keys(params).filter((k) => FORBIDDEN.includes(k));
    if (leaked.length > 0) throw new Error(`Evento ${nombre} con datos personales: ${leaked.join(', ')}`);
    const event: AnalyticsEvent = {
      ...params,
      ...globals,
      nombre,
      evento_id: randomUUID(),
      ocurrido_en: occurredAt.toISOString(),
      ambiente: this.environment,
    };
    try {
      await this.sink.send(event);
    } catch (err) {
      // La analítica nunca rompe el flujo de facturación.
      console.error('analytics_send_failed', nombre, err);
    }
  }
}

/** Seudónimo estable del teléfono: HMAC con sal. Nunca se manda el teléfono. */
export function pseudonymize(phone: string, salt: string): string {
  return 'rcp_' + createHmac('sha256', salt).update(phone).digest('hex').slice(0, 16);
}

export class ConsoleSink implements AnalyticsSink {
  async send(event: AnalyticsEvent): Promise<void> {
    console.log(JSON.stringify({ analytics: event }));
  }
}

export class MemorySink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];
  async send(event: AnalyticsEvent): Promise<void> {
    this.events.push(event);
  }
}
