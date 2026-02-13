// ═══════════════════════════════════════
// ATLAS — WhatsApp Channel (Baileys)
// Free WhatsApp Web connection via QR
// ═══════════════════════════════════════

import { Channel, IncomingMessage, OutgoingMessage } from '../types';
import { ChannelManager } from './channel-manager';
import { WhatsAppMonitor } from './whatsapp-monitor';
import { VoiceHandler } from './voice-handler';
import { WhatsAppInstanceConfig, getSessionDir } from '../config/whatsapp-instances';
import { approvalSystem } from '../security/approval';
import { approvalContext } from '../security/approval-context';
import { dashboardEvents } from '../dashboard/events';
import { config } from '../config/config';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';

// Baileys types — loaded dynamically
let makeWASocket: any;
let useMultiFileAuthState: any;
let DisconnectReason: any;
let downloadMediaMessage: any;

export type WhatsAppStatus = 'connected' | 'disconnected' | 'connecting' | 'qr_pending';

export class WhatsAppChannel implements Channel {
  name: string;
  private instanceId: string;
  private instanceConfig: WhatsAppInstanceConfig;
  private sock: any = null;
  private manager: ChannelManager;
  private messageHandler?: (msg: IncomingMessage) => void;
  private running = false;
  private status: WhatsAppStatus = 'disconnected';
  private allowedNumbers: string[];
  private sessionDir: string;
  private reconnecting = false;
  private lidToPhone: Map<string, string> = new Map();
  private processedMsgIds: Set<string> = new Set();
  private maxProcessedIds = 2000; // In-memory dedup (60s staleness check + this provides full dedup coverage)
  private pendingApprovals: Map<string, { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }> = new Map();
  private contactsCache: Map<string, string> = new Map(); // name → jid
  private monitor: WhatsAppMonitor | null = null;
  private voiceHandler?: VoiceHandler;

  constructor(manager: ChannelManager, db?: Database.Database, instanceId?: string, instanceConfig?: WhatsAppInstanceConfig, voiceHandler?: VoiceHandler) {
    this.instanceId = instanceId || 'default';
    this.instanceConfig = instanceConfig || {
      id: 'default',
      displayName: 'WhatsApp Principal',
      enabled: true,
      allowedNumbers: config.whatsappAllowedNumbers,
      monitorEnabled: config.whatsappMonitorEnabled,
      isOwner: true,
    };
    this.name = `whatsapp:${this.instanceId}`;
    this.manager = manager;
    this.allowedNumbers = this.instanceConfig.allowedNumbers;
    this.sessionDir = getSessionDir(this.instanceId);

    this.voiceHandler = voiceHandler;

    // Initialize monitor if enabled and db provided
    if (db && this.instanceConfig.monitorEnabled) {
      this.monitor = new WhatsAppMonitor(db);
    }
  }

  /**
   * Load LID→phone mappings from Baileys session files.
   * Files named `lid-mapping-{lid}_reverse.json` contain the phone number.
   */
  private loadLidMappings(): void {
    try {
      const files = fs.readdirSync(this.sessionDir);
      for (const file of files) {
        const match = file.match(/^lid-mapping-(\d+)_reverse\.json$/);
        if (match) {
          const lid = match[1];
          const phone = JSON.parse(fs.readFileSync(path.join(this.sessionDir, file), 'utf-8'));
          if (typeof phone === 'string') {
            this.lidToPhone.set(lid, phone);
          }
        }
      }
      logger.info(`WhatsApp LID mappings loaded: ${this.lidToPhone.size} entries`);
    } catch (err) {
      logger.warn('Could not load LID mappings', { error: err });
    }
  }

