// ═══════════════════════════════════════
// ATLAS — Telegram Channel (grammY)
// Bot with images, commands, rate limiting
// ═══════════════════════════════════════

import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { Channel, IncomingMessage, OutgoingMessage, Attachment } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { ChannelManager } from './channel-manager';
import { VoiceHandler } from './voice-handler';
import { approvalSystem } from '../security/approval';
import { approvalContext } from '../security/approval-context';
import { config } from '../config/config';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

export class TelegramChannel implements Channel {
  name = 'telegram';
  private bot: Bot;
  private token: string;
  private memory: MemoryManager;
  private router: ModelRouter;
  private manager: ChannelManager;
  private messageHandler?: (msg: IncomingMessage) => void;
  private running = false;
  private typingIntervals: Map<number, NodeJS.Timeout> = new Map();
  private pendingApprovals: Map<string, { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }> = new Map();
  private voiceHandler?: VoiceHandler;

  constructor(
    token: string,
    memory: MemoryManager,
    router: ModelRouter,
    manager: ChannelManager,
    voiceHandler?: VoiceHandler
  ) {
    this.token = token;
    this.memory = memory;
    this.router = router;
    this.manager = manager;
    this.voiceHandler = voiceHandler;
    this.bot = new Bot(token);
    this.setupCommands();
    this.setupHandlers();
    this.setupApprovalHandler();
  }

