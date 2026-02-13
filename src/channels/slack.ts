// ═══════════════════════════════════════
// ATLAS — Slack Channel (@slack/bolt)
// Socket Mode bot with threads, mentions, commands
// ═══════════════════════════════════════

import { App, LogLevel } from '@slack/bolt';
import { Channel, IncomingMessage, OutgoingMessage, Attachment } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ChannelManager } from './channel-manager';
import { approvalSystem } from '../security/approval';
import { approvalContext } from '../security/approval-context';
import { config } from '../config/config';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

const MAX_MESSAGE_LENGTH = 3000; // Slack blocks can be up to 3000 chars

export class SlackChannel implements Channel {
  name = 'slack';
  private app: App;
  private memory: MemoryManager;
  private manager: ChannelManager;
  private messageHandler?: (msg: IncomingMessage) => void;
  private running = false;
  private pendingApprovals: Map<string, { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }> = new Map();
  // Track thinking reactions per channel for removal
  private thinkingReactions: Map<string, { channel: string; timestamp: string }> = new Map();

  constructor(manager: ChannelManager, memory: MemoryManager) {
    this.manager = manager;
    this.memory = memory;

    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    this.setupHandlers();
    this.setupApprovalHandler();
  }

  async start(): Promise<void> {
    logger.info('Starting Slack bot (Socket Mode)...');
    this.running = true;
    await this.app.start();
    logger.info('Slack bot connected');
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.app.stop();
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    // Remove thinking reaction if we had one
    await this.removeThinkingReaction(chatId);

    // Extract thread_ts if chatId is in format "channelId:threadTs"
    const { channel, threadTs } = this.parseChatId(chatId);

    // Send attachments first
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        try {
          const fileBuffer = attachment.buffer
            ? attachment.buffer
            : attachment.path
              ? require('fs').readFileSync(attachment.path)
              : null;

          if (!fileBuffer) continue;

          const uploadArgs: Record<string, any> = {
            channel_id: channel,
            file: fileBuffer,
            filename: attachment.fileName || 'file',
          };
          if (threadTs) uploadArgs.thread_ts = threadTs;
          if (attachment.type === 'image' && message.text) {
            uploadArgs.initial_comment = message.text.substring(0, MAX_MESSAGE_LENGTH);
          }
          await this.app.client.filesUploadV2(uploadArgs as any);

          if (attachment.type === 'image') return; // Caption replaces text
        } catch (err) {
          logger.error('Slack attachment send error', { error: err });
        }
      }
    }

    // Send text
    if (!message.text) return;

    const formatted = this.formatForSlack(message.text);
    const chunks = this.splitText(formatted);

    for (const chunk of chunks) {
      try {
        await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs || undefined,
          text: chunk,
          mrkdwn: true,
        });
      } catch (err) {
        logger.error('Slack send failed', { error: err, chatId });
      }
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Handlers ──

  private setupHandlers(): void {
    // Direct messages and channel messages
    this.app.message(async ({ message, say }) => {
      // Ignore bot messages
      if ('bot_id' in message) return;
      if (!('text' in message) || !message.text) return;
      if (!('user' in message)) return;

      const text = message.text.trim();
      const channelId = message.channel;

      // Check allowed channels (if configured)
      if (config.slackAllowedChannels.length > 0) {
        if (!config.slackAllowedChannels.includes(channelId)) return;
      }

      // Handle commands
      if (text === '!help') {
        await this.sendHelp(say);
        return;
      }
      if (text === '!stats') {
        await this.sendStats(say);
        return;
      }
      if (text === '!clear') {
        const chatId = this.buildChatId(channelId, ('thread_ts' in message) ? message.thread_ts : undefined);
        this.manager.resetSession('slack', chatId);
        await say('Sesion limpiada. Empezamos de cero.');
        return;
      }

      // Build chatId with thread support
      const threadTs = ('thread_ts' in message) ? message.thread_ts : undefined;
      const chatId = this.buildChatId(channelId, threadTs);

      // Add thinking reaction
      await this.addThinkingReaction(channelId, message.ts, chatId);

      // Extract attachments from Slack files
      const attachments = await this.extractAttachments(message);

      this.messageHandler?.({
        id: message.ts,
        channel: 'slack',
        chatId,
        userId: message.user,
        text: message.text,
        attachments: attachments.length > 0 ? attachments : undefined,
        timestamp: new Date(parseFloat(message.ts) * 1000),
      });
    });

    // App mentions (@atlas)
    this.app.event('app_mention', async ({ event, say }) => {
      if (!event.text) return;

      // Remove the mention itself from the text
      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!text) return;

      const threadTs = event.thread_ts || event.ts;
      const chatId = this.buildChatId(event.channel, threadTs);

      await this.addThinkingReaction(event.channel, event.ts, chatId);

      this.messageHandler?.({
        id: event.ts,
        channel: 'slack',
        chatId,
        userId: event.user || 'unknown',
        text,
        timestamp: new Date(parseFloat(event.ts) * 1000),
      });
    });

    // Slash command /atlas
    this.app.command('/atlas', async ({ command, ack, respond }) => {
      await ack();

      if (!command.text || command.text === 'help') {
        await respond(this.getHelpText());
        return;
      }

      if (command.text === 'stats') {
        const stats = this.memory.getStats();
        await respond(
          `*Estadisticas de ATLAS:*\n\n` +
          `Sesiones: ${stats.sessions}\n` +
          `Episodios: ${stats.episodes}\n` +
          `Hechos: ${stats.facts}`
        );
        return;
      }

      if (command.text === 'clear') {
        const chatId = this.buildChatId(command.channel_id, undefined);
        this.manager.resetSession('slack', chatId);
        await respond('Sesion limpiada.');
        return;
      }

      // Process as regular message
      const chatId = this.buildChatId(command.channel_id, undefined);
      this.messageHandler?.({
        id: uuid(),
        channel: 'slack',
        chatId,
        userId: command.user_id,
        userName: command.user_name,
        text: command.text,
        timestamp: new Date(),
      });
      await respond('Procesando...');
    });
  }

  // ── Commands ──

  private getHelpText(): string {
    return (
      '*ATLAS — Asistente Personal de Inteligencia*\n\n' +
      '*Que puedo hacer:*\n' +
      '> Responder preguntas y conversar\n' +
      '> Ejecutar comandos del sistema\n' +
      '> Buscar en internet\n' +
      '> Analizar imagenes\n' +
      '> Guardar y recordar informacion\n\n' +
      '*Comandos:*\n' +
      '`/atlas help` — Esta ayuda\n' +
      '`/atlas stats` — Estadisticas\n' +
      '`/atlas clear` — Limpiar sesion\n' +
      '`!help` `!stats` `!clear` — Atajos en chat\n\n' +
      'Tambien podes mencionarme con @atlas.'
    );
  }

  private async sendHelp(say: Function): Promise<void> {
    await say(this.getHelpText());
  }

  private async sendStats(say: Function): Promise<void> {
    const stats = this.memory.getStats();
    await say(
      `*Estadisticas de ATLAS:*\n\n` +
      `Sesiones: ${stats.sessions}\n` +
      `Episodios: ${stats.episodes}\n` +
      `Hechos: ${stats.facts}`
    );
  }

  // ── Attachment Extraction ──

  private async extractAttachments(message: any): Promise<Attachment[]> {
    const result: Attachment[] = [];
    if (!message.files || message.files.length === 0) return result;

    for (const file of message.files) {
      try {
        const mime = file.mimetype || 'application/octet-stream';

        if (mime.startsWith('image/') && file.url_private) {
          // Download with bot token auth
          const res = await fetch(file.url_private, {
            headers: { Authorization: `Bearer ${config.slackBotToken}` },
          });
          const buffer = Buffer.from(await res.arrayBuffer());
          result.push({
            type: 'image',
            buffer,
            mimeType: mime,
            fileName: file.name,
            fileSize: file.size,
          });
        }
      } catch (err) {
        logger.error('Error downloading Slack attachment', { error: err });
      }
    }

    return result;
  }

  // ── Approval System ──

  private setupApprovalHandler(): void {
    approvalSystem.setChannelHandler('slack', async (action) => {
      const ctx = approvalContext.getStore();
      const chatId = ctx?.chatId;
      if (!chatId) {
        logger.warn('Slack approval: no chatId in context');
        return false;
      }

      const { channel, threadTs } = this.parseChatId(chatId);
      const approvalId = uuid();

      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs || undefined,
        text: `*Accion peligrosa:*\n${action.description}\n\nTool: \`${action.tool}\`\n\nAprobar esta accion?`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Accion peligrosa:*\n${action.description}\n\nTool: \`${action.tool}\``,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Aprobar' },
                style: 'primary',
                action_id: `approve_${approvalId}`,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Rechazar' },
                style: 'danger',
                action_id: `deny_${approvalId}`,
              },
            ],
          },
        ],
      });

      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingApprovals.delete(approvalId);
          this.app.client.chat.postMessage({
            channel,
            thread_ts: threadTs || undefined,
            text: 'Tiempo agotado — accion denegada.',
          }).catch(() => {});
          resolve(false);
        }, 60_000);

        this.pendingApprovals.set(approvalId, { resolve, timeout });

        // Register action handlers for this approval
        this.app.action(`approve_${approvalId}`, async ({ ack, respond }) => {
          await ack();
          const pending = this.pendingApprovals.get(approvalId);
          if (!pending) {
            await respond('Esta solicitud ya expiro.');
            return;
          }
          clearTimeout(pending.timeout);
          this.pendingApprovals.delete(approvalId);
          await respond('*Aprobado*');
          pending.resolve(true);
        });

        this.app.action(`deny_${approvalId}`, async ({ ack, respond }) => {
          await ack();
          const pending = this.pendingApprovals.get(approvalId);
          if (!pending) {
            await respond('Esta solicitud ya expiro.');
            return;
          }
          clearTimeout(pending.timeout);
          this.pendingApprovals.delete(approvalId);
          await respond('*Rechazado*');
          pending.resolve(false);
        });
      });
    });
  }

  // ── Thinking Indicator ──

  private async addThinkingReaction(channel: string, ts: string, chatId: string): Promise<void> {
    try {
      await this.app.client.reactions.add({
        channel,
        timestamp: ts,
        name: 'thinking_face',
      });
      this.thinkingReactions.set(chatId, { channel, timestamp: ts });
    } catch { /* ignore */ }
  }

  private async removeThinkingReaction(chatId: string): Promise<void> {
    const reaction = this.thinkingReactions.get(chatId);
    if (!reaction) return;
    this.thinkingReactions.delete(chatId);

    try {
      await this.app.client.reactions.remove({
        channel: reaction.channel,
        timestamp: reaction.timestamp,
        name: 'thinking_face',
      });
    } catch { /* ignore */ }
  }

  // ── Helpers ──

  private buildChatId(channelId: string, threadTs?: string): string {
    return threadTs ? `${channelId}:${threadTs}` : channelId;
  }

  private parseChatId(chatId: string): { channel: string; threadTs: string | null } {
    const parts = chatId.split(':');
    return {
      channel: parts[0],
      threadTs: parts.length > 1 ? parts.slice(1).join(':') : null,
    };
  }

  /** Convert markdown to Slack mrkdwn format */
  private formatForSlack(text: string): string {
    // **bold** → *bold*
    let formatted = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
    // _italic_ stays the same in Slack
    // [text](url) → <url|text>
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
    return formatted;
  }

  private splitText(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > MAX_MESSAGE_LENGTH) {
      let splitIdx = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
      if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
        splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      }
      if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
        splitIdx = MAX_MESSAGE_LENGTH;
      }
      chunks.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
  }
}
