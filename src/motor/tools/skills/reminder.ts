// ═══════════════════════════════════════
// ATLAS — Skill: Reminder / Timer
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import { ChannelManager } from '../../../channels/channel-manager';
import logger from '../../../utils/logger';

export class ReminderTool implements Tool {
  private channelManager: ChannelManager;
  private timers: Map<string, NodeJS.Timeout> = new Map();

  definition = {
    name: 'reminder',
    description: 'Crear recordatorios y alarmas. ATLAS avisará cuando se cumpla el tiempo. Usar cuando digan "recordame", "avisame", "en 30 minutos", "mañana a las 9", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'Qué recordar',
        },
        when: {
          type: 'string',
          description: 'Cuándo avisar. Formatos: relativo ("5m", "30m", "1h", "2h30m"), hora ("15:00", "3pm"), fecha ("2026-02-08 09:00"), natural ("mañana a las 9", "en una hora")',
        },
        channel: {
          type: 'string',
          description: 'Por dónde avisar: "all" (todos), "telegram", "cli". Default: all',
        },
      },
      required: ['message', 'when'],
    },
    dangerous: false,
  };

  constructor(channelManager: ChannelManager) {
    this.channelManager = channelManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const message = params.message as string;
    const when = params.when as string;
    const channel = (params.channel as string) || 'all';

    const targetTime = this.parseWhen(when);

    if (!targetTime || targetTime <= Date.now()) {
      return {
        success: false, output: '',
        error: "No pude entender la hora. Probá con formato como '30m', '15:00', o '2026-02-08 09:00'.",
      };
    }

    const delayMs = targetTime - Date.now();
    const reminderId = `reminder_${Date.now()}`;

    // Schedule the reminder
    const timer = setTimeout(async () => {
      try {
        const text = `Recordatorio: ${message}`;
        await this.channelManager.sendToChannel(channel, text);
        this.timers.delete(reminderId);
      } catch (err) {
        logger.error('Failed to send reminder', { error: err });
      }
    }, delayMs);

    this.timers.set(reminderId, timer);

    const timeStr = new Date(targetTime).toLocaleString('es-CO', {
      weekday: 'short', hour: '2-digit', minute: '2-digit',
      day: 'numeric', month: 'short',
    });
    const relativeStr = this.formatDuration(delayMs);

    return {
      success: true,
      output: `Recordatorio programado:\n"${message}"\n${timeStr} (en ${relativeStr})`,
    };
  }

  private parseWhen(when: string): number | null {
    const now = new Date();
    const w = when.toLowerCase().trim();

    // Relative: "5m", "30m", "1h", "2h30m", "1h 30m"
    const relMatch = w.match(/^(\d+h)?\s*(\d+m)?$/);
    if (relMatch && (relMatch[1] || relMatch[2])) {
      let ms = 0;
      if (relMatch[1]) ms += parseInt(relMatch[1]) * 3600000;
      if (relMatch[2]) ms += parseInt(relMatch[2]) * 60000;
      return Date.now() + ms;
    }

    // "en X minutos/horas"
    const enMatch = w.match(/en\s+(\d+)\s+(minutos?|mins?|horas?|hrs?)/);
    if (enMatch) {
      const val = parseInt(enMatch[1]);
      const unit = enMatch[2];
      if (unit.startsWith('min')) return Date.now() + val * 60000;
      if (unit.startsWith('hora') || unit.startsWith('hr')) return Date.now() + val * 3600000;
    }

    // Time today: "15:00", "3pm", "3:30pm"
    const timeMatch = w.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2] || '0');
      if (timeMatch[3] === 'pm' && hours < 12) hours += 12;
      if (timeMatch[3] === 'am' && hours === 12) hours = 0;

      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
      return target.getTime();
    }

    // "mañana a las X"
    const mananaMatch = w.match(/mañana\s+(a\s+las?\s+)?(\d{1,2}):?(\d{2})?\s*(am|pm)?/);
    if (mananaMatch) {
      let hours = parseInt(mananaMatch[2]);
      const minutes = parseInt(mananaMatch[3] || '0');
      if (mananaMatch[4] === 'pm' && hours < 12) hours += 12;

      const target = new Date(now);
      target.setDate(target.getDate() + 1);
      target.setHours(hours, minutes, 0, 0);
      return target.getTime();
    }

    // Full date: "2026-02-08 09:00"
    const dateMatch = w.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (dateMatch) {
      const target = new Date(`${dateMatch[1]}T${dateMatch[2]}:00`);
      return target.getTime();
    }

    return null;
  }

  private formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} minutos`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours} horas`;
    const days = Math.floor(hours / 24);
    return `${days} día${days > 1 ? 's' : ''}`;
  }
}
