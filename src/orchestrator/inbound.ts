// Mensajes entrantes ya normalizados desde el webhook de WhatsApp.

interface Base {
  /** wamid del mensaje: sirve para ignorar repetidos. */
  id: string;
  /** phone_number_id que recibió el mensaje: el del negocio o el de Conta Operación. */
  toPhoneNumberId: string;
  at: Date;
}

export type Inbound =
  | (Base & { kind: 'text'; from: string; text: string })
  | (Base & {
      kind: 'media';
      from: string;
      mediaType: 'document' | 'image' | 'audio' | 'video' | 'sticker';
      mediaId: string;
      mimeType: string;
      filename?: string;
    })
  | (Base & { kind: 'button'; from: string; payload: string })
  | (Base & { kind: 'flow'; from: string; flowToken?: string; response: Record<string, unknown> })
  /** smb_message_echoes: el negocio escribió desde su app WhatsApp Business (coexistencia). */
  | (Base & { kind: 'echo'; to: string })
  | (Base & { kind: 'unsupported'; from: string; type: string });
