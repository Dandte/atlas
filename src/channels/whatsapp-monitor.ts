// ═══════════════════════════════════════════════════════
// ATLAS — WhatsApp Monitor
// Escucha TODOS los mensajes de WhatsApp, almacena en SQLite.
// Se monta SOBRE el canal existente de Fase 3 (no reemplaza).
// ═══════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import { config } from '../config/config';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';

let downloadMediaMessage: any;
try {
  const baileys = require('@whiskeysockets/baileys');
  downloadMediaMessage = baileys.downloadMediaMessage;
} catch {
  // Loaded dynamically when WhatsApp channel starts
}

export class WhatsAppMonitor {
  private sock: any = null;
  public db: Database.Database;
  private mediaDir: string;
  private downloadImages: boolean;
  private downloadDocuments: boolean;
  private downloadAudio: boolean;
  private downloadVideo: boolean;
  private ignoredChats: string[];

  constructor(db: Database.Database) {
    this.db = db;
    this.mediaDir = config.whatsappMediaDir;
    this.downloadImages = config.whatsappDownloadImages;
    this.downloadDocuments = config.whatsappDownloadDocuments;
    this.downloadAudio = config.whatsappDownloadAudio;
    this.downloadVideo = config.whatsappDownloadVideo;
    this.ignoredChats = config.whatsappIgnoredChats;
    this.initDB();

    // Ensure media directory exists
    if (config.whatsappDownloadMedia && !fs.existsSync(this.mediaDir)) {
      fs.mkdirSync(this.mediaDir, { recursive: true });
    }
  }

  // ─────────────────────────────────────
  // DATABASE INITIALIZATION
  // ─────────────────────────────────────

  private initDB(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wa_messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        chat_name TEXT,
        sender_jid TEXT,
        sender_name TEXT,
        is_group INTEGER DEFAULT 0,
        is_from_me INTEGER DEFAULT 0,
        message_type TEXT DEFAULT 'text',
        content TEXT,
        media_type TEXT,
        media_path TEXT,
        quoted_message_id TEXT,
        timestamp DATETIME NOT NULL,
        is_read INTEGER DEFAULT 0,
        is_processed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_wa_chat ON wa_messages(chat_jid, timestamp);
      CREATE INDEX IF NOT EXISTS idx_wa_timestamp ON wa_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_wa_content ON wa_messages(content);
      CREATE INDEX IF NOT EXISTS idx_wa_processed ON wa_messages(is_processed);
      CREATE INDEX IF NOT EXISTS idx_wa_from_me ON wa_messages(is_from_me, timestamp);

      CREATE TABLE IF NOT EXISTS wa_daily_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        summary TEXT NOT NULL,
        total_messages INTEGER,
        total_chats INTEGER,
        highlights TEXT,
        pending_actions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_summary_date ON wa_daily_summaries(date);

      CREATE TABLE IF NOT EXISTS wa_contacts (
        jid TEXT PRIMARY KEY,
        phone TEXT,
        name TEXT,
        alias TEXT,
        is_group INTEGER DEFAULT 0,
        last_message_at DATETIME,
        message_count INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // ─────────────────────────────────────
  // ATTACH TO SOCKET
  // ─────────────────────────────────────

  /** Attach event listeners to a Baileys socket. Called on each (re)connection. */
  attachToSocket(sock: any): void {
    this.sock = sock;

    // Ensure downloadMediaMessage is loaded
    if (!downloadMediaMessage) {
      try {
        const baileys = require('@whiskeysockets/baileys');
        downloadMediaMessage = baileys.downloadMediaMessage;
      } catch { /* */ }
    }

    // LISTEN TO ALL MESSAGES
    sock.ev.on('messages.upsert', async (upsert: any) => {
      const { messages, type } = upsert;
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          await this.processMessage(msg);
        } catch (err: any) {
          logger.debug(`WA Monitor error: ${err.message}`);
        }
      }
    });

    // LISTEN TO MESSAGE STATUS UPDATES (read receipts)
    sock.ev.on('messages.update', (updates: any[]) => {
      for (const update of updates) {
        if (update.update?.status !== undefined && update.update.status >= 3 && update.key?.id) {
          try {
            this.db.prepare('UPDATE wa_messages SET is_read = 1 WHERE id = ?').run(update.key.id);
          } catch { /* ignore */ }
        }
      }
    });

    // LISTEN TO CONTACT UPDATES
    sock.ev.on('contacts.update', (contacts: any[]) => {
      for (const contact of contacts) {
        if (contact.id && contact.notify) {
          this.upsertContact(contact.id, contact.notify);
        }
      }
    });

    logger.info('WhatsApp Monitor attached — listening to all messages');
  }

