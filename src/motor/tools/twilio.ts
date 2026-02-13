// ═══════════════════════════════════════
// ATLAS — Twilio Tool
// SMS, WhatsApp via Twilio, and voice calls
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class TwilioTool implements Tool {
  definition: ToolDefinition = {
    name: 'twilio',
    description: 'Envía SMS, mensajes de WhatsApp vía Twilio, y realiza llamadas telefónicas. Acciones: send_sms, send_whatsapp, make_call, list_messages, get_balance.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['send_sms', 'send_whatsapp', 'make_call', 'list_messages', 'get_balance'],
          description: 'Acción a realizar',
        },
        to: {
          type: 'string',
          description: 'Número destino en formato E.164. Ej: +573001234567',
        },
        message: {
          type: 'string',
          description: 'Texto del mensaje (para SMS/WhatsApp)',
        },
        tts_message: {
          type: 'string',
          description: 'Mensaje a leer por voz durante la llamada (para make_call). Usa TwiML Say.',
        },
        limit: {
          type: 'number',
          description: 'Número de mensajes a listar. Default: 10',
        },
      },
      required: ['action'],
    },
    dangerous: true,
  };

  private getClient(): any {
    const accountSid = (config as any).twilioAccountSid;
    const authToken = (config as any).twilioAuthToken;
    if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN requeridos');
    const twilio = require('twilio');
    return twilio(accountSid, authToken);
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'send_sms': return await this.sendSMS(params);
        case 'send_whatsapp': return await this.sendWhatsApp(params);
        case 'make_call': return await this.makeCall(params);
        case 'list_messages': return await this.listMessages(Number(params.limit || 10));
        case 'get_balance': return await this.getBalance();
        default: return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      if (/Cannot find module/i.test(err.message)) {
        return { success: false, output: '', error: 'npm install twilio' };
      }
      logger.error('Twilio error', { error: err, action });
      return { success: false, output: '', error: `Error Twilio: ${err.message}` };
    }
  }

  private async sendSMS(params: Record<string, unknown>): Promise<ToolResult> {
    const to = String(params.to || '');
    const body = String(params.message || '');
    if (!to || !body) return { success: false, output: '', error: 'Se requiere to y message' };

    const client = this.getClient();
    const from = (config as any).twilioPhoneNumber;
    if (!from) return { success: false, output: '', error: 'TWILIO_PHONE_NUMBER no configurado' };

    const message = await client.messages.create({ body, from, to });

    return {
      success: true,
      output: `SMS enviado a ${to}\nSID: ${message.sid}\nEstado: ${message.status}\nCosto estimado: ${message.price || 'pendiente'} ${message.priceUnit || 'USD'}`,
    };
  }

  private async sendWhatsApp(params: Record<string, unknown>): Promise<ToolResult> {
    const to = String(params.to || '');
    const body = String(params.message || '');
    if (!to || !body) return { success: false, output: '', error: 'Se requiere to y message' };

    const client = this.getClient();
    const from = (config as any).twilioWhatsAppNumber || `whatsapp:${(config as any).twilioPhoneNumber}`;

    const message = await client.messages.create({
      body,
      from: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    });

    return {
      success: true,
      output: `WhatsApp enviado a ${to}\nSID: ${message.sid}\nEstado: ${message.status}`,
    };
  }

  private async makeCall(params: Record<string, unknown>): Promise<ToolResult> {
    const to = String(params.to || '');
    const ttsMessage = String(params.tts_message || params.message || '');
    if (!to) return { success: false, output: '', error: 'Se requiere to' };
    if (!ttsMessage) return { success: false, output: '', error: 'Se requiere tts_message o message' };

    const client = this.getClient();
    const from = (config as any).twilioPhoneNumber;
    if (!from) return { success: false, output: '', error: 'TWILIO_PHONE_NUMBER no configurado' };

    const twiml = `<Response><Say language="es-CO" voice="Polly.Mia">${this.escapeXml(ttsMessage)}</Say></Response>`;

    const call = await client.calls.create({
      twiml,
      to,
      from,
    });

    return {
      success: true,
      output: `Llamada iniciada a ${to}\nSID: ${call.sid}\nEstado: ${call.status}\nMensaje TTS: "${ttsMessage.substring(0, 100)}..."`,
    };
  }

  private async listMessages(limit: number): Promise<ToolResult> {
    const client = this.getClient();
    const messages = await client.messages.list({ limit: Math.min(50, limit) });

    if (messages.length === 0) return { success: true, output: 'No hay mensajes recientes.' };

    const lines = messages.map((m: any) => {
      const dir = m.direction === 'inbound' ? '←' : '→';
      const date = new Date(m.dateCreated).toLocaleString('es-CO');
      return `  ${dir} ${m.from} → ${m.to} [${m.status}] ${date}\n    ${(m.body || '').substring(0, 80)}`;
    });

    return {
      success: true,
      output: `Mensajes recientes (${messages.length}):\n${lines.join('\n')}`,
    };
  }

  private async getBalance(): Promise<ToolResult> {
    const client = this.getClient();
    const balance = await client.balance.fetch();

    return {
      success: true,
      output: `Balance Twilio: ${balance.balance} ${balance.currency}\nAccount SID: ${balance.accountSid}`,
    };
  }

  private escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
