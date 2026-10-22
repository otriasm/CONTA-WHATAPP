// Webhook de WhatsApp (Cloud API + coexistencia): valida la firma y normaliza los eventos.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Inbound } from '../../orchestrator/inbound.js';

/** Valida X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app_secret, cuerpo crudo). */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Evento de cuenta que el orquestador no maneja directo (ER09: número desconectado). */
export interface AccountUpdate {
  wabaId: string;
  event: string;
  raw: unknown;
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{ field: string; value: Record<string, any> }>;
  }>;
}

export function parseWebhook(payload: unknown): { messages: Inbound[]; accountUpdates: AccountUpdate[] } {
  const messages: Inbound[] = [];
  const accountUpdates: AccountUpdate[] = [];
  const body = payload as WebhookPayload;
  if (body?.object !== 'whatsapp_business_account') return { messages, accountUpdates };

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId: string = value.metadata?.phone_number_id ?? '';

      if (change.field === 'messages') {
        for (const m of value.messages ?? []) {
          const parsed = parseMessage(m, phoneNumberId);
          if (parsed) messages.push(parsed);
        }
      } else if (change.field === 'smb_message_echoes') {
        for (const e of value.message_echoes ?? []) {
          messages.push({
            kind: 'echo',
            id: `echo:${e.id}`,
            toPhoneNumberId: phoneNumberId,
            to: e.to,
            at: fromUnix(e.timestamp),
          });
        }
      } else if (change.field === 'account_update') {
        accountUpdates.push({ wabaId: entry.id, event: value.event ?? 'unknown', raw: value });
      }
    }
  }
  return { messages, accountUpdates };
}

function parseMessage(m: any, toPhoneNumberId: string): Inbound | null {
  const base = { id: String(m.id), from: String(m.from), toPhoneNumberId, at: fromUnix(m.timestamp) };
  switch (m.type) {
    case 'text':
      return { ...base, kind: 'text', text: String(m.text?.body ?? '') };
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker': {
      const media = m[m.type] ?? {};
      return {
        ...base,
        kind: 'media',
        mediaType: m.type,
        mediaId: String(media.id),
        mimeType: String(media.mime_type ?? 'application/octet-stream'),
        filename: media.filename,
      };
    }
    case 'interactive': {
      const i = m.interactive ?? {};
      if (i.type === 'button_reply') return { ...base, kind: 'button', payload: String(i.button_reply?.id ?? '') };
      if (i.type === 'list_reply') return { ...base, kind: 'button', payload: String(i.list_reply?.id ?? '') };
      if (i.type === 'nfm_reply') {
        let response: Record<string, unknown> = {};
        try {
          response = JSON.parse(i.nfm_reply?.response_json ?? '{}');
        } catch {
          response = {};
        }
        const flowToken = typeof response['flow_token'] === 'string' ? response['flow_token'] : undefined;
        return { ...base, kind: 'flow', flowToken, response };
      }
      return { ...base, kind: 'unsupported', type: `interactive.${i.type}` };
    }
    case 'button':
      // Botón de respuesta rápida de una plantilla
      return { ...base, kind: 'button', payload: String(m.button?.payload ?? '') };
    default:
      return { ...base, kind: 'unsupported', type: String(m.type) };
  }
}

function fromUnix(ts: unknown): Date {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}
