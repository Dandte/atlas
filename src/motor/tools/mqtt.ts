// ═══════════════════════════════════════
// ATLAS — MQTT / IoT Tool
// Publish/subscribe to MQTT topics
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class MQTTTool implements Tool {
  private client: any = null;
  private subscriptions: Map<string, { messages: { topic: string; payload: string; timestamp: string }[]; maxMessages: number }> = new Map();

  definition: ToolDefinition = {
    name: 'mqtt',
    description: 'Publica y suscribe a tópicos MQTT para comunicación con dispositivos IoT (ESP32, sensores, actuadores, etc.). Acciones: publish (enviar mensaje), subscribe (escuchar tópico), unsubscribe, messages (ver mensajes recibidos), status (estado de conexión), topics (ver suscripciones activas).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['publish', 'subscribe', 'unsubscribe', 'messages', 'status', 'topics'],
          description: 'Acción a realizar',
        },
        topic: {
          type: 'string',
          description: 'Tópico MQTT. Ej: home/sensor/temperature, devices/relay/1/command',
        },
        payload: {
          type: 'string',
          description: 'Mensaje a publicar (para publish). Puede ser JSON o texto plano.',
        },
        qos: {
          type: 'number',
          enum: [0, 1, 2],
          description: 'Quality of Service: 0 (at most once), 1 (at least once), 2 (exactly once). Default: 1',
        },
        retain: {
          type: 'boolean',
          description: 'Retener mensaje en el broker. Default: false',
        },
        limit: {
          type: 'number',
          description: 'Límite de mensajes a mostrar (para messages). Default: 20',
        },
      },
      required: ['action'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'publish': return await this.publish(params);
        case 'subscribe': return await this.subscribe(String(params.topic || ''));
        case 'unsubscribe': return this.unsubscribe(String(params.topic || ''));
        case 'messages': return this.getMessages(String(params.topic || ''), Number(params.limit || 20));
        case 'status': return this.getStatus();
        case 'topics': return this.listTopics();
        default: return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      if (/Cannot find module/i.test(err.message)) {
        return { success: false, output: '', error: 'npm install mqtt' };
      }
      logger.error('MQTT error', { error: err, action });
      return { success: false, output: '', error: `Error MQTT: ${err.message}` };
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client?.connected) return;

    const brokerUrl = (config as any).mqttBrokerUrl;
    if (!brokerUrl) throw new Error('MQTT_BROKER_URL no configurada. Ej: mqtt://192.168.1.100:1883');

    const mqtt = require('mqtt');
    const options: any = {
      clientId: `atlas_${Date.now()}`,
      clean: true,
      reconnectPeriod: 5000,
    };

    const username = (config as any).mqttUsername;
    const password = (config as any).mqttPassword;
    if (username) options.username = username;
    if (password) options.password = password;

    this.client = mqtt.connect(brokerUrl, options);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout conectando a ${brokerUrl}`));
      }, 10000);

      this.client.on('connect', () => {
        clearTimeout(timeout);
        logger.info('MQTT connected', { broker: brokerUrl });

        // Re-subscribe to all active subscriptions
        for (const topic of this.subscriptions.keys()) {
          this.client.subscribe(topic, { qos: 1 });
        }

        resolve();
      });

      this.client.on('message', (topic: string, payload: Buffer) => {
        const sub = this.subscriptions.get(topic) ||
          Array.from(this.subscriptions.entries()).find(([t]) => this.topicMatches(t, topic))?.[1];

        if (sub) {
          sub.messages.push({
            topic,
            payload: payload.toString(),
            timestamp: new Date().toISOString(),
          });
          if (sub.messages.length > sub.maxMessages) {
            sub.messages.shift();
          }
        }
      });

      this.client.on('error', (err: any) => {
        clearTimeout(timeout);
        logger.error('MQTT error', { error: err });
        reject(err);
      });
    });
  }

  private async publish(params: Record<string, unknown>): Promise<ToolResult> {
    const topic = String(params.topic || '');
    const payload = String(params.payload || '');
    if (!topic || !payload) return { success: false, output: '', error: 'Se requiere topic y payload' };

    await this.ensureConnected();

    const qos = Number(params.qos ?? 1) as 0 | 1 | 2;
    const retain = Boolean(params.retain);

    return new Promise((resolve) => {
      this.client.publish(topic, payload, { qos, retain }, (err: any) => {
        if (err) {
          resolve({ success: false, output: '', error: `Error publicando: ${err.message}` });
        } else {
          resolve({
            success: true,
            output: `Publicado en ${topic}\nPayload: ${payload.substring(0, 200)}\nQoS: ${qos} | Retain: ${retain}`,
          });
        }
      });
    });
  }

  private async subscribe(topic: string): Promise<ToolResult> {
    if (!topic) return { success: false, output: '', error: 'Se requiere topic' };

    await this.ensureConnected();

    if (this.subscriptions.has(topic)) {
      return { success: true, output: `Ya suscrito a ${topic}. Tiene ${this.subscriptions.get(topic)!.messages.length} mensajes.` };
    }

    this.subscriptions.set(topic, { messages: [], maxMessages: 100 });

    return new Promise((resolve) => {
      this.client.subscribe(topic, { qos: 1 }, (err: any) => {
        if (err) {
          this.subscriptions.delete(topic);
          resolve({ success: false, output: '', error: `Error suscribiendo: ${err.message}` });
        } else {
          resolve({ success: true, output: `Suscrito a ${topic}. Los mensajes se acumularán (max 100).` });
        }
      });
    });
  }

  private unsubscribe(topic: string): ToolResult {
    if (!topic) return { success: false, output: '', error: 'Se requiere topic' };

    if (this.client?.connected) {
      this.client.unsubscribe(topic);
    }
    this.subscriptions.delete(topic);
    return { success: true, output: `Desuscrito de ${topic}.` };
  }

  private getMessages(topic: string, limit: number): ToolResult {
    if (topic) {
      const sub = this.subscriptions.get(topic);
      if (!sub) return { success: true, output: `No suscrito a ${topic}.` };

      const msgs = sub.messages.slice(-limit);
      if (msgs.length === 0) return { success: true, output: `Sin mensajes en ${topic}.` };

      const lines = msgs.map(m => `  [${m.timestamp.substring(11, 19)}] ${m.topic}: ${m.payload.substring(0, 200)}`);
      return { success: true, output: `Mensajes de ${topic} (${msgs.length}):\n${lines.join('\n')}` };
    }

    // All topics
    const allMsgs: { topic: string; payload: string; timestamp: string }[] = [];
    for (const sub of this.subscriptions.values()) {
      allMsgs.push(...sub.messages);
    }
    allMsgs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const recent = allMsgs.slice(-limit);
    if (recent.length === 0) return { success: true, output: 'Sin mensajes.' };

    const lines = recent.map(m => `  [${m.timestamp.substring(11, 19)}] ${m.topic}: ${m.payload.substring(0, 200)}`);
    return { success: true, output: `Mensajes recientes (${recent.length}):\n${lines.join('\n')}` };
  }

  private getStatus(): ToolResult {
    const connected = this.client?.connected || false;
    const broker = (config as any).mqttBrokerUrl || 'no configurado';
    const subs = this.subscriptions.size;
    const totalMsgs = Array.from(this.subscriptions.values()).reduce((sum, s) => sum + s.messages.length, 0);

    return {
      success: true,
      output: `Estado MQTT:\n  Conectado: ${connected ? 'sí' : 'no'}\n  Broker: ${broker}\n  Suscripciones: ${subs}\n  Mensajes en buffer: ${totalMsgs}`,
    };
  }

  private listTopics(): ToolResult {
    if (this.subscriptions.size === 0) return { success: true, output: 'Sin suscripciones activas.' };

    const lines = Array.from(this.subscriptions.entries()).map(([topic, sub]) =>
      `  ${topic} — ${sub.messages.length} mensajes`
    );
    return { success: true, output: `Suscripciones activas (${this.subscriptions.size}):\n${lines.join('\n')}` };
  }

  private topicMatches(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') return true;
      if (patternParts[i] === '+') continue;
      if (patternParts[i] !== topicParts[i]) return false;
    }
    return patternParts.length === topicParts.length;
  }

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