  /**
   * Resolve a JID to a phone number.
   * Handles both @s.whatsapp.net (direct phone) and @lid (needs mapping).
   */
  private resolvePhoneNumber(jid: string): string | null {
    const [id, suffix] = jid.split('@');
    if (suffix === 's.whatsapp.net') {
      return id;
    }
    if (suffix === 'lid') {
      // Check cached mapping
      if (this.lidToPhone.has(id)) {
        return this.lidToPhone.get(id)!;
      }
      // Try reading from file (may have been created after startup)
      try {
        const filePath = path.join(this.sessionDir, `lid-mapping-${id}_reverse.json`);
        if (fs.existsSync(filePath)) {
          const phone = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (typeof phone === 'string') {
            this.lidToPhone.set(id, phone);
            return phone;
          }
        }
      } catch {
        // ignore read errors
      }
      return null;
    }
    return id;
  }

  async start(): Promise<void> {
    // Dynamic import for Baileys (may be ESM)
    try {
      const baileys = require('@whiskeysockets/baileys');
      makeWASocket = baileys.default || baileys.makeWASocket || baileys;
      useMultiFileAuthState = baileys.useMultiFileAuthState;
      DisconnectReason = baileys.DisconnectReason;
      downloadMediaMessage = baileys.downloadMediaMessage;
    } catch (err) {
      throw new Error('@whiskeysockets/baileys no está instalado. Ejecutá: npm install @whiskeysockets/baileys');
    }

    await this.connect();
    this.setupApprovalHandler();
  }

