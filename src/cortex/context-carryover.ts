// ═══════════════════════════════════════
// ATLAS — Context Carryover
// v0.9 Feature 4: Cross-channel context handoff
// ═══════════════════════════════════════

import { MemoryManager } from '../hippocampus/memory-manager';
import { config } from '../config/config';
import logger from '../utils/logger';

export interface ChannelSwitch {
  from: string;
  to: string;
  timestamp: Date;
  sessionId: string;
}

export class ContextCarryover {
  private memory: MemoryManager;

  constructor(memory: MemoryManager) {
    this.memory = memory;
  }

  /**
   * Build a context handoff block for injection into system prompt
   * when user switches channels within the same session.
   */
  buildHandoff(switchInfo: ChannelSwitch): string {
    const maxMessages = config.contextCarryoverMessages;
    const db = this.memory.db;

    try {
      // Get last N messages from the session
      const recent = db.prepare(`
        SELECT role, content, channel, timestamp
        FROM episodes
        WHERE session_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(switchInfo.sessionId, maxMessages) as Array<{
        role: string; content: string; channel: string; timestamp: string;
      }>;

      if (recent.length === 0) return '';

      // Build handoff text
      let handoff = `## Cambio de Canal\n`;
      handoff += `El usuario cambio de ${this.formatChannel(switchInfo.from)} a ${this.formatChannel(switchInfo.to)}.\n`;
      handoff += `Ultimos ${recent.length} mensajes de la conversacion:\n\n`;

      // Messages in chronological order
      const chronological = recent.reverse();
      for (const msg of chronological) {
        const prefix = msg.role === 'user' ? 'Jose' : 'ATLAS';
        const truncated = msg.content.length > 300
          ? msg.content.substring(0, 300) + '...'
          : msg.content;
        handoff += `[${prefix}] ${truncated}\n`;
      }

      // Add any active context (recent tool calls, pending tasks)
      const recentTools = db.prepare(`
        SELECT tool, result FROM audit_log
        WHERE session_id = ? AND timestamp > datetime('now', '-1 hour')
        ORDER BY timestamp DESC LIMIT 5
      `).all(switchInfo.sessionId) as Array<{ tool: string; result: string }>;

      if (recentTools.length > 0) {
        handoff += `\nHerramientas usadas recientemente: ${recentTools.map(t => t.tool).join(', ')}`;
      }

      handoff += `\n\nContinua la conversacion de forma natural en ${this.formatChannel(switchInfo.to)}.`;

      logger.info(`Context carryover: ${switchInfo.from} → ${switchInfo.to} (${recent.length} messages)`);
      return handoff;
    } catch (err) {
      logger.error('Context carryover failed', { error: err });
      return '';
    }
  }

  private formatChannel(name: string): string {
    if (name.startsWith('whatsapp')) return 'WhatsApp';
    if (name === 'telegram') return 'Telegram';
    if (name === 'web') return 'Web';
    if (name === 'cli') return 'CLI';
    return name;
  }
}