  // ─────────────────────────────────────
  // PROCESS EACH MESSAGE
  // ─────────────────────────────────────

  private async processMessage(msg: any): Promise<void> {
    const key = msg.key;
    const chatJid = key.remoteJid;
    if (!chatJid) return;

    // Ignore blacklisted chats
    if (this.ignoredChats.includes(chatJid)) return;

    // Ignore status broadcasts and newsletters
    if (chatJid === 'status@broadcast') return;
    if (chatJid.endsWith('@newsletter')) return;

    const isGroup = chatJid.endsWith('@g.us');
    const isFromMe = key.fromMe || false;
    const senderJid = isGroup ? key.participant : chatJid;
    const timestamp = new Date((msg.messageTimestamp as number) * 1000);

    // Extract content
    const { content, messageType, mediaInfo } = this.extractContent(msg);
    if (!content && messageType === 'unknown') return;

    // Resolve names
    const chatName = await this.resolveName(chatJid, isGroup);
    const senderName = senderJid ? await this.resolveName(senderJid, false) : null;

    // Download media if configured
    let mediaPath: string | null = null;
    if (mediaInfo && this.shouldDownloadMedia(messageType)) {
      mediaPath = await this.downloadMedia(msg, messageType, timestamp);
    }

    // STORE IN SQLITE
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO wa_messages
          (id, chat_jid, chat_name, sender_jid, sender_name, is_group, is_from_me,
           message_type, content, media_type, media_path, quoted_message_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        key.id,
        chatJid,
        chatName,
        senderJid || null,
        senderName || null,
        isGroup ? 1 : 0,
        isFromMe ? 1 : 0,
        messageType,
        content,
        mediaInfo?.mimetype || null,
        mediaPath,
        msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
        timestamp.toISOString()
      );
    } catch (err: any) {
      if (!err.message?.includes('UNIQUE constraint')) {
        logger.debug(`WA Monitor DB error: ${err.message}`);
      }
    }

    // Update contact
    this.upsertContact(chatJid, chatName || chatJid, isGroup);

