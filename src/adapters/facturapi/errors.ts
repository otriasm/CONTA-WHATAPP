// Errores de la API de Facturapi v2, con el código que usa el catálogo de errores del lienzo.

export interface FacturapiErrorDetail {
  path?: string;
  message: string;
  source?: 'sat' | 'pac' | string;
}

export class FacturapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly path?: string,
    readonly errors: FacturapiErrorDetail[] = [],
    readonly logId?: string,
  ) {
    super(message);
    this.name = 'FacturapiError';
  }

  /** El SAT o el PAC rechazaron un campo (ER27): lo corrige el operador. */
  get isStampingValidation(): boolean {
    return this.code === 'invoice_stamping_validation_error';
  }

  /** Doble toque de «Sí, facturar» (ER29): ya hay una factura con esa llave. */
  get isIdempotencyConflict(): boolean {
    return this.code === 'idempotency_key_in_use';
  }

  /** Falla temporal (ER36): se reintenta con espera creciente. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 0;
  }

  /** Campo principal que falla, para traducirlo al operador (C4). */
  get failingPath(): string {
    return this.errors.find((e) => e.path)?.path ?? this.path ?? '';
  }
}
