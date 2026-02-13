// ═══════════════════════════════════════
// ATLAS — WhatsApp Send Tool
// Proactive outbound messaging via Baileys
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { MemoryManager } from '../../hippocampus/memory-manager';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';

export class WhatsAppSendTool implements Tool {
  definition: ToolDefinition = {
    name: 'whatsapp_send',
    description:
      'Enviar mensajes de WhatsApp a contactos o números telefónicos. ' +
      'Usar cuando el usuario pida enviar un mensaje, aviso o notificación por WhatsApp. ' +
      'Puede enviar a un número específico, a un contacto por nombre, a un alias guardado en memoria, ' +
      'o a múltiples destinatarios separados por coma. ' +
      'Usar confirm=true para enviar directo (default cuando Jose pide explícitamente). ' +
      'Usar confirm=false solo si el mensaje es largo/formal y querés que Jose lo revise antes.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'Destinatario(s). Puede ser: número con código de país (573001234567), ' +
            'nombre de contacto, alias guardado en memoria, nombre de grupo, ' +
            'o múltiples separados por coma.',
        },
        message: {
          type: 'string',
          description: 'Mensaje a enviar. Soporta formato WhatsApp: *bold*, _italic_, ```code```, ~tachado~',
        },
        media_path: {
          type: 'string',
          description: 'Ruta a archivo para enviar (imagen, PDF, documento). Opcional.',
        },
        media_caption: {
          type: 'string',
          description: 'Texto que acompaña al archivo multimedia. Opcional.',
        },
        confirm: {
          type: 'boolean',
          description: 'true = enviar directo (default para mensajes simples). false = mostrar preview para que Jose revise antes de enviar.',
        },
      },
      required: ['to', 'message'],
    },
  };

  private getSocket: () => any;
  private getContacts: () => Map<string, string>;
  private memory: MemoryManager;

  constructor(
    getSocket: () => any,
    getContacts: () => Map<string, string>,
    memory: MemoryManager
  ) {
    this.getSocket = getSocket;
    this.getContacts = getContacts;
    this.memory = memory;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const to = String(params.to || '');
    const message = String(params.message || '');
    const mediaPath = params.media_path ? String(params.media_path) : undefined;
    const mediaCaption = params.media_caption ? String(params.media_caption) : undefined;
    const confirm = params.confirm === true;

    if (!to) return { success: false, output: '', error: 'Se requiere destinatario (to)' };
    if (!message) return { success: false, output: '', error: 'Se requiere mensaje (message)' };

    const sock = this.getSocket();
    if (!sock) {
      return {
        success: false,
        output: '',
        error: 'WhatsApp no está conectado. Verificá que WHATSAPP_ENABLED=true y la sesión esté autenticada.',
      };
    }

    // Resolve recipients
    const recipientInputs = to.split(',').map(r => r.trim()).filter(Boolean);
    const resolved: Array<{ jid: string; displayName: string }> = [];

    for (const input of recipientInputs) {
      const result = await this.resolveRecipient(sock, input);
      if (result) {
        resolved.push(result);
      } else {
        return {
          success: false,
          output: '',
          error: `No pude resolver el destinatario "${input}". ` +
            `Intentá con el número completo incluyendo código de país (ej: 573001234567) ` +
            `o verificá que el nombre esté en la agenda.`,
        };
      }
    }

    // Preview mode (confirm=false)
    if (!confirm) {
      const recipientList = resolved.map(r => r.displayName).join(', ');
      const preview = message.length > 200 ? message.substring(0, 200) + '...' : message;
      const mediaInfo = mediaPath ? `\nAdjunto: ${path.basename(mediaPath)}` : '';

      return {
        success: true,
        output:
          `📱 *Confirmación de envío*\n\n` +
          `Para: ${recipientList}\n` +
          `Mensaje: "${preview}"${mediaInfo}\n\n` +
          `¿Lo envío? (respondé "sí" o "dale" para confirmar)`,
      };
    }

    // Send mode (confirm=true)
    const results: string[] = [];
    let allSuccess = true;

    for (let i = 0; i < resolved.length; i++) {
      const recipient = resolved[i];
      try {
        if (mediaPath) {
          await this.sendMediaMessage(sock, recipient.jid, mediaPath, mediaCaption || message);
        } else {
          await sock.sendMessage(recipient.jid, { text: message });
        }
        results.push(`✅ Enviado a ${recipient.displayName}`);
        logger.info(`WhatsApp enviado a ${recipient.displayName} (${recipient.jid})`);
      } catch (err: any) {
        allSuccess = false;
        results.push(`❌ Error enviando a ${recipient.displayName}: ${err.message}`);
        logger.error(`Error enviando WhatsApp a ${recipient.jid}: ${err.message}`);
      }

      // Rate limiting: 2s between messages to different recipients
      if (i < resolved.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return {
      success: allSuccess,
      output: results.join('\n'),
      error: allSuccess ? undefined : 'Algunos mensajes no se pudieron enviar',
    };
  }

  // ── Resolve Recipient ──

  private async resolveRecipient(
    sock: any,
    input: string
  ): Promise<{ jid: string; displayName: string } | null> {
    // Case 1: Direct phone number
    const cleanNumber = input.replace(/[\s\-\(\)\+]/g, '');
    if (/^\d{10,15}$/.test(cleanNumber)) {
      let number = cleanNumber;

      // Colombian 10-digit number (3XX...) → add 57
      if (number.length === 10 && number.startsWith('3')) {
        number = '57' + number;
      }
      // Starts with 0 → remove 0, add 57
      if (number.startsWith('0')) {
        number = '57' + number.substring(1);
      }

      const jid = `${number}@s.whatsapp.net`;

      // Verify number exists on WhatsApp
      try {
        const [exists] = await sock.onWhatsApp(number);
        if (exists?.exists) {
          return { jid: exists.jid, displayName: input };
        }
        // Number not on WhatsApp — reject to prevent sending to invalid/hallucinated numbers
        logger.warn(`WhatsApp send: number ${number} not found on WhatsApp`);
        return null;
      } catch (err) {
        // Verification API failed — reject to be safe
        logger.warn(`WhatsApp send: could not verify ${number}`, { error: err });
        return null;
      }
    }

    // Case 2: Search by name in WhatsApp contacts cache
    const inputLower = input.toLowerCase();
    const contacts = this.getContacts();
    for (const [name, jid] of contacts) {
      if (
        name.toLowerCase().includes(inputLower) ||
        inputLower.includes(name.toLowerCase())
      ) {
        return { jid, displayName: name };
      }
    }

    // Case 3: Search in ATLAS memory (aliases like "mi esposa" → "573001234567")
    const contactFacts = this.memory.searchFacts(`contacto_${input}`, 5);
    if (contactFacts.length > 0) {
      const phone = contactFacts[0].value;
      // Recursively resolve the phone number
      return this.resolveRecipient(sock, phone);
    }

    // Also try partial match on all contact facts
    const allContactFacts = this.memory.searchFacts('contacto_', 50);
    for (const fact of allContactFacts) {
      const alias = fact.key.replace('contacto_', '');
      if (alias.toLowerCase().includes(inputLower) || inputLower.includes(alias.toLowerCase())) {
        return this.resolveRecipient(sock, fact.value);
      }
    }

    // Case 4: Search groups by name
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [jid, group] of Object.entries(groups) as Array<[string, any]>) {
        if ((group.subject as string)?.toLowerCase().includes(inputLower)) {
          return { jid, displayName: `Grupo "${group.subject}"` };
        }
      }
    } catch {
      // Groups not available
    }

    return null;
  }

  // ── Send Media Message ──

  private async sendMediaMessage(
    sock: any,
    jid: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Archivo no encontrado: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    // Detect MIME type
    let mimeType: string;
    try {
      const mime = require('mime-types');
      mimeType = mime.lookup(filePath) || 'application/octet-stream';
    } catch {
      // Fallback MIME detection by extension
      const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp',
        '.mp4': 'video/mp4', '.avi': 'video/avi', '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
        '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain', '.csv': 'text/csv',
      };
      mimeType = mimeMap[ext] || 'application/octet-stream';
    }

    if (mimeType.startsWith('image/')) {
      await sock.sendMessage(jid, { image: buffer, caption: caption || '', mimetype: mimeType });
    } else if (mimeType.startsWith('video/')) {
      await sock.sendMessage(jid, { video: buffer, caption: caption || '', mimetype: mimeType });
    } else if (mimeType.startsWith('audio/')) {
      await sock.sendMessage(jid, { audio: buffer, mimetype: mimeType, ptt: ext === '.ogg' });
    } else {
      await sock.sendMessage(jid, {
        document: buffer, mimetype: mimeType, fileName: filename, caption: caption || '',
      });
    }
  }
}
