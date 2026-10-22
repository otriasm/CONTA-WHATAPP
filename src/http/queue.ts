// Cola en proceso: separa los webhooks de los servicios y reintenta con espera creciente.
// Reemplazable por la cola de eventos del diagrama (SQS, Pub/Sub, BullMQ) sin tocar el orquestador.

import type { Scheduler } from '../ports.js';

export interface QueueOptions {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable(err: unknown): boolean;
  onFailure(err: unknown, label: string): void;
}

export class RetryQueue implements Scheduler {
  private pending = 0;

  constructor(private readonly opts: QueueOptions) {}

  enqueue(label: string, job: () => Promise<void>): void {
    this.pending += 1;
    void this.run(label, job, 1).finally(() => {
      this.pending -= 1;
    });
  }

  schedule(label: string, delayMs: number, job: () => Promise<void>): void {
    this.pending += 1;
    setTimeout(() => {
      this.pending -= 1;
      this.enqueue(label, job);
    }, delayMs).unref();
  }

  get size(): number {
    return this.pending;
  }

  private async run(label: string, job: () => Promise<void>, attempt: number): Promise<void> {
    try {
      await job();
    } catch (err) {
      if (attempt < this.opts.maxAttempts && this.opts.isRetryable(err)) {
        const delay = this.opts.baseDelayMs * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        return this.run(label, job, attempt + 1);
      }
      this.opts.onFailure(err, label);
    }
  }
}
