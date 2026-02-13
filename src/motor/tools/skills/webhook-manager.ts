// ═══════════════════════════════════════
// ATLAS — Skill: Webhook Manager
// Create, list, delete, test webhooks
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import type { WebhookServer } from '../../../sentinel/webhook-server';
import crypto from 'crypto';

export class WebhookManagerTool implements Tool {
  private getServer: () => WebhookServer | null;
  private webhookPort: number;

  constructor(getServer: () => WebhookServer | null, webhookPort: number) {
    this.getServer = getServer;
    this.webhookPort = webhookPort;
  }

  definition = {
    name: 'webhook',
    description:
      'Gestionar webhooks HTTP. Crear endpoints para recibir notificaciones de Laravel, GitHub, Stripe, etc. ' +
      'Acciones: create, list, delete, info, test.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'delete', 'info', 'test'],
          description: 'Acción a realizar',
        },
        name: {
          type: 'string',
          description: 'Nombre descriptivo del webhook (para create)',
        },
        id: {
          type: 'string',
          description: 'ID del webhook (se genera automáticamente si no se provee)',
        },
        type: {
          type: 'string',
          enum: ['notify', 'message', 'command'],
          description: 'Tipo de acción: notify (enviar notificación), message (procesar con IA), command (ejecutar comando). Default: notify',
        },
        channel: {
          type: 'string',
          description: 'Canal destino para notificaciones: telegram, whatsapp, web. Default: telegram',
        },
        secret: {
          type: 'string',
          description: 'Secret para verificar firmas (opcional, recomendado para producción)',
        },
        template: {
          type: 'string',
          description: 'Template del mensaje. Variables: {name}, {payload}, {event}, {data}',
        },
        command: {
          type: 'string',
          description: 'Comando a ejecutar (solo para type=command)',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const server = this.getServer();
    if (!server) {
      return { success: false, output: '', error: 'Webhook server no habilitado. Configurá WEBHOOK_ENABLED=true en .env' };
    }

    const action = String(params.action || '');

    switch (action) {
      case 'create': {
        const name = String(params.name || '');
        if (!name) return { success: false, output: '', error: 'Necesito un nombre para el webhook.' };

        const id = params.id ? String(params.id) : name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const type = String(params.type || 'notify') as 'notify' | 'message' | 'command';
        const channel = String(params.channel || 'telegram');
        const secret = params.secret ? String(params.secret) : crypto.randomBytes(16).toString('hex');

        const actionParams: Record<string, any> = {};
        if (params.template) actionParams.template = String(params.template);
        if (params.command) actionParams.command = String(params.command);

        try {
          server.createWebhook(id, name, type, channel, secret, actionParams);
        } catch (err: any) {
          if (err.message?.includes('UNIQUE')) {
            return { success: false, output: '', error: `Ya existe un webhook con ID "${id}".` };
          }
          throw err;
        }

        const url = `http://localhost:${this.webhookPort}/webhook/${id}`;
        let output = `Webhook creado:\n`;
        output += `  ID: ${id}\n`;
        output += `  Nombre: ${name}\n`;
        output += `  URL: ${url}\n`;
        output += `  Tipo: ${type}\n`;
        output += `  Canal: ${channel}\n`;
        output += `  Secret: ${secret}\n\n`;
        output += `Para usar desde afuera:\n`;
        output += `  curl -X POST ${url} \\\n`;
        output += `    -H "Content-Type: application/json" \\\n`;
        output += `    -H "X-Webhook-Secret: ${secret}" \\\n`;
        output += `    -d '{"event": "test", "data": {"message": "Hola ATLAS"}}'`;

        return { success: true, output };
      }

      case 'list': {
        const webhooks = server.listWebhooks();
        if (webhooks.length === 0) {
          return { success: true, output: 'No hay webhooks configurados.' };
        }

        let output = `${webhooks.length} webhook(s):\n\n`;
        for (const wh of webhooks) {
          const status = wh.enabled ? '✅' : '❌';
          output += `${status} ${wh.name} (${wh.id})\n`;
          output += `   URL: http://localhost:${this.webhookPort}/webhook/${wh.id}\n`;
          output += `   Tipo: ${wh.action} → ${wh.channel}\n`;
          output += `   Disparos: ${wh.trigger_count}${wh.last_triggered ? ` (último: ${wh.last_triggered})` : ''}\n\n`;
        }
        return { success: true, output };
      }

      case 'delete': {
        const id = String(params.id || params.name || '');
        if (!id) return { success: false, output: '', error: 'Necesito el ID del webhook a eliminar.' };

        const deleted = server.deleteWebhook(id);
        return deleted
          ? { success: true, output: `Webhook "${id}" eliminado.` }
          : { success: false, output: '', error: `Webhook "${id}" no encontrado.` };
      }

      case 'info': {
        const id = String(params.id || params.name || '');
        if (!id) return { success: false, output: '', error: 'Necesito el ID del webhook.' };

        const wh = server.getWebhook(id);
        if (!wh) return { success: false, output: '', error: `Webhook "${id}" no encontrado.` };

        const log = server.getWebhookLog(id, 5);
        let output = `Webhook: ${wh.name}\n`;
        output += `  ID: ${wh.id}\n`;
        output += `  URL: http://localhost:${this.webhookPort}/webhook/${wh.id}\n`;
        output += `  Tipo: ${wh.action}\n`;
        output += `  Canal: ${wh.channel}\n`;
        output += `  Habilitado: ${wh.enabled ? 'Sí' : 'No'}\n`;
        output += `  Disparos: ${wh.trigger_count}\n`;
        output += `  Último: ${wh.last_triggered || 'Nunca'}\n`;

        if (log.length > 0) {
          output += `\nÚltimos ${log.length} triggers:\n`;
          for (const entry of log) {
            output += `  [${entry.created_at}] ${entry.status}: ${(entry.result || '').substring(0, 100)}\n`;
          }
        }

        return { success: true, output };
      }

      case 'test': {
        const id = String(params.id || params.name || '');
        if (!id) return { success: false, output: '', error: 'Necesito el ID del webhook a probar.' };

        // Simulate a webhook trigger by calling the URL
        try {
          const url = `http://localhost:${this.webhookPort}/webhook/${id}`;
          const wh = server.getWebhook(id);
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (wh?.secret) headers['X-Webhook-Secret'] = wh.secret;

          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ event: 'test', data: { message: 'Test desde ATLAS', timestamp: new Date().toISOString() } }),
            signal: AbortSignal.timeout(10000),
          });

          const result = await resp.json() as any;
          if (result.ok) {
            return { success: true, output: `Test exitoso: ${result.result}` };
          }
          return { success: false, output: '', error: `Test fallido: ${JSON.stringify(result)}` };
        } catch (err: any) {
          return { success: false, output: '', error: `Error en test: ${err.message}` };
        }
      }

      default:
        return { success: false, output: '', error: `Acción desconocida: ${action}. Usar: create, list, delete, info, test` };
    }
  }
}
