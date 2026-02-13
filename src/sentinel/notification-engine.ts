// ═══════════════════════════════════════════════════════
// ATLAS — Notification Engine
// Intelligent proactive notifications
// ═══════════════════════════════════════════════════════
//
// Monitors events and notifies Jose when something matters.
// Notifications route to the last active channel.

import { MemoryManager } from '../hippocampus/memory-manager';
import { ChannelManager } from '../channels/channel-manager';
import { SessionManager } from '../cortex/session-manager';
import { config } from '../config/config';
import logger from '../utils/logger';

export type NotificationPriority = 'low' | 'medium' | 'high' | 'critical';

export interface NotificationRule {
  id: string;
  name: string;
  source: 'whatsapp' | 'laravel' | 'system' | 'custom';
  description: string;
  check: () => Promise<NotificationResult | null>;
  priority: NotificationPriority;
  cooldownMinutes: number;
  channels: string[];  // preferred channels for notification
  enabled: boolean;
}

export interface NotificationResult {
  title: string;
  message: string;
  data?: any;
  actionSuggestion?: string;
}

export class NotificationEngine {
  private memory: MemoryManager;
  private channelManager: ChannelManager;
  private sessionManager: SessionManager;
  private rules: Map<string, NotificationRule> = new Map();
  private lastNotified: Map<string, number> = new Map(); // ruleId → timestamp
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    memory: MemoryManager,
    channelManager: ChannelManager,
    sessionManager: SessionManager
  ) {
    this.memory = memory;
    this.channelManager = channelManager;
    this.sessionManager = sessionManager;
    this.initTables();
    this.registerBuiltinRules();
  }

  private initTables(): void {
    this.memory.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT,
        condition_description TEXT,
        priority TEXT DEFAULT 'medium',
        cooldown_minutes INTEGER DEFAULT 60,
        channels TEXT DEFAULT '["telegram"]',
        enabled INTEGER DEFAULT 1,
        last_notified_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id TEXT,
        title TEXT,
        message TEXT,
        priority TEXT,
        channel_sent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  /** Register a notification rule */
  addRule(rule: NotificationRule): void {
    this.rules.set(rule.id, rule);
  }

  /** Remove a rule */
  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  /** Enable/disable a rule */
  toggleRule(ruleId: string, enabled: boolean): void {
    const rule = this.rules.get(ruleId);
    if (rule) rule.enabled = enabled;
  }

  /** Get all rules */
  getRules(): NotificationRule[] {
    return Array.from(this.rules.values());
  }

  /** Start periodic checking (every N minutes) */
  start(intervalMinutes: number = 5): void {
    if (this.checkInterval) return;

    this.checkInterval = setInterval(() => {
      this.checkAllRules().catch(err => {
        logger.error('Notification check failed', { error: err });
      });
    }, intervalMinutes * 60 * 1000);

    logger.info(`NotificationEngine started (check every ${intervalMinutes}min, ${this.rules.size} rules)`);
  }

  /** Stop periodic checking */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /** Run all rule checks */
  async checkAllRules(): Promise<void> {
    for (const [id, rule] of this.rules) {
      if (!rule.enabled) continue;

      // Check cooldown
      const lastTime = this.lastNotified.get(id) || 0;
      const elapsed = (Date.now() - lastTime) / 60000; // minutes
      if (elapsed < rule.cooldownMinutes) continue;

      try {
        const result = await rule.check();
        if (result) {
          await this.sendNotification(rule, result);
          this.lastNotified.set(id, Date.now());
        }
      } catch (err) {
        logger.debug(`Notification rule ${id} check error`, { error: err });
      }
    }
  }

  /** Send a notification to the appropriate channel */
  private async sendNotification(rule: NotificationRule, result: NotificationResult): Promise<void> {
    const priorityEmoji: Record<NotificationPriority, string> = {
      low: '',
      medium: '',
      high: '!',
      critical: '!!',
    };

    const prefix = priorityEmoji[rule.priority];
    const message = `${prefix ? `[${prefix}] ` : ''}${result.title}\n\n${result.message}${
      result.actionSuggestion ? `\n\n${result.actionSuggestion}` : ''
    }`;

    // Determine target channel: owner's last active channel, then rule's preferred channels
    const ownerSession = this.sessionManager.getOwnerSessionInfo();
    const lastChannel = ownerSession?.channel;

    const channelOrder = lastChannel
      ? [lastChannel, ...rule.channels.filter(c => c !== lastChannel)]
      : rule.channels;

    let sent = false;
    for (const ch of channelOrder) {
      try {
        const success = await this.channelManager.sendToChannel(ch, message);
        if (success) {
          sent = true;
          this.logNotification(rule, result, ch);
          break;
        }
      } catch {
        // Try next channel
      }
    }

    if (!sent) {
      // Fallback: try all running channels
      await this.channelManager.sendToChannel('all', message);
      this.logNotification(rule, result, 'all');
    }
  }

  /** Log notification to SQLite */
  private logNotification(rule: NotificationRule, result: NotificationResult, channelSent: string): void {
    try {
      this.memory.db.prepare(`
        INSERT INTO notification_log (rule_id, title, message, priority, channel_sent)
        VALUES (?, ?, ?, ?, ?)
      `).run(rule.id, result.title, result.message, rule.priority, channelSent);
    } catch (err) {
      logger.error('Failed to log notification', { error: err });
    }
  }

  /** Register built-in rules */
  private registerBuiltinRules(): void {
    const db = this.memory.db;

    // System: disk almost full
    this.addRule({
      id: 'sys_disk_full',
      name: 'Disco casi lleno',
      source: 'system',
      description: 'Uso de disco > 90%',
      priority: 'critical',
      cooldownMinutes: 120,
      channels: ['telegram', 'cli'],
      enabled: true,
      check: async () => {
        try {
          if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            // Use PowerShell (works on modern Windows where wmic is deprecated)
            const output = execSync(
              'powershell -NoProfile -Command "Get-PSDrive C | ForEach-Object { [math]::Round(($_.Used/($_.Used+$_.Free))*100) }"',
              { encoding: 'utf-8', timeout: 10000 }
            );
            const usagePercent = parseInt(output.trim());
            if (!isNaN(usagePercent) && usagePercent >= 90) {
              return {
                title: 'Disco casi lleno',
                message: `Uso de disco C: ${usagePercent}%. Libera espacio.`,
              };
            }
          } else {
            // Unix: use df
            const { execSync } = require('child_process');
            const output = execSync("df / | tail -1 | awk '{print $5}'", { encoding: 'utf-8' });
            const usagePercent = parseInt(output.trim().replace('%', ''));
            if (!isNaN(usagePercent) && usagePercent >= 90) {
              return {
                title: 'Disco casi lleno',
                message: `Uso de disco /: ${usagePercent}%. Libera espacio.`,
              };
            }
          }
        } catch { /* ignore */ }
        return null;
      },
    });

    // System: channel down for 5+ minutes
    this.addRule({
      id: 'sys_channel_down',
      name: 'Canal desconectado',
      source: 'system',
      description: 'Un canal lleva 5+ minutos desconectado',
      priority: 'high',
      cooldownMinutes: 30,
      channels: ['telegram', 'cli'],
      enabled: true,
      check: async () => {
        const health = this.channelManager.getChannelHealth();
        const down = health.filter(h =>
          h.status === 'disconnected' &&
          h.lastErrorAt &&
          (Date.now() - h.lastErrorAt.getTime()) > 5 * 60 * 1000
        );

        if (down.length === 0) return null;

        return {
          title: 'Canal desconectado',
          message: `Canales caidos: ${down.map(d => `${d.name} (${d.lastError || 'desconocido'})`).join(', ')}`,
          actionSuggestion: 'Puedo intentar reconectar.',
        };
      },
    });

    // System: backup failed (check last backup result)
    this.addRule({
      id: 'sys_backup_failed',
      name: 'Backup fallido',
      source: 'system',
      description: 'Ultimo backup tuvo errores',
      priority: 'high',
      cooldownMinutes: 240,
      channels: ['telegram', 'cli'],
      enabled: config.backupEnabled,
      check: async () => {
        try {
          const last = db.prepare(`
            SELECT * FROM scheduled_tasks
            WHERE handler = 'daily_backup'
            ORDER BY last_run DESC LIMIT 1
          `).get() as any;

          if (last?.lastResult && last.lastResult.includes('con errores')) {
            return {
              title: 'Backup fallido',
              message: `Ultimo backup: ${last.lastResult}`,
            };
          }
        } catch { /* table may not exist */ }
        return null;
      },
    });
  }
}
