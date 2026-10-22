// Cliente de la WhatsApp Cloud API (Graph API). Manda desde el número del negocio o desde Conta Operación.

import type {
  Button,
  FlowMessage,
  OutgoingDocument,
  TemplateMessage,
  WhatsAppSender,
} from '../../ports.js';

export interface WhatsAppClientOptions {
  graphVersion: string;
  /** Token de acceso por número: el del negocio (Embedded Signup) o el de Conta Operación. */
  tokenFor(phoneNumberId: string): Promise<string>;
  /** Token para descargar medios (system user de Conta). */
  mediaToken: string;
  fetch?: typeof fetch;
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }

  /** 131047: pasaron más de 24 h desde el último mensaje del usuario (ER33). */
  get isOutsideWindow(): boolean {
    return this.code === 131047;
  }
}

export class WhatsAppCloudClient implements WhatsAppSender {
  private readonly base: string;
  private readonly http: typeof fetch;

  constructor(private readonly opts: WhatsAppClientOptions) {
    this.base = `https://graph.facebook.com/${opts.graphVersion}`;
    this.http = opts.fetch ?? fetch;
  }

  sendText(from: string, to: string, text: string): Promise<void> {
    return this.send(from, to, { type: 'text', text: { body: text, preview_url: true } });
  }

  sendButtons(from: string, to: string, body: string, buttons: Button[]): Promise<void> {
    if (buttons.length === 0 || buttons.length > 3) throw new Error('WhatsApp acepta de 1 a 3 botones');
    return this.send(from, to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })),
        },
      },
    });
  }

  async sendDocument(from: string, to: string, doc: OutgoingDocument): Promise<void> {
    const mediaId = await this.upload(from, doc);
    return this.send(from, to, {
      type: 'document',
      document: { id: mediaId, filename: doc.filename, caption: doc.caption },
    });
  }

  async sendTemplate(from: string, to: string, t: TemplateMessage): Promise<void> {
    const components: unknown[] = [];
    if (t.headerDocument) {
      const id = await this.upload(from, t.headerDocument);
      components.push({
        type: 'header',
        parameters: [{ type: 'document', document: { id, filename: t.headerDocument.filename } }],
      });
    }
    if (t.bodyParams.length) {
      components.push({ type: 'body', parameters: t.bodyParams.map((text) => ({ type: 'text', text })) });
    }
    return this.send(from, to, {
      type: 'template',
      template: { name: t.name, language: { code: t.languageCode }, components },
    });
  }

  sendFlow(from: string, to: string, flow: FlowMessage): Promise<void> {
    return this.send(from, to, {
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: flow.body },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: flow.flowToken,
            flow_id: flow.flowId,
            flow_cta: flow.cta,
            flow_action: 'navigate',
            flow_action_payload: { screen: flow.screen, data: flow.data ?? {} },
          },
        },
      },
    });
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    const auth = { Authorization: `Bearer ${this.opts.mediaToken}` };
    const meta = await this.json<{ url: string; mime_type: string }>(
      await this.http(`${this.base}/${encodeURIComponent(mediaId)}`, { headers: auth }),
    );
    const file = await this.http(meta.url, { headers: auth });
    if (!file.ok) throw new WhatsAppApiError(`No se pudo descargar el medio ${mediaId}`, file.status);
    return { data: Buffer.from(await file.arrayBuffer()), mimeType: meta.mime_type };
  }

  private async upload(from: string, doc: OutgoingDocument): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', doc.mimeType);
    form.append('file', new Blob([new Uint8Array(doc.data)], { type: doc.mimeType }), doc.filename);
    const res = await this.http(`${this.base}/${from}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.opts.tokenFor(from)}` },
      body: form,
    });
    return (await this.json<{ id: string }>(res)).id;
  }

  private async send(from: string, to: string, message: Record<string, unknown>): Promise<void> {
    const res = await this.http(`${this.base}/${from}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.opts.tokenFor(from)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message }),
    });
    await this.json(res);
  }

  private async json<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      throw new WhatsAppApiError(body?.error?.message ?? res.statusText, res.status, body?.error?.code);
    }
    return body as T;
  }
}
