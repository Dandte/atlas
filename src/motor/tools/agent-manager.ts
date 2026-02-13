// ═══════════════════════════════════════
// ATLAS — Agent Manager Tool (Phase 7)
// Create, list, update, remove custom agents
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult, AgentDefinition } from '../../types';
import { Coordinator } from '../../nexus/coordinator';
import { MemoryManager } from '../../hippocampus/memory-manager';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';

export class AgentManagerTool implements Tool {
  definition: ToolDefinition = {
    name: 'agent_manager',
    description: 'Gestionar agentes especializados: crear, listar, actualizar, eliminar, habilitar o deshabilitar agentes custom.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'remove', 'enable', 'disable', 'info'],
          description: 'Acción a ejecutar',
        },
        name: {
          type: 'string',
          description: 'Nombre del agente (para create/update/remove/enable/disable/info)',
        },
        display_name: {
          type: 'string',
          description: 'Nombre para mostrar del agente (para create/update)',
        },
        description: {
          type: 'string',
          description: 'Descripción del agente (para create/update)',
        },
        system_prompt: {
          type: 'string',
          description: 'System prompt especializado del agente (para create/update)',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords que activan este agente (para create/update)',
        },
        preferred_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tools preferidos del agente (para create/update)',
        },
        preferred_model: {
          type: 'string',
          description: 'Modelo preferido: claude, openai, ollama (default: claude)',
        },
        temperature: {
          type: 'number',
          description: 'Temperature del modelo 0-1 (default: 0.5)',
        },
      },
      required: ['action'],
    },
  };

  private coordinator: Coordinator;
  private memory: MemoryManager;
  private customAgentsDir: string;

  constructor(coordinator: Coordinator, memory: MemoryManager) {
    this.coordinator = coordinator;
    this.memory = memory;
    this.customAgentsDir = path.join(config.rootDir, 'agents', 'custom');
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    switch (action) {
      case 'create': return this.createAgent(params);
      case 'list': return this.listAgents();
      case 'update': return this.updateAgent(params);
      case 'remove': return this.removeAgent(params);
      case 'enable': return this.toggleAgent(params, true);
      case 'disable': return this.toggleAgent(params, false);
      case 'info': return this.agentInfo(params);
      default:
        return { success: false, output: '', error: `Acción desconocida: ${action}` };
    }
  }

  private async createAgent(params: Record<string, unknown>): Promise<ToolResult> {
    const name = params.name as string;
    if (!name) return { success: false, output: '', error: 'Se requiere "name"' };

    const description = params.description as string;
    if (!description) return { success: false, output: '', error: 'Se requiere "description"' };

    const systemPrompt = params.system_prompt as string;
    if (!systemPrompt) return { success: false, output: '', error: 'Se requiere "system_prompt"' };

    // Check if agent already exists
    if (this.coordinator.getAgent(name)) {
      return { success: false, output: '', error: `Ya existe un agente "${name}"` };
    }

    const definition: AgentDefinition = {
      id: name,
      name,
      displayName: (params.display_name as string) || name,
      description,
      systemPrompt,
      preferredModel: (params.preferred_model as string) || 'claude',
      preferredTools: (params.preferred_tools as string[]) || [],
      triggerKeywords: (params.keywords as string[]) || [],
      triggerPatterns: [],
      capabilities: [],
      temperature: (params.temperature as number) || 0.5,
      maxTokens: 4096,
      enabled: true,
    };

    // Register in Coordinator
    this.coordinator.registerAgent(definition);

    // Save to SQLite
    this.memory.saveCustomAgent(definition);

    // Save to disk
    this.saveAgentToDisk(definition);

    logger.info(`Custom agent created: ${name}`);

    return {
      success: true,
      output: `Agente "${name}" creado y registrado. Keywords: [${definition.triggerKeywords.join(', ')}]. Ya está activo.`,
    };
  }

  private async listAgents(): Promise<ToolResult> {
    const agents = this.coordinator.getAgents();
    const lines = agents.map(a => {
      const d = a.definition;
      const status = d.enabled ? 'ON' : 'OFF';
      return `[${status}] ${d.name} (${d.displayName}) — ${d.description}`;
    });

    return {
      success: true,
      output: `${agents.length} agentes registrados:\n\n${lines.join('\n')}`,
    };
  }

  private async updateAgent(params: Record<string, unknown>): Promise<ToolResult> {
    const name = params.name as string;
    if (!name) return { success: false, output: '', error: 'Se requiere "name"' };

    const agent = this.coordinator.getAgent(name);
    if (!agent) return { success: false, output: '', error: `Agente "${name}" no encontrado` };

    // Update fields
    const def = agent.definition;
    if (params.description) (def as any).description = params.description as string;
    if (params.system_prompt) (def as any).systemPrompt = params.system_prompt as string;
    if (params.keywords) (def as any).triggerKeywords = params.keywords as string[];
    if (params.preferred_tools) (def as any).preferredTools = params.preferred_tools as string[];
    if (params.preferred_model) (def as any).preferredModel = params.preferred_model as string;
    if (params.temperature !== undefined) (def as any).temperature = params.temperature as number;
    if (params.display_name) (def as any).displayName = params.display_name as string;

    // Re-save
    this.memory.saveCustomAgent(def);
    this.saveAgentToDisk(def);

    return {
      success: true,
      output: `Agente "${name}" actualizado.`,
    };
  }

  private async removeAgent(params: Record<string, unknown>): Promise<ToolResult> {
    const name = params.name as string;
    if (!name) return { success: false, output: '', error: 'Se requiere "name"' };

    // Don't allow removing built-in agents
    const builtIn = ['business', 'sysadmin', 'developer', 'researcher', 'creative', 'general'];
    if (builtIn.includes(name)) {
      return { success: false, output: '', error: `No se puede eliminar el agente built-in "${name}"` };
    }

    this.memory.deleteCustomAgent(name);

    // Remove from disk
    const filePath = path.join(this.customAgentsDir, `${name}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return {
      success: true,
      output: `Agente "${name}" eliminado. Se aplica en el próximo reinicio.`,
    };
  }

  private async toggleAgent(params: Record<string, unknown>, enabled: boolean): Promise<ToolResult> {
    const name = params.name as string;
    if (!name) return { success: false, output: '', error: 'Se requiere "name"' };

    const agent = this.coordinator.getAgent(name);
    if (!agent) return { success: false, output: '', error: `Agente "${name}" no encontrado` };

    (agent.definition as any).enabled = enabled;

    // Update in DB if it's a custom agent
    this.memory.toggleCustomAgent(name, enabled);

    return {
      success: true,
      output: `Agente "${name}" ${enabled ? 'habilitado' : 'deshabilitado'}.`,
    };
  }

  private async agentInfo(params: Record<string, unknown>): Promise<ToolResult> {
    const name = params.name as string;
    if (!name) return { success: false, output: '', error: 'Se requiere "name"' };

    const agent = this.coordinator.getAgent(name);
    if (!agent) return { success: false, output: '', error: `Agente "${name}" no encontrado` };

    const d = agent.definition;
    const stats = this.memory.getAgentStats(name);

    const info = [
      `Agente: ${d.name} (${d.displayName})`,
      `Estado: ${d.enabled ? 'Activo' : 'Inactivo'}`,
      `Descripción: ${d.description}`,
      `Modelo preferido: ${d.preferredModel}`,
      `Temperature: ${d.temperature}`,
      `Max tokens: ${d.maxTokens}`,
      `Tools preferidos: ${d.preferredTools.join(', ') || 'ninguno'}`,
      `Keywords: ${d.triggerKeywords.join(', ') || 'ninguno'}`,
      `Capabilities: ${d.capabilities.join(', ') || 'ninguno'}`,
      '',
      `Ejecuciones totales: ${stats.totalExecutions}`,
      `Éxito: ${stats.successRate}%`,
      `Tiempo promedio: ${stats.avgExecutionMs}ms`,
    ];

    return {
      success: true,
      output: info.join('\n'),
    };
  }

  private saveAgentToDisk(definition: AgentDefinition): void {
    try {
      if (!fs.existsSync(this.customAgentsDir)) {
        fs.mkdirSync(this.customAgentsDir, { recursive: true });
      }
      const filePath = path.join(this.customAgentsDir, `${definition.name}.json`);
      const serializable = {
        ...definition,
        triggerPatterns: definition.triggerPatterns.map(p => p.source),
      };
      fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2));
    } catch (err) {
      logger.debug('Failed to save agent to disk', { error: err });
    }
  }
}