  private setupApprovalHandler(): void {
    approvalSystem.setChannelHandler(this.name, async (action) => {
      const ctx = approvalContext.getStore();
      const chatId = ctx?.chatId;
      if (!chatId || !this.sock) {
        logger.warn('WhatsApp approval: no chatId or socket');
        return false;
      }

      // Send approval question as text message
      await this.sock.sendMessage(chatId, {
        text: `⚠️ *Acción peligrosa:*\n${action.description}\n\n🔧 Tool: ${action.tool}\n\n¿Aprobar? Responde *SI* o *NO*`,
      });

      // Wait for next message from this chatId as SI/NO response
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingApprovals.delete(chatId);
          this.sock?.sendMessage(chatId, { text: '⏰ Tiempo agotado — acción denegada.' }).catch(() => {});
          resolve(false);
        }, 60_000);

        this.pendingApprovals.set(chatId, { resolve, timeout });
      });
    });
  }

  private async connect(): Promise<void> {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

      // Silence Baileys' pino logger to prevent JSON noise on stdout
      const pino = require('pino');
      const silentLogger = pino({ level: 'silent' });

      // Intercept console.log/warn/error to suppress Signal protocol noise
      // (Baileys/libsignal dumps crypto debug directly to console)
      const origLog = console.log;
      const origWarn = console.warn;
      const origError = console.error;

      const isBaileysNoise = (...args: any[]): boolean => {
        const first = typeof args[0] === 'string' ? args[0] : '';
        if (first.includes('Closing session') || first.includes('Closed session')
          || first.includes('Decrypted message') || first.includes('Bad MAC')
          || first.includes('SessionEntry') || first.includes('SenderKeyRecord')
          || first.includes('preKeyId') || first.includes('signedPreKeyId')
          || first.includes('ciphertext message') || first.includes('session not found')
          || first.includes('No matching sessions')) {
          return true;
        }
        if (args.length > 0 && args[0]?.constructor?.name === 'SessionEntry') return true;
        // Suppress raw buffer/object dumps from libsignal (they have registrationId, currentRatchet, etc.)
        if (typeof args[0] === 'object' && args[0] !== null && ('registrationId' in args[0] || 'currentRatchet' in args[0])) return true;
        return false;
      };

      console.log = (...args: any[]) => {
        if (isBaileysNoise(...args)) return;
        origLog.apply(console, args);
      };
      console.warn = (...args: any[]) => {
        if (isBaileysNoise(...args)) return;
        origWarn.apply(console, args);
      };
      console.error = (...args: any[]) => {
        if (isBaileysNoise(...args)) return;
        origError.apply(console, args);
      };

      this.sock = makeWASocket({
        auth: state,
        logger: silentLogger,
      });

      // Save credentials on update
      this.sock.ev.on('creds.update', saveCreds);

      // Connection status + QR code handling
      this.sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        // Display QR code in terminal + emit to dashboard
        if (qr) {
          this.status = 'qr_pending';
          dashboardEvents.emitChannelStatus({
            channelId: this.name,
            status: 'qr_pending',
            displayName: this.instanceConfig.displayName,
            phoneHint: this.instanceConfig.phoneHint,
          });

          // Generate base64 PNG for dashboard
          try {
            const qrcodeLib = require('qrcode');
            const qrDataUrl: string = await qrcodeLib.toDataURL(qr, { width: 256 });
            dashboardEvents.emitChannelQR({ channelId: this.name, qrDataUrl });
          } catch {
            // qrcode lib not available, skip dashboard QR
          }

          // Terminal QR
          try {
            const qrcodeTerm = require('qrcode-terminal');
            console.log(`\n  ${this.instanceConfig.displayName} — Escaneá este QR:\n`);
            qrcodeTerm.generate(qr, { small: true }, (qrArt: string) => {
              const indented = qrArt.split('\n').map((l: string) => `  ${l}`).join('\n');
              console.log(indented);
            });
            console.log('');
          } catch {
            console.log(`\n  ${this.instanceConfig.displayName} QR: ${qr}\n`);
          }
        }

        if (connection === 'connecting') {
          this.status = 'connecting';
          dashboardEvents.emitChannelStatus({
            channelId: this.name,
            status: 'connecting',
            displayName: this.instanceConfig.displayName,
            phoneHint: this.instanceConfig.phoneHint,
          });
        }

        if (connection === 'close') {
          this.running = false;
          this.status = 'disconnected';
          dashboardEvents.emitChannelStatus({
            channelId: this.name,
            status: 'disconnected',
            displayName: this.instanceConfig.displayName,
            phoneHint: this.instanceConfig.phoneHint,
          });

          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

          if (statusCode !== DisconnectReason?.loggedOut && !this.reconnecting) {
            logger.info(`${this.name} desconectado. Reconectando...`);
            this.reconnecting = true;
            setTimeout(() => {
              this.reconnecting = false;
              this.connect().catch((err) => {
                logger.error(`${this.name} reconnection failed`, { error: err });
              });
            }, 3000);
          } else if (statusCode === DisconnectReason?.loggedOut) {
            logger.warn(`${this.name} logged out. Borrá la sesión y escaneá QR de nuevo.`);
          }
        }

        if (connection === 'open') {
          this.running = true;
          this.status = 'connected';
          this.loadLidMappings();
          this.loadContacts();

          // Attach monitor to new socket (re-registers listeners on reconnect)
          if (this.monitor) {
            this.monitor.attachToSocket(this.sock);
          }

          dashboardEvents.emitChannelStatus({
            channelId: this.name,
            status: 'connected',
            displayName: this.instanceConfig.displayName,
            phoneHint: this.instanceConfig.phoneHint,
          });

          console.log(`  ${this.instanceConfig.displayName} conectado ✅`);
          logger.info(`${this.name} conectado`);
        }
      });

      // Incoming messages
      this.sock.ev.on('messages.upsert', async (upsert: any) => {
        const { messages, type } = upsert;
        if (!messages) return;

        for (const msg of messages) {
          // Skip status broadcasts
          if (msg.key.remoteJid === 'status@broadcast') continue;
          if (!msg.key.remoteJid) continue;

          // Skip own messages
          if (msg.key.fromMe) continue;

          // Only process new incoming messages
          if (type !== 'notify') continue;

          // Dedup: skip already-processed messages (prevents re-processing on reconnect)
          const msgId = msg.key.id;
          if (msgId && this.processedMsgIds.has(msgId)) {
            logger.debug(`WhatsApp skipping already-processed message: ${msgId}`);
            continue;
          }
          if (msgId) {
            this.processedMsgIds.add(msgId);
            // Cap memory — drop oldest entries when set grows too large
            if (this.processedMsgIds.size > this.maxProcessedIds) {
              const first = this.processedMsgIds.values().next().value;
              if (first) this.processedMsgIds.delete(first);
            }
          }

          // Skip old messages (older than 60 seconds) — likely replayed on reconnect
          const msgTimestamp = (msg.messageTimestamp as number) || 0;
          const nowSecs = Math.floor(Date.now() / 1000);
          if (msgTimestamp > 0 && (nowSecs - msgTimestamp) > 60) {
            logger.debug(`WhatsApp skipping old message (${nowSecs - msgTimestamp}s old): ${msgId}`);
            continue;
          }

          // Resolve JID to phone number (handles both @s.whatsapp.net and @lid)
          const chatId = msg.key.remoteJid;
          const number = this.resolvePhoneNumber(chatId);

          // Security: check allowed numbers
          if (this.allowedNumbers.length > 0) {
            if (!number || !this.allowedNumbers.includes(number)) {
              logger.debug(`WhatsApp blocked message from ${chatId} (resolved: ${number || 'unknown'})`);
              continue;
            }
          }

          // Extract text
          const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || '';

          // Check for images
          if (msg.message?.imageMessage) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const caption = msg.message.imageMessage.caption || 'Analiza esta imagen';
              const mime = msg.message.imageMessage.mimetype || 'image/jpeg';

              this.messageHandler?.({
                id: msg.key.id || uuid(),
                channel: this.name,
                chatId,
                userId: number || chatId.split('@')[0],
                text: caption,
                attachments: [{
                  type: 'image',
                  buffer: Buffer.from(buffer),
                  mimeType: mime,
                }],
                timestamp: new Date((msg.messageTimestamp as number) * 1000),
              });
              continue;
            } catch (err) {
              logger.error('Error downloading WhatsApp image', { error: err });
            }
          }

          // Check for audio/voice messages (PTT = push-to-talk, audioMessage = audio files)
          const audioMsg = msg.message?.audioMessage || (msg.message as any)?.pttMessage;
          if (audioMsg && this.voiceHandler) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const mime = audioMsg.mimetype || 'audio/ogg';

              const result = await this.voiceHandler.handleVoiceMessage(
                Buffer.from(buffer), mime,
                chatId,
                this.name
              );

              // Send transcription + response as text
              await this.sock.sendMessage(chatId, {
                text: `[Transcripción: "${result.transcription}"]\n\n${result.text}`
              });

              // Send audio response if available
              if (result.audioBuffer) {
                await this.sock.sendMessage(chatId, {
                  audio: result.audioBuffer,
                  mimetype: 'audio/mpeg',
                });
              }
              continue;
            } catch (err: any) {
              logger.error('WhatsApp voice error', { error: err });
            }
          }

          if (!text) continue;

          // Check if this is an approval response (SI/NO)
          const pendingApproval = this.pendingApprovals.get(chatId);
          if (pendingApproval) {
            const normalized = text.trim().toUpperCase();
            if (normalized === 'SI' || normalized === 'SÍ' || normalized === 'YES' || normalized === 'S' || normalized === 'Y') {
              clearTimeout(pendingApproval.timeout);
              this.pendingApprovals.delete(chatId);
              pendingApproval.resolve(true);
              continue;
            } else if (normalized === 'NO' || normalized === 'N') {
              clearTimeout(pendingApproval.timeout);
              this.pendingApprovals.delete(chatId);
              pendingApproval.resolve(false);
              continue;
            }
            // If it's not SI/NO, treat as a regular message (and auto-deny the pending approval)
            clearTimeout(pendingApproval.timeout);
            this.pendingApprovals.delete(chatId);
            pendingApproval.resolve(false);
          }

          this.messageHandler?.({
            id: msg.key.id || uuid(),
            channel: this.name,
            chatId,
            userId: number || chatId.split('@')[0],
            text,
            timestamp: new Date((msg.messageTimestamp as number) * 1000),
          });
        }
      });
    } catch (err) {
      logger.error('WhatsApp connection error', { error: err });
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.status = 'disconnected';
    this.reconnecting = true; // Prevent auto-reconnect
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore close errors
      }
      this.sock = null;
    }
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    if (!this.sock) return;

    try {
      // Send attachments (images, documents)
      if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
          const media = attachment.buffer || (attachment.path ? require('fs').readFileSync(attachment.path) : null);
          if (!media) continue;

          if (attachment.type === 'image') {
            await this.sock.sendMessage(chatId, {
              image: media,
              caption: message.text || undefined,
            });
            return; // Caption replaces text when sending image
          } else if (attachment.type === 'document') {
            await this.sock.sendMessage(chatId, {
              document: media,
              fileName: attachment.fileName || 'file',
              caption: message.text || undefined,
            });
            return;
          } else if (attachment.type === 'audio') {
            await this.sock.sendMessage(chatId, {
              audio: media,
              mimetype: 'audio/mpeg',
            });
          }
        }
      }

      // Send text
      if (message.text) {
        await this.sock.sendMessage(chatId, { text: message.text });
      }
    } catch (err) {
      logger.error('WhatsApp send error', { chatId, error: err });
      throw err;
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Get the Baileys socket (for WhatsAppSendTool) */
  getSocket(): any {
    return this.sock;
  }

  /** Get the WhatsApp Monitor instance (for WhatsAppControlTool) */
  getMonitor(): WhatsAppMonitor | null {
    return this.monitor;
  }

  /** Get contacts cache (name → jid) for WhatsAppSendTool */
  getContactsCache(): Map<string, string> {
    return this.contactsCache;
  }

  /** Load WhatsApp contacts into cache for name resolution */
  private async loadContacts(): Promise<void> {
    try {
      // Baileys stores contacts via store or sock.store
      const store = this.sock?.store;
      if (!store?.contacts) {
        logger.debug('WhatsApp: no contacts store available');
        return;
      }

      const contacts = store.contacts;
      for (const [jid, contact] of Object.entries(contacts) as Array<[string, any]>) {
        const name = contact.notify || contact.name || contact.verifiedName;
        if (name && jid.includes('@s.whatsapp.net')) {
          this.contactsCache.set(name, jid);
        }
      }

      logger.info(`${this.name} contacts loaded: ${this.contactsCache.size} entries`);
    } catch (err) {
      logger.debug(`${this.name}: could not load contacts cache`, { error: err });
    }
  }

  // ── Multi-instance management methods ──

  /** Get instance identifier */
  getInstanceId(): string {
    return this.instanceId;
  }

  /** Get current connection status */
  getStatus(): WhatsAppStatus {
    return this.status;
  }

  /** Get instance config */
  getInstanceConfig(): WhatsAppInstanceConfig {
    return this.instanceConfig;
  }

  /** Disconnect cleanly (without logout — preserves session for reconnect) */
  async disconnect(): Promise<void> {
    this.running = false;
    this.status = 'disconnected';
    this.reconnecting = true;
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch { /* ignore */ }
      this.sock = null;
    }
    dashboardEvents.emitChannelStatus({
      channelId: this.name,
      status: 'disconnected',
      displayName: this.instanceConfig.displayName,
      phoneHint: this.instanceConfig.phoneHint,
    });
  }

  /** Reconnect (disconnect + start again) */
  async reconnect(): Promise<void> {
    await this.disconnect();
    this.reconnecting = false;
    await this.connect();
    this.setupApprovalHandler();
  }

  /** Delete session files (for re-linking with new QR) */
  async deleteSession(): Promise<void> {
    await this.disconnect();
    try {
      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
        logger.info(`${this.name} session deleted: ${this.sessionDir}`);
      }
    } catch (err) {
      logger.error(`Failed to delete session for ${this.name}`, { error: err });
    }
  }
}
