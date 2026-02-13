// ═══════════════════════════════════════
// ATLAS — Channel Manager
// Orchestrates all communication channels
// ═══════════════════════════════════════

import { Channel, IncomingMessage, OutgoingMessage, ProcessResult, Attachment, MessageProcessor } from '../types';
import { MemoryManager } from '../hippocampus/memory-manager';
import { SessionManager } from '../cortex/session-manager';
import { ChannelHealthMonitor, ChannelHealthState, PingableChannel } from './channel-resilience';
import { approvalContext } from '../security/approval-context';
import logger from '../utils/logger';

export class ChannelManager {
  private channels: Map<string, Channel> = new Map();
  private defaultChatIds: Map<string, string> = new Map(); // channel → first chatId
  private queues: Map<string, Promise<void>> = new Map(); // per-chat processing queue
  private processor: MessageProcessor;
  private memory: MemoryManager;
  private sessionManager: SessionManager;
  private healthMonitor: ChannelHealthMonitor;

  constructor(processor: MessageProcessor, memory: MemoryManager, sessionManager: SessionManager) {
    this.processor = processor;
    this.memory = memory;
    this.sessionManager = sessionManager;
    this.healthMonitor = new ChannelHealthMonitor();
  }

  /** Register a channel (does NOT set onMessage for CLI — CLI handles its own loop) */
  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
    this.healthMonitor.register(channel as PingableChannel);
    logger.info(`Channel registered: ${channel.name}`);
  }

  /** Pre-set a default chatId for a channel (for scheduled task notifications before any inbound message) */
  setDefaultChatId(channelName: string, chatId: string): void {
    if (!this.defaultChatIds.has(channelName)) {
      this.defaultChatIds.set(channelName, chatId);
      logger.info(`Default chatId set for ${channelName}`);
    }
  }

  /** Connect a channel's message handler to the CognitiveLoop */
  connectHandler(channel: Channel): void {
    channel.onMessage((msg) => {
      this.enqueue(msg.chatId, () => this.handleMessage(channel, msg));
    });
  }

  /** Start all registered channels independently */
  async startAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      try {
        await channel.start();
        this.healthMonitor.markConnected(name);
        logger.info(`Channel started: ${name}`);
      } catch (err) {
        this.healthMonitor.markDisconnected(name, err instanceof Error ? err.message : String(err));
        logger.error(`Channel ${name} failed to start`, { error: err });
      }
    }
    // Start periodic health checks for channels that support ping()
    this.healthMonitor.startHealthChecks();
  }

  /** Stop all registered channels */
  async stopAll(): Promise<void> {
    this.healthMonitor.stopHealthChecks();
    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
      } catch (err) {
        logger.error(`Channel ${name} failed to stop`, { error: err });
      }
    }
  }

  /** Get or create a session for a channel+chatId pair (unified for owner) */
  getOrCreateSession(channelName: string, chatId: string): string {
    const session = this.sessionManager.getSession(chatId, channelName);
    return session.id;
  }

  /** Reset session for a channel+chatId (e.g. /clear command) */
  resetSession(channelName: string, chatId: string): string {
    const session = this.sessionManager.resetSession(chatId, channelName);
    return session.id;
  }

  /** Get the SessionManager instance */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /** Process a message through the MessageProcessor (CognitiveLoop or Coordinator) */
  async processMessage(msg: IncomingMessage): Promise<ProcessResult> {
    const sessionId = this.getOrCreateSession(msg.channel, msg.chatId);
    return this.processor.process(msg.text, sessionId, msg.channel, msg.attachments);
  }

  /** Send a message to a specific channel (for notify tool and cross-channel) */
  async sendToChannel(
    channelName: string,
    message: string,
    chatId?: string,
    attachments?: import('../types').OutgoingAttachment[]
  ): Promise<boolean> {
    if (channelName === 'all') {
      let sent = false;
      for (const [name, channel] of this.channels) {
        if (!channel.isRunning()) continue;
        const targetId = chatId ?? this.defaultChatIds.get(name);
        if (targetId) {
          try {
            await channel.sendMessage(targetId, {
              text: message,
              parseMode: this.getParseMode(name),
              attachments,
            });
            sent = true;
          } catch (err) {
            logger.error(`Failed to send to ${name}`, { error: err });
          }
        }
      }
      return sent;
    }

    // Exact match first, then prefix match (e.g. 'whatsapp' → 'whatsapp:principal')
    let resolvedName = channelName;
    let channel = this.channels.get(channelName);
    if (!channel) {
      for (const [name, ch] of this.channels) {
        if (name.startsWith(channelName + ':') && ch.isRunning()) {
          channel = ch;
          resolvedName = name;
          break;
        }
      }
    }
    if (!channel || !channel.isRunning()) return false;

    const targetId = chatId ?? this.defaultChatIds.get(resolvedName);
    if (!targetId) return false;

    try {
      await channel.sendMessage(targetId, {
        text: message,
        parseMode: this.getParseMode(resolvedName),
        attachments,
      });
      return true;
    } catch (err) {
      logger.error(`Failed to send to ${resolvedName}`, { error: err });
      return false;
    }
  }

  /** Unregister a channel by name (for dynamic removal) */
  unregister(name: string): void {
    this.channels.delete(name);
    this.defaultChatIds.delete(name);
    this.healthMonitor.unregister(name);
    logger.info(`Channel unregistered: ${name}`);
  }

  /** Get all WhatsApp channels (any channel whose name starts with 'whatsapp:') */
  getWhatsAppChannels(): Channel[] {
    return Array.from(this.channels.values()).filter(ch => ch.name.startsWith('whatsapp:'));
  }

  /** Get a registered channel by name */
  getChannel(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  /** Get names of running channels */
  getRunningChannels(): string[] {
    return Array.from(this.channels.entries())
      .filter(([, ch]) => ch.isRunning())
      .map(([name]) => name);
  }

  /** Get health status of all channels */
  getChannelHealth(): ChannelHealthState[] {
    return this.healthMonitor.getStatus();
  }

  /** Get the health monitor (for direct access) */
  getHealthMonitor(): ChannelHealthMonitor {
    return this.healthMonitor;
  }

  // ── Internal ──

  /** Per-chat sequential queue to prevent interleaved responses */
  private async enqueue(chatId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => {
      logger.error('Queue task error', { chatId, error: err });
    });
    this.queues.set(chatId, next);
  }

  /** Detect URLs in text for smart link preview */
  private extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i);
    return match ? match[0] : null;
  }

  /** Handle an incoming message: process → format → respond */
  private async handleMessage(channel: Channel, msg: IncomingMessage): Promise<void> {
    // Track default chatId for notify tool
    if (!this.defaultChatIds.has(channel.name)) {
      this.defaultChatIds.set(channel.name, msg.chatId);
    }

    // Smart Link Preview: if message is ONLY a URL (±10 chars), auto-summarize
    const trimmedText = msg.text.trim();
    const url = this.extractFirstUrl(trimmedText);
    const isOnlyUrl = url && trimmedText.replace(url, '').trim().length < 10;
    if (isOnlyUrl && url) {
      msg = { ...msg, text: `Resumí este link brevemente: ${url}` };
    }

    // Wrap in approvalContext so dangerous-action approvals route to the correct channel
    await approvalContext.run({ channel: channel.name, chatId: msg.chatId }, async () => {
      try {
        const result = await this.processMessage(msg);

        // Format response for the channel
        const formatted = this.formatForChannel(channel.name, result.response);

        // Split long messages (Telegram 4096 char limit)
        const chunks = this.splitMessage(channel.name, formatted);

        for (let i = 0; i < chunks.length; i++) {
          await channel.sendMessage(msg.chatId, {
            text: chunks[i],
            parseMode: this.getParseMode(channel.name),
          });
          // Small delay between chunks
          if (i < chunks.length - 1) {
            await this.delay(300);
          }
        }
      } catch (err) {
        logger.error(`Error processing message from ${channel.name}`, { error: err });
        try {
          await channel.sendMessage(msg.chatId, {
            text: 'Hubo un error procesando tu mensaje. Intentá de nuevo.',
            parseMode: 'plain',
          });
        } catch {
          // Ignore send errors
        }
      }
    });
  }

  /** Get parse mode for a channel */
  private getParseMode(channelName: string): 'markdown' | 'html' | 'plain' {
    if (channelName === 'telegram') return 'html';
    if (channelName === 'web') return 'markdown';
    if (channelName === 'discord') return 'markdown';
    if (channelName === 'slack') return 'plain'; // Slack handles its own mrkdwn
    if (channelName.startsWith('whatsapp:')) return 'plain';
    return 'plain';
  }

  /** Format response text for a specific channel */
  private formatForChannel(channelName: string, text: string): string {
    if (channelName === 'telegram') {
      return this.markdownToTelegramHtml(text);
    }
    return text;
  }

  /** Convert markdown to Telegram-safe HTML */
  private markdownToTelegramHtml(text: string): string {
    // 1. Extract code blocks
    const codeBlocks: string[] = [];
    let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
      codeBlocks.push(`<pre><code>${this.escapeHtml(code.trim())}</code></pre>`);
      return `__CODEBLOCK_${codeBlocks.length - 1}__`;
    });

    // 2. Extract inline code
    const inlineCodes: string[] = [];
    processed = processed.replace(/`([^`]+)`/g, (_, code) => {
      inlineCodes.push(`<code>${this.escapeHtml(code)}</code>`);
      return `__INLINE_${inlineCodes.length - 1}__`;
    });

    // 3. Escape HTML entities in remaining text
    processed = this.escapeHtml(processed);

    // 4. Apply formatting
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    processed = processed.replace(/\*(.+?)\*/g, '<i>$1</i>');

    // 5. Restore code blocks and inline code
    for (let i = 0; i < codeBlocks.length; i++) {
      processed = processed.replace(`__CODEBLOCK_${i}__`, codeBlocks[i]);
    }
    for (let i = 0; i < inlineCodes.length; i++) {
      processed = processed.replace(`__INLINE_${i}__`, inlineCodes[i]);
    }

    return processed;
  }

  /** Escape HTML special characters */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Split long messages respecting paragraph boundaries */
  private splitMessage(channelName: string, text: string): string[] {
    const limits: Record<string, number> = {
      telegram: 4000,
      discord: 1900,
      slack: 3000,
    };
    const maxLen = limits[channelName] || 0; // 0 = no limit
    if (maxLen === 0 || text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
      // Try paragraph break
      let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
      if (splitIdx < maxLen * 0.3) {
        // Try newline
        splitIdx = remaining.lastIndexOf('\n', maxLen);
      }
      if (splitIdx < maxLen * 0.3) {
        // Force split
        splitIdx = maxLen;
      }
      chunks.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
