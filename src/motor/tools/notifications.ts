// ═══════════════════════════════════════
// ATLAS — Notifications Tool
// Cross-channel messaging for proactive alerts
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { ChannelManager } from '../../channels/channel-manager';
import logger from '../../utils/logger';

export class NotifyTool implements Tool {
  definition: ToolDefinition = {
    name: 'notify',
    description:
      'Enviar una notificación/mensaje a un canal específico. ' +
      'IMPORTANTE: Enviá UNA SOLA VEZ al canal donde el usuario está activo. ' +
      'Si la notificación se envió exitosamente, NO reintentes ni envíes por otro canal. ' +
      'Si un canal no está disponible, NO lo reintentes — probá otro canal UNA vez. ' +
      'Máximo 2 llamadas a notify por tarea.',
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['telegram', 'whatsapp', 'web', 'all'],
          description: 'Canal destino. Usá el canal donde el usuario esté activo. NO reintentes canales que fallen.',
        },
        message: {
          type: 'string',
          description: 'Mensaje a enviar',
        },
        chatId: {
          type: 'string',
          description: 'ID del chat destino (opcional, usa el default del usuario)',
        },
      },
      required: ['channel', 'message'],
    },
  };

  private channelManager: ChannelManager;
  private callTimestamps: number[] = []; // rate limiting
  private maxCallsPerMinute = 3;

  constructor(channelManager: ChannelManager) {
    this.channelManager = channelManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const channel = String(params.channel);
    const message = String(params.message);
    const chatId = params.chatId ? String(params.chatId) : undefined;

    if (!message) {
      return { success: false, output: '', error: 'El mensaje no puede estar vacío' };
    }

    // Rate limit: max 3 calls per minute
    const now = Date.now();
    this.callTimestamps = this.callTimestamps.filter(t => now - t < 60_000);
    if (this.callTimestamps.length >= this.maxCallsPerMinute) {
      logger.warn(`Notify rate limited: ${this.callTimestamps.length} calls in last minute`);
      return {
        success: true,
        output: 'Límite de notificaciones alcanzado (máximo 3 por minuto). La notificación ya fue enviada anteriormente, no es necesario reintentar.',
      };
    }
    this.callTimestamps.push(now);

    // Check if the specific channel is available before trying
    if (channel !== 'all') {
      const ch = this.channelManager.getChannel(channel);
      if (!ch || !ch.isRunning()) {
        // NOT an error — just inform which channels ARE available
        const available = this.channelManager.getRunningChannels();
        logger.info(`Notify: channel "${channel}" not active. Available: ${available.join(', ') || 'none'}`);
        return {
          success: true,
          output: `Canal "${channel}" no está activo. Canales disponibles: ${available.join(', ') || 'ninguno'}. Enviá a uno de los canales activos si necesitás.`,
        };
      }
    }

    try {
      const sent = await this.channelManager.sendToChannel(channel, message, chatId);

      if (sent) {
        const target = chatId ? `${channel}:${chatId}` : channel;
        logger.info(`Notification sent to ${target}`);
        return {
          success: true,
          output: `Notificación enviada exitosamente a ${target}. NO reenvíes esta notificación.`,
        };
      } else {
        // Channel exists but couldn't send (no chatId, etc.) — NOT an error for the AI
        return {
          success: true,
          output: `Canal "${channel}" está activo pero no tiene un chatId configurado. No se envió. Probá con otro canal activo.`,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: msg };
    }
  }
}
