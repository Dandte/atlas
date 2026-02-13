// ═══════════════════════════════════════
// ATLAS — Discord Channel (discord.js v14)
// Bot with images, slash commands, approval buttons
// ═══════════════════════════════════════

import {
  Client,
  GatewayIntentBits,
  Events,
  Message as DiscordMessage,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  Interaction,
  Partials,
} from 'discord.js';
import { Channel, IncomingMessage, OutgoingMessage, Attachment } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { ModelRouter } from '../thalamus/model-router';
import { ChannelManager } from './channel-manager';
import { approvalSystem } from '../security/approval';
import { approvalContext } from '../security/approval-context';
import { config } from '../config/config';
import logger from '../utils/logger';
import { v4 as uuid } from 'uuid';

const MAX_MESSAGE_LENGTH = 1900; // Discord limit is 2000, leave room for formatting

export class DiscordChannel implements Channel {
  name = 'discord';
  private client: Client;
  private token: string;
  private memory: MemoryManager;
  private router: ModelRouter;
  private manager: ChannelManager;
  private messageHandler?: (msg: IncomingMessage) => void;
  private running = false;
  private typingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private pendingApprovals: Map<string, { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }> = new Map();

  constructor(
    token: string,
    memory: MemoryManager,
    router: ModelRouter,
    manager: ChannelManager
  ) {
    this.token = token;
    this.memory = memory;
    this.router = router;
    this.manager = manager;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // Required for DM support
    });

    this.setupHandlers();
    this.setupApprovalHandler();
  }

  async start(): Promise<void> {
    logger.info('Starting Discord bot...');
    this.running = true;

    this.client.once(Events.ClientReady, (c) => {
      logger.info(`Discord bot connected as ${c.user.tag}`);
    });

    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.client.destroy();
  }

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<void> {
    this.stopTyping(chatId);

    const channel = await this.resolveChannel(chatId);
    if (!channel) {
      logger.warn(`Discord: cannot resolve channel ${chatId}`);
      return;
    }

    // Send attachments first
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        try {
          const source = attachment.buffer
            ? new AttachmentBuilder(attachment.buffer, { name: attachment.fileName || 'file' })
            : attachment.path
              ? new AttachmentBuilder(attachment.path, { name: attachment.fileName || 'file' })
              : null;

          if (!source) continue;

          if (attachment.type === 'image') {
            await channel.send({
              content: message.text?.substring(0, MAX_MESSAGE_LENGTH) || undefined,
              files: [source],
            });
            return; // Caption replaces text when sending image
          } else {
            await channel.send({ files: [source] });
          }
        } catch (err) {
          logger.error('Discord attachment send error', { error: err });
        }
      }
    }

    // Send text
    if (!message.text) return;

    const chunks = this.splitText(message.text);
    for (const chunk of chunks) {
      try {
        await channel.send(chunk);
      } catch (err) {
        logger.error('Discord send failed', { error: err, chatId });
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
    this.client.on(Events.MessageCreate, async (msg: DiscordMessage) => {
      // Ignore bot messages (including self)
      if (msg.author.bot) return;

      // Check allowed guilds (if configured)
      if (msg.guild && config.discordAllowedGuilds.length > 0) {
        if (!config.discordAllowedGuilds.includes(msg.guild.id)) return;
      }

      // Handle built-in commands
      const text = msg.content.trim();
      if (text.startsWith('!atlas ') || text.startsWith('/atlas ')) {
        const command = text.substring(7).trim();
        if (await this.handleCommand(msg, command)) return;
      }

      // Handle standalone commands
      if (text === '!help' || text === '/help') {
        await this.sendHelp(msg);
        return;
      }
      if (text === '!stats' || text === '/stats') {
        await this.sendStats(msg);
        return;
      }
      if (text === '!clear' || text === '/clear') {
        this.manager.resetSession('discord', msg.channelId);
        await msg.reply('Sesion limpiada. Empezamos de cero.');
        return;
      }
      if (text === '!models' || text === '/models') {
        await this.sendModels(msg);
        return;
      }

      // Regular message → process via CognitiveLoop
      this.startTyping(msg.channelId, msg.channel as TextChannel);

      // Build attachments from Discord message
      const attachments = await this.extractAttachments(msg);

      this.messageHandler?.({
        id: msg.id,
        channel: 'discord',
        chatId: msg.channelId,
        userId: msg.author.id,
        userName: msg.author.displayName || msg.author.username,
        text: msg.content,
        attachments: attachments.length > 0 ? attachments : undefined,
        timestamp: msg.createdAt,
      });
    });
  }

  // ── Commands ──

  private async handleCommand(msg: DiscordMessage, command: string): Promise<boolean> {
    switch (command) {
      case 'help':
        await this.sendHelp(msg);
        return true;
      case 'stats':
        await this.sendStats(msg);
        return true;
      case 'clear':
        this.manager.resetSession('discord', msg.channelId);
        await msg.reply('Sesion limpiada. Empezamos de cero.');
        return true;
      case 'models':
        await this.sendModels(msg);
        return true;
      default:
        return false;
    }
  }

  private async sendHelp(msg: DiscordMessage): Promise<void> {
    await msg.reply(
      '**ATLAS — Asistente Personal de Inteligencia**\n\n' +
      '**Que puedo hacer:**\n' +
      '> Responder preguntas y conversar\n' +
      '> Ejecutar comandos del sistema\n' +
      '> Leer y escribir archivos\n' +
      '> Buscar en internet\n' +
      '> Analizar imagenes\n' +
      '> Guardar y recordar informacion\n\n' +
      '**Comandos:**\n' +
      '`!help` — Esta ayuda\n' +
      '`!stats` — Estadisticas\n' +
      '`!models` — Modelos disponibles\n' +
      '`!clear` — Limpiar sesion\n\n' +
      'Tambien podes hablarme directamente.'
    );
  }

  private async sendStats(msg: DiscordMessage): Promise<void> {
    const stats = this.memory.getStats();
    await msg.reply(
      '**Estadisticas de ATLAS:**\n\n' +
      `Sesiones: ${stats.sessions}\n` +
      `Episodios: ${stats.episodes}\n` +
      `Hechos en memoria: ${stats.facts}`
    );
  }

  private async sendModels(msg: DiscordMessage): Promise<void> {
    const providers = this.router.getProviderStatus();
    const lines = providers.map((p) => {
      const icon = p.available ? ':white_check_mark:' : ':x:';
      const def = p.isDefault ? ' (default)' : '';
      return `${icon} ${p.name}${def}`;
    });
    await msg.reply(
      '**Providers de modelo:**\n\n' +
      lines.join('\n') +
      '\n\nUsa `@claude`, `@openai` o `@ollama` al inicio del mensaje para forzar un provider.'
    );
  }

  // ── Image/Attachment Extraction ──

  private async extractAttachments(msg: DiscordMessage): Promise<Attachment[]> {
    const result: Attachment[] = [];

    for (const [, attachment] of msg.attachments) {
      try {
        const mime = attachment.contentType || 'application/octet-stream';

        if (mime.startsWith('image/')) {
          const res = await fetch(attachment.url);
          const buffer = Buffer.from(await res.arrayBuffer());
          result.push({
            type: 'image',
            buffer,
            mimeType: mime,
            fileName: attachment.name || undefined,
            fileSize: attachment.size,
          });
        } else if (mime.startsWith('text/') || mime === 'application/json') {
          // Text files: download and include content in message text
          const res = await fetch(attachment.url);
          const textContent = await res.text();
          const truncated = textContent.length > 50000
            ? textContent.substring(0, 50000) + '\n... (truncado)'
            : textContent;
          // Append to message text (handled by messageHandler)
          msg.content += `\n\nArchivo: ${attachment.name}\n\n${truncated}`;
        } else {
          result.push({
            type: 'document',
            mimeType: mime,
            fileName: attachment.name || undefined,
            fileSize: attachment.size,
            url: attachment.url,
          });
        }
      } catch (err) {
        logger.error('Error downloading Discord attachment', { error: err });
      }
    }

    return result;
  }

  // ── Approval System ──

  private setupApprovalHandler(): void {
    approvalSystem.setChannelHandler('discord', async (action) => {
      const ctx = approvalContext.getStore();
      const chatId = ctx?.chatId;
      if (!chatId) {
        logger.warn('Discord approval: no chatId in context');
        return false;
      }

      const channel = await this.resolveChannel(chatId);
      if (!channel) return false;

      const approvalId = uuid();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${approvalId}`)
          .setLabel('Aprobar')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`deny_${approvalId}`)
          .setLabel('Rechazar')
          .setStyle(ButtonStyle.Danger),
      );

      await channel.send({
        content: `**Accion peligrosa:**\n${action.description}\n\nTool: \`${action.tool}\`\n\nAprobar esta accion?`,
        components: [row],
      });

      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingApprovals.delete(approvalId);
          channel.send('Tiempo agotado — accion denegada.').catch(() => {});
          resolve(false);
        }, 60_000);

        this.pendingApprovals.set(approvalId, { resolve, timeout });
      });
    });

    // Handle button interactions
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isButton()) return;

      const customId = interaction.customId;
      let approvalId: string | null = null;
      let approved = false;

      if (customId.startsWith('approve_')) {
        approvalId = customId.substring('approve_'.length);
        approved = true;
      } else if (customId.startsWith('deny_')) {
        approvalId = customId.substring('deny_'.length);
        approved = false;
      }

      if (!approvalId) return;

      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) {
        await interaction.reply({ content: 'Esta solicitud ya expiro.', ephemeral: true });
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingApprovals.delete(approvalId);

      await interaction.update({
        content: interaction.message.content + `\n\n${approved ? '**Aprobado**' : '**Rechazado**'}`,
        components: [], // Remove buttons
      });

      pending.resolve(approved);
    });
  }

  // ── Typing Indicator ──

  private startTyping(chatId: string, channel?: TextChannel): void {
    if (this.typingIntervals.has(chatId)) return;

    // Send immediately
    if (channel) {
      channel.sendTyping().catch(() => {});
    }

    // Repeat every 8 seconds (Discord typing expires after 10s)
    const interval = setInterval(async () => {
      try {
        const ch = await this.resolveChannel(chatId);
        if (ch) ch.sendTyping();
      } catch { /* ignore */ }
    }, 8000);

    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  // ── Helpers ──

  private async resolveChannel(chatId: string): Promise<TextChannel | null> {
    try {
      const ch = await this.client.channels.fetch(chatId);
      if (ch && ch.isTextBased() && 'send' in ch) {
        return ch as TextChannel;
      }
    } catch (err) {
      logger.error('Discord: failed to resolve channel', { chatId, error: err });
    }
    return null;
  }

  private splitText(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > MAX_MESSAGE_LENGTH) {
      // Try paragraph break
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
