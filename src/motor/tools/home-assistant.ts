// ═══════════════════════════════════════
// ATLAS — Home Assistant Tool
// Control de Home Assistant via REST API
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';

export class HomeAssistantTool implements Tool {
  definition: ToolDefinition = {
    name: 'home_assistant',
    description: 'Control de Home Assistant: listar entidades, estados, servicios, automatizaciones. Complementa la domótica Tuya.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['states', 'state', 'toggle', 'turn_on', 'turn_off', 'call_service', 'automations', 'trigger_automation', 'history', 'logbook'],
          description: 'states=todas las entidades, state=una entidad, toggle/turn_on/turn_off=control, call_service=servicio custom, automations=listar, trigger_automation=ejecutar, history/logbook=historial',
        },
        entity_id: { type: 'string', description: 'ID de la entidad (ej: light.sala, switch.cocina, climate.habitacion)' },
        domain: { type: 'string', description: 'Dominio para filtrar estados (ej: light, switch, sensor, climate, media_player)' },
        service: { type: 'string', description: 'Servicio a llamar (ej: light.turn_on, climate.set_temperature)' },
        service_data: { type: 'object', description: 'Datos adicionales para el servicio (ej: {"brightness": 200, "color_temp": 300})' },
        automation_id: { type: 'string', description: 'ID de la automatización a ejecutar' },
      },
      required: ['action'],
    },
  };

  private async haApi(method: string, path: string, body?: any): Promise<any> {
    const url = `${config.homeAssistantUrl}/api${path}`;
    const opts: any = {
      method,
      headers: {
        Authorization: `Bearer ${config.homeAssistantToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HA API ${res.status}: ${text.substring(0, 200)}`);
    }
    return res.json();
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    if (!config.homeAssistantUrl || !config.homeAssistantToken) {
      return { success: false, output: '', error: 'Home Assistant no configurado. Se requiere HOME_ASSISTANT_URL y HOME_ASSISTANT_TOKEN.' };
    }

    try {
      switch (action) {
        case 'states': return await this.listStates(params);
        case 'state': return await this.getState(params);
        case 'toggle': return await this.callSimpleService('homeassistant', 'toggle', params);
        case 'turn_on': return await this.callSimpleService('homeassistant', 'turn_on', params);
        case 'turn_off': return await this.callSimpleService('homeassistant', 'turn_off', params);
        case 'call_service': return await this.callService(params);
        case 'automations': return await this.listAutomations();
        case 'trigger_automation': return await this.triggerAutomation(params);
        case 'history': return await this.getHistory(params);
        case 'logbook': return await this.getLogbook(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Home Assistant tool error', { action, error: err });
      if (/ECONNREFUSED/i.test(err.message)) {
        return { success: false, output: '', error: `Home Assistant no accesible en ${config.homeAssistantUrl}` };
      }
      return { success: false, output: '', error: `Error HA: ${err.message}` };
    }
  }

  private async listStates(params: Record<string, unknown>): Promise<ToolResult> {
    const domain = params.domain ? String(params.domain) : null;
    const states: any[] = await this.haApi('GET', '/states');

    let filtered = states;
    if (domain) {
      filtered = states.filter((s: any) => s.entity_id.startsWith(`${domain}.`));
    }

    // Group by domain
    const groups: Record<string, any[]> = {};
    for (const s of filtered) {
      const d = s.entity_id.split('.')[0];
      if (!groups[d]) groups[d] = [];
      groups[d].push(s);
    }

    const lines: string[] = [];
    for (const [d, entities] of Object.entries(groups)) {
      lines.push(`\n## ${d} (${entities.length})`);
      for (const e of entities.slice(0, 20)) {
        const name = e.attributes?.friendly_name || e.entity_id;
        lines.push(`  ${name}: ${e.state} [${e.entity_id}]`);
      }
      if (entities.length > 20) lines.push(`  ... y ${entities.length - 20} más`);
    }

    return {
      success: true,
      output: `🏠 Home Assistant — ${filtered.length} entidades${domain ? ` (${domain})` : ''}${lines.join('\n')}`,
    };
  }

  private async getState(params: Record<string, unknown>): Promise<ToolResult> {
    const entityId = String(params.entity_id || '');
    if (!entityId) return { success: false, output: '', error: 'Se requiere entity_id.' };

    const state = await this.haApi('GET', `/states/${entityId}`);
    const name = state.attributes?.friendly_name || entityId;
    const attrs = Object.entries(state.attributes || {})
      .filter(([k]) => k !== 'friendly_name')
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join('\n');

    return {
      success: true,
      output: `${name}\nEstado: ${state.state}\nÚltimo cambio: ${new Date(state.last_changed).toLocaleString('es-CO')}\nAtributos:\n${attrs}`,
    };
  }

  private async callSimpleService(domain: string, service: string, params: Record<string, unknown>): Promise<ToolResult> {
    const entityId = String(params.entity_id || '');
    if (!entityId) return { success: false, output: '', error: 'Se requiere entity_id.' };

    await this.haApi('POST', `/services/${domain}/${service}`, {
      entity_id: entityId,
      ...(params.service_data as Record<string, any> || {}),
    });

    return { success: true, output: `✅ ${service} ejecutado en ${entityId}` };
  }

  private async callService(params: Record<string, unknown>): Promise<ToolResult> {
    const service = String(params.service || '');
    if (!service || !service.includes('.')) {
      return { success: false, output: '', error: 'Se requiere service en formato "dominio.servicio" (ej: light.turn_on).' };
    }

    const [domain, svc] = service.split('.');
    const data: any = { ...(params.service_data as Record<string, any> || {}) };
    if (params.entity_id) data.entity_id = String(params.entity_id);

    await this.haApi('POST', `/services/${domain}/${svc}`, data);
    return { success: true, output: `✅ Servicio ${service} ejecutado.` };
  }

  private async listAutomations(): Promise<ToolResult> {
    const states: any[] = await this.haApi('GET', '/states');
    const automations = states.filter((s: any) => s.entity_id.startsWith('automation.'));

    const lines = automations.map((a: any) => {
      const name = a.attributes?.friendly_name || a.entity_id;
      return `${a.state === 'on' ? '✅' : '❌'} ${name} [${a.entity_id}]`;
    });

    return {
      success: true,
      output: `🤖 Automatizaciones (${automations.length})\n${lines.join('\n')}`,
    };
  }

  private async triggerAutomation(params: Record<string, unknown>): Promise<ToolResult> {
    const automationId = String(params.automation_id || params.entity_id || '');
    if (!automationId) return { success: false, output: '', error: 'Se requiere automation_id o entity_id.' };

    await this.haApi('POST', '/services/automation/trigger', {
      entity_id: automationId,
    });

    return { success: true, output: `✅ Automatización ejecutada: ${automationId}` };
  }

  private async getHistory(params: Record<string, unknown>): Promise<ToolResult> {
    const entityId = String(params.entity_id || '');
    if (!entityId) return { success: false, output: '', error: 'Se requiere entity_id para historial.' };

    const now = new Date();
    const oneDay = new Date(now.getTime() - 24 * 3600000);
    const data: any[] = await this.haApi('GET',
      `/history/period/${oneDay.toISOString()}?filter_entity_id=${entityId}&minimal_response`
    );

    if (!data || data.length === 0 || data[0].length === 0) {
      return { success: true, output: 'Sin historial en las últimas 24h.' };
    }

    const changes = data[0].slice(-20).map((s: any) => {
      const time = new Date(s.last_changed).toLocaleTimeString('es-CO', { timeStyle: 'short' });
      return `${time}: ${s.state}`;
    });

    return {
      success: true,
      output: `📊 Historial de ${entityId} (últimas 24h)\n${changes.join('\n')}`,
    };
  }

  private async getLogbook(params: Record<string, unknown>): Promise<ToolResult> {
    const entityId = params.entity_id ? String(params.entity_id) : '';
    const now = new Date();
    const oneDay = new Date(now.getTime() - 24 * 3600000);

    let endpoint = `/logbook/${oneDay.toISOString()}`;
    if (entityId) endpoint += `?entity=${entityId}`;

    const entries: any[] = await this.haApi('GET', endpoint);
    const lines = entries.slice(0, 20).map((e: any) => {
      const time = new Date(e.when).toLocaleString('es-CO', { timeStyle: 'short', dateStyle: 'short' });
      return `${time} | ${e.name}: ${e.message || e.state || ''}`;
    });

    return {
      success: true,
      output: `📋 Logbook${entityId ? ` (${entityId})` : ''}\n${lines.join('\n')}`,
    };
  }
}