  async start(): Promise<void> {
    logger.info('Starting Telegram bot...');
    this.running = true;
    // Start polling (non-blocking)
    this.bot.start({
      onStart: () => {
        logger.info('Telegram bot connected');
      },
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.bot.stop();
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    const numericId = Number(chatId);
    this.stopTyping(numericId);

    // Send attachments first (images, documents)
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        try {
          const source = attachment.buffer
            ? new InputFile(attachment.buffer, attachment.fileName || 'file')
            : attachment.path
              ? new InputFile(attachment.path)
              : null;

          if (!source) continue;

          if (attachment.type === 'image') {
            await this.bot.api.sendPhoto(numericId, source, {
              caption: message.text?.substring(0, 1024) || undefined,
              parse_mode: message.parseMode === 'html' ? 'HTML' : undefined,
            });
            return; // Caption replaces text when sending image
          } else {
            await this.bot.api.sendDocument(numericId, source, {
              caption: attachment.fileName || undefined,
            });
          }
        } catch (err) {
          logger.error('Telegram attachment send error', { error: err });
        }
      }
    }

    // Send text
    if (!message.text) return;
    try {
      if (message.parseMode === 'html') {
        await this.bot.api.sendMessage(numericId, message.text, { parse_mode: 'HTML' });
      } else {
        await this.bot.api.sendMessage(numericId, message.text);
      }
    } catch (err) {
      // If HTML parsing fails, try plain text
      logger.warn('Telegram send with HTML failed, retrying as plain', { error: err });
      try {
        await this.bot.api.sendMessage(numericId, message.text.replace(/<[^>]+>/g, ''));
      } catch (retryErr) {
        logger.error('Telegram send failed', { error: retryErr });
        throw retryErr;
      }
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Commands ──

  private setupCommands(): void {
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        `<b>ATLAS online.</b> Soy tu asistente personal de inteligencia.\n\n` +
        `Podés hablarme como a una persona. Usá /help para ver qué puedo hacer.`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        `<b>¿Qué puedo hacer?</b>\n\n` +
        `• Responder preguntas y conversar\n` +
        `• Ejecutar comandos del sistema\n` +
        `• Leer y escribir archivos\n` +
        `• Buscar en internet\n` +
        `• Consultar bases de datos\n` +
        `• Operaciones Git\n` +
        `• Analizar imágenes\n` +
        `• Guardar y recordar información\n\n` +
        `<b>Comandos:</b>\n` +
        `/stats — Estadísticas\n` +
        `/memory — Hechos en memoria\n` +
        `/models — Modelos disponibles\n` +
        `/clear — Limpiar sesión\n` +
        `/help — Esta ayuda`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.command('stats', async (ctx) => {
      const stats = this.memory.getStats();
      await ctx.reply(
        `<b>Estadísticas de ATLAS:</b>\n\n` +
        `📊 Sesiones: ${stats.sessions}\n` +
        `💬 Episodios: ${stats.episodes}\n` +
        `🧠 Hechos en memoria: ${stats.facts}`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.command('memory', async (ctx) => {
      const facts = this.memory.semantic.getAll(20);
      if (facts.length === 0) {
        await ctx.reply('No hay hechos en memoria.');
        return;
      }
      const lines = facts.map((f) => `• <b>${f.key}</b>: ${f.value}`);
      await ctx.reply(
        `<b>Memoria (${facts.length} hechos):</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.command('models', async (ctx) => {
      const providers = this.router.getProviderStatus();
      const lines = providers.map((p) => {
        const icon = p.available ? '✅' : '❌';
        const def = p.isDefault ? ' (default)' : '';
        return `${icon} ${p.name}${def}`;
      });
      await ctx.reply(
        `<b>Providers de modelo:</b>\n\n${lines.join('\n')}\n\n` +
        `Usá @claude, @openai o @ollama al inicio del mensaje para forzar un provider.`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.command('clear', async (ctx) => {
      const chatId = String(ctx.chat.id);
      this.manager.resetSession('telegram', chatId);
      await ctx.reply('Sesión limpiada. Empezamos de cero.');
    });
  }

  // ── Message Handlers ──

  private setupHandlers(): void {
    // Text messages
    this.bot.on('message:text', async (ctx) => {
      // Skip commands (already handled)
      if (ctx.message.text.startsWith('/')) return;

      this.startTyping(ctx.chat.id);
      this.messageHandler?.({
        id: String(ctx.message.message_id),
        channel: 'telegram',
        chatId: String(ctx.chat.id),
        userId: String(ctx.from?.id ?? 'unknown'),
        userName: ctx.from?.first_name,
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
      });
    });

    // Photos
    this.bot.on('message:photo', async (ctx) => {
      this.startTyping(ctx.chat.id);

      try {
        // Get highest resolution photo
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;

        const res = await fetch(url);
        const buffer = Buffer.from(await res.arrayBuffer());

        const attachment: Attachment = {
          type: 'image',
          buffer,
          mimeType: 'image/jpeg',
          fileSize: buffer.length,
        };

        this.messageHandler?.({
          id: String(ctx.message.message_id),
          channel: 'telegram',
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? 'unknown'),
          userName: ctx.from?.first_name,
          text: ctx.message.caption || 'Analiza esta imagen',
          attachments: [attachment],
          timestamp: new Date(ctx.message.date * 1000),
        });
      } catch (err) {
        logger.error('Error downloading Telegram photo', { error: err });
        this.stopTyping(ctx.chat.id);
        await ctx.reply('No pude descargar la imagen. Intentá de nuevo.');
      }
    });

    // Voice messages — STT→Process→TTS pipeline
    this.bot.on('message:voice', async (ctx) => {
      if (!this.voiceHandler) {
        this.stopTyping(ctx.chat.id);
        await ctx.reply('Procesamiento de voz no configurado. Necesito OPENAI_API_KEY y VOICE_AUTO_TRANSCRIBE=true.');
        return;
      }

      this.startTyping(ctx.chat.id);

      try {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
        const res = await fetch(url);
        const buffer = Buffer.from(await res.arrayBuffer());
        const mime = ctx.message.voice.mime_type || 'audio/ogg';

        const result = await this.voiceHandler.handleVoiceMessage(
          buffer, mime,
          String(ctx.chat.id),
          'telegram'
        );

        this.stopTyping(ctx.chat.id);

        // Send text response with transcription
        const responseText = `[Transcripción: "${result.transcription}"]\n\n${result.text}`;
        await this.bot.api.sendMessage(ctx.chat.id, responseText);

        // Send audio response if available
        if (result.audioBuffer) {
          await ctx.replyWithVoice(new InputFile(result.audioBuffer, 'response.ogg'));
        }
      } catch (err: any) {
        this.stopTyping(ctx.chat.id);
        logger.error('Telegram voice error', { error: err });
        await ctx.reply(`Error procesando voz: ${err.message}`);
      }
    });

    // Documents
    this.bot.on('message:document', async (ctx) => {
      this.startTyping(ctx.chat.id);

      try {
        const doc = ctx.message.document;
        const file = await ctx.api.getFile(doc.file_id);
        const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
        const res = await fetch(url);
        const buffer = Buffer.from(await res.arrayBuffer());

        const mime = doc.mime_type || 'application/octet-stream';

        // If it's an image, treat as photo
        if (mime.startsWith('image/')) {
          this.messageHandler?.({
            id: String(ctx.message.message_id),
            channel: 'telegram',
            chatId: String(ctx.chat.id),
            userId: String(ctx.from?.id ?? 'unknown'),
            userName: ctx.from?.first_name,
            text: ctx.message.caption || 'Analiza esta imagen',
            attachments: [{
              type: 'image',
              buffer,
              mimeType: mime,
              fileName: doc.file_name,
              fileSize: doc.file_size,
            }],
            timestamp: new Date(ctx.message.date * 1000),
          });
          return;
        }

        // If it's text/code, read content and pass as text
        if (mime.startsWith('text/') || mime === 'application/json' ||
            mime === 'application/javascript' || mime === 'application/xml') {
          const textContent = buffer.toString('utf-8');
          const truncated = textContent.length > 50000
            ? textContent.substring(0, 50000) + '\n... (truncado)'
            : textContent;

          this.messageHandler?.({
            id: String(ctx.message.message_id),
            channel: 'telegram',
            chatId: String(ctx.chat.id),
            userId: String(ctx.from?.id ?? 'unknown'),
            userName: ctx.from?.first_name,
            text: (ctx.message.caption || 'Analiza este archivo') +
              `\n\nArchivo: ${doc.file_name}\n\n${truncated}`,
            timestamp: new Date(ctx.message.date * 1000),
          });
          return;
        }

        // Other file types
        this.messageHandler?.({
          id: String(ctx.message.message_id),
          channel: 'telegram',
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? 'unknown'),
          userName: ctx.from?.first_name,
          text: (ctx.message.caption || '') +
            `\n\nRecibí el archivo "${doc.file_name}" (${mime}, ${doc.file_size} bytes). ` +
            `No puedo procesarlo directamente.`,
          attachments: [{
            type: 'document',
            buffer,
            mimeType: mime,
            fileName: doc.file_name,
            fileSize: doc.file_size,
          }],
          timestamp: new Date(ctx.message.date * 1000),
        });
      } catch (err) {
        logger.error('Error downloading Telegram document', { error: err });
        this.stopTyping(ctx.chat.id);
        await ctx.reply('No pude descargar el archivo. Intentá de nuevo.');
      }
    });
  }

  // ── Approval Handler ──

  private setupApprovalHandler(): void {
    // Register Telegram approval handler
    approvalSystem.setChannelHandler('telegram', async (action) => {
      const ctx = approvalContext.getStore();
      const chatId = ctx?.chatId;
      if (!chatId) {
        logger.warn('Telegram approval: no chatId in context');
        return false;
      }

      const approvalId = uuid();
      const numericId = Number(chatId);

      // Send message with inline keyboard buttons
      const keyboard = new InlineKeyboard()
        .text('Aprobar', `approve_${approvalId}`)
        .text('Rechazar', `deny_${approvalId}`);

      await this.bot.api.sendMessage(
        numericId,
        `⚠️ <b>Acción peligrosa:</b>\n${action.description}\n\n🔧 Tool: <code>${action.tool}</code>\n\n¿Aprobar esta acción?`,
        { parse_mode: 'HTML', reply_markup: keyboard }
      );

      // Wait for callback_query with 60s timeout
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingApprovals.delete(approvalId);
          this.bot.api.sendMessage(numericId, '⏰ Tiempo agotado — acción denegada.').catch(() => {});
          resolve(false);
        }, 60_000);

        this.pendingApprovals.set(approvalId, { resolve, timeout });
      });
    });

    // Handle callback_query from inline buttons
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data) return;

      let approvalId: string | null = null;
      let approved = false;

      if (data.startsWith('approve_')) {
        approvalId = data.substring('approve_'.length);
        approved = true;
      } else if (data.startsWith('deny_')) {
        approvalId = data.substring('deny_'.length);
        approved = false;
      }

      if (!approvalId) return;

      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: 'Esta solicitud ya expiró.' });
        return;
      }

      // Clean up
      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(approvalId);

      // Answer the callback and edit the message
      await ctx.answerCallbackQuery({ text: approved ? 'Aprobado' : 'Rechazado' });
      await ctx.editMessageText(
        ctx.callbackQuery.message?.text + `\n\n${approved ? '✅ Aprobado' : '❌ Rechazado'}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});

      pending.resolve(approved);
    });
  }

  // ── Typing Indicator ──

  private startTyping(chatId: number): void {
    if (this.typingIntervals.has(chatId)) return;
    // Send immediately
    this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    // Repeat every 4 seconds (Telegram typing expires after 5s)
    const interval = setInterval(() => {
      this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);
    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: number): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }
}