    logger.debug(
      `WA ${isFromMe ? '→' : '←'} ${chatName}${isGroup ? ` (${senderName})` : ''}: ` +
      `${content?.substring(0, 80) || `[${messageType}]`}`
    );
  }

  // ─────────────────────────────────────
  // EXTRACT CONTENT
  // ─────────────────────────────────────

  private extractContent(msg: any): {
    content: string | null;
    messageType: string;
    mediaInfo: { mimetype?: string } | null;
  } {
    const m = msg.message;
    if (!m) return { content: null, messageType: 'unknown', mediaInfo: null };

    if (m.conversation) {
      return { content: m.conversation, messageType: 'text', mediaInfo: null };
    }
    if (m.extendedTextMessage) {
      return { content: m.extendedTextMessage.text || null, messageType: 'text', mediaInfo: null };
    }
    if (m.imageMessage) {
      return {
        content: m.imageMessage.caption || '[Imagen]',
        messageType: 'image',
        mediaInfo: { mimetype: m.imageMessage.mimetype || 'image/jpeg' },
      };
    }
    if (m.videoMessage) {
      return {
        content: m.videoMessage.caption || '[Video]',
        messageType: 'video',
        mediaInfo: { mimetype: m.videoMessage.mimetype || 'video/mp4' },
      };
    }
    if (m.audioMessage) {
      const isVoiceNote = m.audioMessage.ptt;
      return {
        content: isVoiceNote ? '[Nota de voz]' : '[Audio]',
        messageType: isVoiceNote ? 'voice_note' : 'audio',
        mediaInfo: { mimetype: m.audioMessage.mimetype || 'audio/ogg' },
      };
    }
    if (m.documentMessage) {
      return {
        content: m.documentMessage.fileName || '[Documento]',
        messageType: 'document',
        mediaInfo: { mimetype: m.documentMessage.mimetype || 'application/octet-stream' },
      };
    }
    if (m.stickerMessage) {
      return { content: '[Sticker]', messageType: 'sticker', mediaInfo: null };
    }
    if (m.locationMessage) {
      const loc = m.locationMessage;
      return {
        content: `[Ubicación: ${loc.degreesLatitude}, ${loc.degreesLongitude}]`,
        messageType: 'location',
        mediaInfo: null,
      };
    }
    if (m.contactMessage) {
      return {
        content: `[Contacto: ${m.contactMessage.displayName}]`,
        messageType: 'contact',
        mediaInfo: null,
      };
    }
    if (m.reactionMessage) {
      return {
        content: `[Reacción: ${m.reactionMessage.text}]`,
        messageType: 'reaction',
        mediaInfo: null,
      };
    }
    if (m.pollCreationMessage) {
      return {
        content: `[Encuesta: ${m.pollCreationMessage.name}]`,
        messageType: 'poll',
        mediaInfo: null,
      };
    }

    return { content: null, messageType: 'unknown', mediaInfo: null };
  }

  // ─────────────────────────────────────
  // MEDIA DOWNLOAD
  // ─────────────────────────────────────

  private shouldDownloadMedia(type: string): boolean {
    if (!config.whatsappDownloadMedia) return false;
    switch (type) {
      case 'image': return this.downloadImages;
      case 'video': return this.downloadVideo;
      case 'audio':
      case 'voice_note': return this.downloadAudio;
      case 'document': return this.downloadDocuments;
      default: return false;
    }
  }

  private async downloadMedia(msg: any, type: string, timestamp: Date): Promise<string | null> {
    if (!downloadMediaMessage) return null;
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});

      const dateStr = timestamp.toISOString().split('T')[0];
      const dir = path.join(this.mediaDir, dateStr);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const ext = this.getExtension(type, msg);
      const filename = `${timestamp.getTime()}_${type}${ext}`;
      const filePath = path.join(dir, filename);

      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (err: any) {
      logger.debug(`WA Monitor: media download failed: ${err.message}`);
      return null;
    }
  }

  private getExtension(type: string, msg: any): string {
    const m = msg.message;
    switch (type) {
      case 'image': return '.jpg';
      case 'video': return '.mp4';
      case 'audio':
      case 'voice_note': return '.ogg';
      case 'document': {
        const name = m?.documentMessage?.fileName || '';
        const ext = path.extname(name);
        return ext || '.bin';
      }
      default: return '.bin';
    }
  }

  // ─────────────────────────────────────
  // NAME RESOLUTION
  // ─────────────────────────────────────

  private async resolveName(jid: string, isGroup: boolean): Promise<string> {
    // Check local DB cache
    const cached = this.db.prepare(
      'SELECT name, alias FROM wa_contacts WHERE jid = ?'
    ).get(jid) as { name: string; alias: string } | undefined;

    if (cached) return cached.alias || cached.name || jid;

    // Resolve from WhatsApp
    try {
      if (isGroup && this.sock) {
        const metadata = await this.sock.groupMetadata(jid);
        return metadata?.subject || jid;
      } else if (this.sock) {
        const contact = this.sock.store?.contacts?.[jid];
        return contact?.notify || contact?.name || contact?.verifiedName || jid.split('@')[0];
      }
    } catch { /* ignore */ }

    return jid.split('@')[0];
  }

  private upsertContact(jid: string, name: string, isGroup: boolean = false): void {
    try {
      this.db.prepare(`
        INSERT INTO wa_contacts (jid, phone, name, is_group, last_message_at, message_count)
        VALUES (?, ?, ?, ?, datetime('now'), 1)
        ON CONFLICT(jid) DO UPDATE SET
          name = COALESCE(excluded.name, name),
          last_message_at = datetime('now'),
          message_count = message_count + 1,
          updated_at = datetime('now')
      `).run(jid, jid.split('@')[0], name, isGroup ? 1 : 0);
    } catch { /* ignore */ }
  }

  // ─────────────────────────────────────
  // QUERY METHODS
  // ─────────────────────────────────────

  /** Get all messages from today, optionally filtered by chat */
  getTodayMessages(chatJid?: string): any[] {
    const today = new Date().toISOString().split('T')[0];
    if (chatJid) {
      return this.db.prepare(`
        SELECT * FROM wa_messages
        WHERE date(timestamp) = ? AND chat_jid = ?
        ORDER BY timestamp ASC
      `).all(today, chatJid);
    }
    return this.db.prepare(`
      SELECT * FROM wa_messages
      WHERE date(timestamp) = ?
      ORDER BY timestamp ASC
    `).all(today);
  }

  /** Get messages in a time range */
  getMessages(from: string, to: string, chatJid?: string): any[] {
    if (chatJid) {
      return this.db.prepare(`
        SELECT * FROM wa_messages
        WHERE timestamp BETWEEN ? AND ? AND chat_jid = ?
        ORDER BY timestamp ASC
      `).all(from, to, chatJid);
    }
    return this.db.prepare(`
      SELECT * FROM wa_messages
      WHERE timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `).all(from, to);
  }

  /** Search in message content */
  searchMessages(query: string, limit: number = 20): any[] {
    return this.db.prepare(`
      SELECT * FROM wa_messages
      WHERE content LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(`%${query}%`, limit);
  }

  /** Get messages from a specific contact (by name, alias, or JID) */
  getContactMessages(nameOrJid: string, limit: number = 50): any[] {
    // Try by JID first
    let messages = this.db.prepare(`
      SELECT * FROM wa_messages
      WHERE chat_jid = ? OR sender_jid = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(nameOrJid, nameOrJid, limit);
    if (messages.length > 0) return messages;

    // Try by contact name/alias
    const contact = this.db.prepare(`
      SELECT jid FROM wa_contacts
      WHERE name LIKE ? OR alias LIKE ?
      LIMIT 1
    `).get(`%${nameOrJid}%`, `%${nameOrJid}%`) as { jid: string } | undefined;

    if (contact) {
      return this.db.prepare(`
        SELECT * FROM wa_messages
        WHERE chat_jid = ? OR sender_jid = ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(contact.jid, contact.jid, limit);
    }

    // Try by chat_name or sender_name
    return this.db.prepare(`
      SELECT * FROM wa_messages
      WHERE chat_name LIKE ? OR sender_name LIKE ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(`%${nameOrJid}%`, `%${nameOrJid}%`, limit);
  }

  /** Get statistics for today */
  getTodayStats(): {
    totalMessages: number;
    totalChats: number;
    sentByMe: number;
    received: number;
    unread: number;
    topChats: Array<{ name: string; count: number }>;
  } {
    const today = new Date().toISOString().split('T')[0];

    const total = this.db.prepare(
      'SELECT COUNT(*) as count FROM wa_messages WHERE date(timestamp) = ?'
    ).get(today) as { count: number };

    const chats = this.db.prepare(
      'SELECT COUNT(DISTINCT chat_jid) as count FROM wa_messages WHERE date(timestamp) = ?'
    ).get(today) as { count: number };

    const sent = this.db.prepare(
      'SELECT COUNT(*) as count FROM wa_messages WHERE date(timestamp) = ? AND is_from_me = 1'
    ).get(today) as { count: number };

    const unread = this.db.prepare(
      'SELECT COUNT(*) as count FROM wa_messages WHERE date(timestamp) = ? AND is_from_me = 0 AND is_read = 0'
    ).get(today) as { count: number };

    const topChats = this.db.prepare(`
      SELECT chat_name as name, COUNT(*) as count
      FROM wa_messages WHERE date(timestamp) = ?
      GROUP BY chat_jid ORDER BY count DESC LIMIT 10
    `).all(today) as Array<{ name: string; count: number }>;

    return {
      totalMessages: total.count,
      totalChats: chats.count,
      sentByMe: sent.count,
      received: total.count - sent.count,
      unread: unread.count,
      topChats,
    };
  }

  /** Get unprocessed messages (for batch summarization) */
  getUnprocessedMessages(): any[] {
    return this.db.prepare(`
      SELECT * FROM wa_messages
      WHERE is_processed = 0
      ORDER BY timestamp ASC
    `).all();
  }

  /** Mark messages as processed */
  markAsProcessed(messageIds: string[]): void {
    const stmt = this.db.prepare('UPDATE wa_messages SET is_processed = 1 WHERE id = ?');
    for (const id of messageIds) {
      stmt.run(id);
    }
  }

  /** Find a contact by name, alias, or phone */
  findContact(nameOrAlias: string): { jid: string; name: string; alias: string | null } | null {
    return this.db.prepare(`
      SELECT jid, name, alias FROM wa_contacts
      WHERE name LIKE ? OR alias LIKE ? OR phone LIKE ?
      LIMIT 1
    `).get(`%${nameOrAlias}%`, `%${nameOrAlias}%`, `%${nameOrAlias}%`) as any || null;
  }

  /** Save a daily summary */
  saveDailySummary(date: string, summary: string, totalMessages: number, totalChats: number): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO wa_daily_summaries (date, summary, total_messages, total_chats)
        VALUES (?, ?, ?, ?)
      `).run(date, summary, totalMessages, totalChats);
    } catch { /* ignore */ }
  }

  /** Get current socket reference */
  getSocket(): any {
    return this.sock;
  }
}
