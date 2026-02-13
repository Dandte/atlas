// ═══════════════════════════════════════════════════════
// ATLAS — WhatsApp Control Tool (Unified)
// Leer, buscar, enviar, estadísticas, resúmenes
// ═══════════════════════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { WhatsAppMonitor } from '../../channels/whatsapp-monitor';
import { MemoryManager } from '../../hippocampus/memory-manager';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';

export class WhatsAppControlTool implements Tool {
  definition: ToolDefinition = {
    name: 'whatsapp',
    description:
      'Control total del WhatsApp de Jose. Leer mensajes, buscar conversaciones, ' +
      'enviar mensajes, enviar archivos, ver estadísticas, y obtener resúmenes.\n\n' +
      'Usar cuando el usuario:\n' +
      '- Pregunte qué pasó en WhatsApp\n' +
      '- Pida un resumen de conversaciones\n' +
      '- Pregunte qué le dijo alguien\n' +
      '- Pida buscar algo en los mensajes\n' +
      '- Quiera enviar un mensaje o archivo\n' +
      '- Pregunte por mensajes sin leer\n' +
      '- Quiera saber quién le escribió',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['summary', 'chat_history', 'search', 'send', 'send_file', 'stats', 'unread', 'contacts'],
          description: 'Acción a realizar',
        },
        period: {
          type: 'string',
          description: "Período del resumen: 'today', 'yesterday', o fecha YYYY-MM-DD. Default: today",
        },
        contact: {
          type: 'string',
          description: 'Nombre del contacto, alias, número, o nombre de grupo',
        },
        query: {
          type: 'string',
          description: 'Texto a buscar en los mensajes',
        },
        message: {
          type: 'string',
          description: 'Mensaje a enviar',
        },
        file_path: {
          type: 'string',
          description: 'Ruta del archivo a enviar',
        },
        caption: {
          type: 'string',
          description: 'Texto que acompaña al archivo',
        },
        confirm: {
          type: 'boolean',
          description: 'true = enviar directo. Default: false (mostrar preview)',
        },
        alias: {
          type: 'string',
          description: "Alias para guardar (ej: 'gerente Suba')",
        },
        phone: {
          type: 'string',
          description: "Número de teléfono (ej: '573001234567')",
        },
        limit: {
          type: 'number',
          description: 'Máximo de resultados. Default: 50',
        },
      },
      required: ['action'],
    },
  };

  private getMonitor: () => WhatsAppMonitor | null;
  private getSocket: () => any;
  private getContacts: () => Map<string, string>;
  private memory: MemoryManager;

  constructor(
    getMonitor: () => WhatsAppMonitor | null,
    getSocket: () => any,
    getContacts: () => Map<string, string>,
    memory: MemoryManager
  ) {
    this.getMonitor = getMonitor;
    this.getSocket = getSocket;
    this.getContacts = getContacts;
    this.memory = memory;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action);
    const monitor = this.getMonitor();

    // Query actions require monitor
    if (!monitor && !['send', 'send_file', 'contacts'].includes(action)) {
      return {
        success: false, output: '',
        error: 'WhatsApp Monitor no está activo. Verificá que WHATSAPP_ENABLED=true y WHATSAPP_MONITOR_ENABLED=true.',
      };
    }

    switch (action) {
      case 'summary': return this.handleSummary(monitor!, params);
      case 'chat_history': return this.handleChatHistory(monitor!, params);
      case 'search': return this.handleSearch(monitor!, params);
      case 'send': return this.handleSend(monitor, params);
      case 'send_file': return this.handleSendFile(monitor, params);
      case 'stats': return this.handleStats(monitor!);
      case 'unread': return this.handleUnread(monitor!);
      case 'contacts': return this.handleContacts(monitor, params);
      default:
        return { success: false, output: '', error: `Acción no reconocida: ${action}` };
    }
  }

  // ─────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────

  private handleSummary(monitor: WhatsAppMonitor, params: Record<string, unknown>): ToolResult {
    const period = String(params.period || 'today');
    let messages: any[];

    if (period === 'today') {
      messages = monitor.getTodayMessages();
    } else if (period === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().split('T')[0];
      messages = monitor.getMessages(`${dateStr}T00:00:00`, `${dateStr}T23:59:59`);
    } else {
      messages = monitor.getMessages(`${period}T00:00:00`, `${period}T23:59:59`);
    }

    if (messages.length === 0) {
      return { success: true, output: 'No hay mensajes para ese período.' };
    }

    const grouped = this.groupByChat(messages);
    const formatted = this.formatMessagesForSummary(grouped);

    return {
      success: true,
      output: `Mensajes de WhatsApp (${period}):\n\n${formatted}\n\nTotal: ${messages.length} mensajes en ${Object.keys(grouped).length} chats.`,
    };
  }

  // ─────────────────────────────────────
  // CHAT HISTORY
  // ─────────────────────────────────────

  private handleChatHistory(monitor: WhatsAppMonitor, params: Record<string, unknown>): ToolResult {
    if (!params.contact) {
      return { success: false, output: '', error: 'Necesito el nombre del contacto o grupo.' };
    }

    const limit = Number(params.limit) || 50;
    const messages = monitor.getContactMessages(String(params.contact), limit);

    if (messages.length === 0) {
      return { success: true, output: `No encontré mensajes de "${params.contact}".` };
    }

    const formatted = messages.reverse().map((m: any) => {
      const sender = m.is_from_me ? 'Jose' : (m.sender_name || m.chat_name);
      const time = new Date(m.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${sender}: ${m.content || `[${m.message_type}]`}`;
    }).join('\n');

    return {
      success: true,
      output: `Conversación con ${messages[0]?.chat_name || params.contact}:\n\n${formatted}`,
    };
  }

  // ─────────────────────────────────────
  // SEARCH
  // ─────────────────────────────────────

  private handleSearch(monitor: WhatsAppMonitor, params: Record<string, unknown>): ToolResult {
    if (!params.query) {
      return { success: false, output: '', error: 'Necesito un texto para buscar.' };
    }

    const limit = Number(params.limit) || 20;
    const results = monitor.searchMessages(String(params.query), limit);

    if (results.length === 0) {
      return { success: true, output: `No encontré mensajes que contengan "${params.query}".` };
    }

    const formatted = results.map((m: any) => {
      const sender = m.is_from_me ? 'Jose' : (m.sender_name || m.chat_name);
      const date = new Date(m.timestamp).toLocaleDateString('es-CO');
      const time = new Date(m.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
      return `[${date} ${time}] ${m.chat_name} — ${sender}: ${m.content}`;
    }).join('\n');

    return {
      success: true,
      output: `Resultados para "${params.query}" (${results.length}):\n\n${formatted}`,
    };
  }

  // ─────────────────────────────────────
  // SEND MESSAGE
  // ─────────────────────────────────────

  private async handleSend(monitor: WhatsAppMonitor | null, params: Record<string, unknown>): Promise<ToolResult> {
    if (!params.contact || !params.message) {
      return { success: false, output: '', error: 'Necesito contacto y mensaje.' };
    }

    const sock = this.getSocket();
    if (!sock) {
      return { success: false, output: '', error: 'WhatsApp no está conectado.' };
    }

    const recipient = await this.resolveRecipient(sock, String(params.contact), monitor);
    if (!recipient) {
      return {
        success: false, output: '',
        error: `No encontré a "${params.contact}". Probá con el número completo (573XXXXXXXXX).`,
      };
    }

    const confirm = params.confirm === true;
    const message = String(params.message);

    if (!confirm) {
      const preview = message.length > 200 ? message.substring(0, 200) + '...' : message;
      return {
        success: true,
        output: `📱 *Enviar WhatsApp*\n\nPara: ${recipient.displayName}\nMensaje: "${preview}"\n\n¿Lo envío?`,
      };
    }

    try {
      await sock.sendMessage(recipient.jid, { text: message });
      logger.info(`WhatsApp enviado a ${recipient.displayName} (${recipient.jid})`);
      return { success: true, output: `✅ Mensaje enviado a ${recipient.displayName}` };
    } catch (err: any) {
      return { success: false, output: '', error: `Error enviando: ${err.message}` };
    }
  }

  // ─────────────────────────────────────
  // SEND FILE
  // ─────────────────────────────────────

  private async handleSendFile(monitor: WhatsAppMonitor | null, params: Record<string, unknown>): Promise<ToolResult> {
    if (!params.contact || !params.file_path) {
      return { success: false, output: '', error: 'Necesito contacto y archivo.' };
    }

    const filePath = String(params.file_path);
    if (!fs.existsSync(filePath)) {
      return { success: false, output: '', error: `Archivo no encontrado: ${filePath}` };
    }

    const sock = this.getSocket();
    if (!sock) {
      return { success: false, output: '', error: 'WhatsApp no está conectado.' };
    }

    const recipient = await this.resolveRecipient(sock, String(params.contact), monitor);
    if (!recipient) {
      return { success: false, output: '', error: `No encontré a "${params.contact}".` };
    }

    const confirm = params.confirm === true;
    const caption = params.caption ? String(params.caption) : '';
    const filename = path.basename(filePath);

    if (!confirm) {
      return {
        success: true,
        output:
          `📱 *Enviar archivo por WhatsApp*\n\nPara: ${recipient.displayName}\n` +
          `Archivo: ${filename}\n${caption ? `Texto: "${caption}"` : ''}\n\n¿Lo envío?`,
      };
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();

      let mimeType: string;
      try {
        const mime = require('mime-types');
        mimeType = mime.lookup(filePath) || 'application/octet-stream';
      } catch {
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
          '.gif': 'image/gif', '.webp': 'image/webp',
          '.mp4': 'video/mp4', '.pdf': 'application/pdf',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
        mimeType = mimeMap[ext] || 'application/octet-stream';
      }

      if (mimeType.startsWith('image/')) {
        await sock.sendMessage(recipient.jid, { image: buffer, caption, mimetype: mimeType });
      } else if (mimeType.startsWith('video/')) {
        await sock.sendMessage(recipient.jid, { video: buffer, caption, mimetype: mimeType });
      } else {
        await sock.sendMessage(recipient.jid, { document: buffer, fileName: filename, caption, mimetype: mimeType });
      }

      logger.info(`WhatsApp archivo enviado a ${recipient.displayName}: ${filename}`);
      return { success: true, output: `✅ Archivo "${filename}" enviado a ${recipient.displayName}` };
    } catch (err: any) {
      return { success: false, output: '', error: `Error enviando archivo: ${err.message}` };
    }
  }

  // ─────────────────────────────────────
  // STATS
  // ─────────────────────────────────────

  private handleStats(monitor: WhatsAppMonitor): ToolResult {
    const stats = monitor.getTodayStats();

    const topChatsStr = stats.topChats
      .map((c, i) => `${i + 1}. ${c.name}: ${c.count} mensajes`)
      .join('\n');

    return {
      success: true,
      output:
        `📊 WhatsApp hoy:\n` +
        `- Total: ${stats.totalMessages} mensajes\n` +
        `- Chats activos: ${stats.totalChats}\n` +
        `- Enviados: ${stats.sentByMe}\n` +
        `- Recibidos: ${stats.received}\n` +
        `- Sin leer: ${stats.unread}\n\n` +
        `Top chats:\n${topChatsStr || '(sin actividad)'}`,
    };
  }

  // ─────────────────────────────────────
  // UNREAD
  // ─────────────────────────────────────

  private handleUnread(monitor: WhatsAppMonitor): ToolResult {
    const today = new Date().toISOString().split('T')[0];

    const unread = monitor.db.prepare(`
      SELECT chat_name, sender_name, content, message_type, timestamp
      FROM wa_messages
      WHERE is_from_me = 0 AND is_read = 0 AND date(timestamp) = ?
      ORDER BY timestamp DESC
    `).all(today) as any[];

    if (unread.length === 0) {
      return { success: true, output: 'No hay mensajes sin leer.' };
    }

    const grouped: Record<string, any[]> = {};
    for (const msg of unread) {
      const key = msg.chat_name || 'Desconocido';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(msg);
    }

    const formatted = Object.entries(grouped).map(([chat, msgs]) => {
      const preview = msgs.slice(0, 3).map((m: any) => {
        const sender = m.sender_name || chat;
        return `  ${sender}: ${m.content?.substring(0, 80) || `[${m.message_type}]`}`;
      }).join('\n');
      const more = msgs.length > 3 ? `\n  ... y ${msgs.length - 3} más` : '';
      return `${chat} (${msgs.length})\n${preview}${more}`;
    }).join('\n\n');

    return {
      success: true,
      output: `${unread.length} mensajes sin leer:\n\n${formatted}`,
    };
  }

  // ─────────────────────────────────────
  // CONTACTS
  // ─────────────────────────────────────

  private handleContacts(monitor: WhatsAppMonitor | null, params: Record<string, unknown>): ToolResult {
    const alias = params.alias ? String(params.alias) : '';
    let phone = params.phone ? String(params.phone) : '';

    // Save: alias + phone
    if (alias && phone) {
      phone = phone.replace(/[\s\-\(\)\+]/g, '');
      if (/^\d{10}$/.test(phone) && phone.startsWith('3')) {
        phone = '57' + phone;
      }
      if (phone.startsWith('0')) {
        phone = '57' + phone.substring(1);
      }

      // Save in memory facts (backward compat with contacts tool)
      const key = `contacto_${alias.toLowerCase()}`;
      this.memory.saveFact(key, phone, 'contacts', 1.0);

      // Save in wa_contacts if monitor available
      if (monitor) {
        const jid = `${phone}@s.whatsapp.net`;
        try {
          monitor.db.prepare(`
            INSERT INTO wa_contacts (jid, phone, name, alias, is_group)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT(jid) DO UPDATE SET alias = ?, updated_at = datetime('now')
          `).run(jid, phone, alias, alias, alias);
        } catch { /* ignore */ }
      }

      return { success: true, output: `📇 Contacto guardado: "${alias}" → ${phone}` };
    }

    // Search: alias only
    if (alias) {
      const results: string[] = [];

      if (monitor) {
        const contacts = monitor.db.prepare(`
          SELECT name, alias, phone FROM wa_contacts
          WHERE name LIKE ? OR alias LIKE ? OR phone LIKE ?
          LIMIT 10
        `).all(`%${alias}%`, `%${alias}%`, `%${alias}%`) as any[];
        for (const c of contacts) {
          results.push(`• ${c.alias || c.name}: ${c.phone}`);
        }
      }

      const facts = this.memory.searchFacts(`contacto_${alias}`, 10);
      for (const f of facts) {
        const name = f.key.replace('contacto_', '');
        const line = `• ${name}: ${f.value}`;
        if (!results.includes(line)) results.push(line);
      }

      if (results.length === 0) {
        return { success: true, output: `No encontré contactos con "${alias}".` };
      }

      return { success: true, output: `Contactos (${results.length}):\n${results.join('\n')}` };
    }

    // List all
    const lines: string[] = [];

    if (monitor) {
      const contacts = monitor.db.prepare(`
        SELECT name, alias, phone, message_count FROM wa_contacts
        WHERE is_group = 0
        ORDER BY message_count DESC LIMIT 30
      `).all() as any[];
      for (const c of contacts) {
        const display = c.alias || c.name;
        lines.push(`• ${display}: ${c.phone} (${c.message_count} msgs)`);
      }
    }

    const facts = this.memory.searchFacts('contacto_', 50);
    for (const f of facts) {
      const name = f.key.replace('contacto_', '');
      const line = `• ${name}: ${f.value} (alias)`;
      if (!lines.some(l => l.includes(f.value))) lines.push(line);
    }

    return {
      success: true,
      output: lines.length > 0
        ? `📇 Contactos (${lines.length}):\n${lines.join('\n')}`
        : 'No hay contactos guardados.',
    };
  }

  // ─────────────────────────────────────
  // RESOLVE RECIPIENT
  // ─────────────────────────────────────

  private async resolveRecipient(
    sock: any,
    input: string,
    monitor: WhatsAppMonitor | null
  ): Promise<{ jid: string; displayName: string } | null> {
    // 1. Direct phone number
    const cleanNumber = input.replace(/[\s\-\(\)\+]/g, '');
    if (/^\d{10,15}$/.test(cleanNumber)) {
      let number = cleanNumber;
      if (number.length === 10 && number.startsWith('3')) number = '57' + number;
      if (number.startsWith('0')) number = '57' + number.substring(1);

      try {
        const [exists] = await sock.onWhatsApp(number);
        if (exists?.exists) return { jid: exists.jid, displayName: input };
        // Number not on WhatsApp — reject
        logger.warn(`WhatsApp control: number ${number} not found on WhatsApp`);
        return null;
      } catch {
        // Verification failed — reject to be safe
        logger.warn(`WhatsApp control: could not verify ${number}`);
        return null;
      }
    }

    const inputLower = input.toLowerCase();

    // 2. Check wa_contacts by name/alias
    if (monitor) {
      const contact = monitor.findContact(input);
      if (contact) return { jid: contact.jid, displayName: contact.alias || contact.name };
    }

    // 3. Check WhatsApp contacts cache (from Baileys store)
    const contacts = this.getContacts();
    for (const [name, jid] of contacts) {
      if (name.toLowerCase().includes(inputLower) || inputLower.includes(name.toLowerCase())) {
        return { jid, displayName: name };
      }
    }

    // 4. Check memory facts (contacto_ prefix)
    const contactFacts = this.memory.searchFacts(`contacto_${input}`, 5);
    if (contactFacts.length > 0) {
      return this.resolveRecipient(sock, contactFacts[0].value, monitor);
    }

    const allContactFacts = this.memory.searchFacts('contacto_', 50);
    for (const fact of allContactFacts) {
      const alias = fact.key.replace('contacto_', '');
      if (alias.toLowerCase().includes(inputLower) || inputLower.includes(alias.toLowerCase())) {
        return this.resolveRecipient(sock, fact.value, monitor);
      }
    }

    // 5. Check WhatsApp groups
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const [jid, group] of Object.entries(groups) as Array<[string, any]>) {
        if ((group.subject as string)?.toLowerCase().includes(inputLower)) {
          return { jid, displayName: `Grupo "${group.subject}"` };
        }
      }
    } catch { /* groups not available */ }

    return null;
  }

  // ─────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────

  private groupByChat(messages: any[]): Record<string, any[]> {
    const grouped: Record<string, any[]> = {};
    for (const msg of messages) {
      const key = msg.chat_name || msg.chat_jid;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(msg);
    }
    return grouped;
  }

  private formatMessagesForSummary(grouped: Record<string, any[]>): string {
    return Object.entries(grouped).map(([chat, msgs]) => {
      const lines = msgs.map((m: any) => {
        const sender = m.is_from_me ? 'Jose' : (m.sender_name || chat);
        const time = new Date(m.timestamp).toLocaleTimeString('es-CO', {
          hour: '2-digit', minute: '2-digit',
        });
        const content = m.content || `[${m.message_type}]`;
        return `  [${time}] ${sender}: ${content}`;
      }).join('\n');
      return `── ${chat} (${msgs.length} mensajes) ──\n${lines}`;
    }).join('\n\n');
  }
}
