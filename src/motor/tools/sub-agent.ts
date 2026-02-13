// ═══════════════════════════════════════
// ATLAS — Sub-Agent Tool (spawn_agent)
// Create and manage sub-agents from chat
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { SubAgentManager } from '../../nexus/sub-agent';
import logger from '../../utils/logger';

export class SubAgentTool implements Tool {
  definition: ToolDefinition = {
    name: 'spawn_agent',
    description:
      'Spawn and manage sub-agents that execute tasks autonomously in the background. ' +
      'Actions: spawn (create new), status (check one), collect (get result), abort (cancel), list (all active/recent).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'status', 'collect', 'abort', 'list'],
          description: 'Action to perform',
        },
        task: {
          type: 'string',
          description: 'Task description for spawn action',
        },
        agent_id: {
          type: 'string',
          description: 'Sub-agent ID for status/collect/abort actions',
        },
        max_iterations: {
          type: 'number',
          description: 'Max tool iterations for the sub-agent (default: 10)',
        },
      },
      required: ['action'],
    },
  };

  private manager: SubAgentManager;

  constructor(manager: SubAgentManager) {
    this.manager = manager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;
    const ok = (output: string): ToolResult => ({ success: true, output });
    const fail = (output: string): ToolResult => ({ success: false, output });

    switch (action) {
      case 'spawn': {
        if (!params.task) return fail('Error: task es requerido para spawn');

        const id = await this.manager.spawn(
          params.task as string,
          (params.parent_session_id as string) || null,
          { maxIterations: (params.max_iterations as number) || 10 }
        );

        return ok(`Sub-agente creado (ID: ${id})\nTarea: ${params.task}\n\nUsa status o collect con este ID para ver el resultado.`);
      }

      case 'status': {
        if (!params.agent_id) return fail('Error: agent_id es requerido');

        const info = this.manager.getStatus(params.agent_id as string);
        if (!info) return fail(`No se encontro sub-agente con ID: ${params.agent_id}`);

        const lines = [
          `ID: ${info.id}`,
          `Tarea: ${info.task}`,
          `Estado: ${info.status}`,
          `Iniciado: ${info.startedAt}`,
        ];
        if (info.completedAt) lines.push(`Completado: ${info.completedAt}`);
        if (info.executionMs) lines.push(`Duracion: ${info.executionMs}ms`);
        if (info.toolsUsed.length > 0) lines.push(`Tools usados: ${info.toolsUsed.join(', ')}`);
        if (info.result && info.status !== 'running') {
          lines.push(`\nResultado:\n${info.result.substring(0, 2000)}`);
        }

        return ok(lines.join('\n'));
      }

      case 'collect': {
        if (!params.agent_id) return fail('Error: agent_id es requerido');

        const info = this.manager.collect(params.agent_id as string);
        if (!info) return fail(`No se encontro sub-agente con ID: ${params.agent_id}`);

        if (info.status === 'running') {
          return ok(`El sub-agente aun esta ejecutandose. Espera un momento y consulta de nuevo.`);
        }

        return ok(`Estado: ${info.status}\nDuracion: ${info.executionMs}ms\nTools: ${info.toolsUsed.join(', ')}\n\n${info.result || '(sin resultado)'}`);
      }

      case 'abort': {
        if (!params.agent_id) return fail('Error: agent_id es requerido');

        const aborted = this.manager.abort(params.agent_id as string);
        return aborted
          ? ok(`Sub-agente ${params.agent_id} abortado.`)
          : fail(`No se encontro sub-agente activo con ID: ${params.agent_id}`);
      }

      case 'list': {
        const active = this.manager.listActive();
        const recent = this.manager.listRecent(10);

        const lines: string[] = [];

        if (active.length > 0) {
          lines.push(`**Activos (${active.length}):**`);
          for (const a of active) {
            lines.push(`  - ${a.id.substring(0, 8)}... | ${a.task.substring(0, 60)}`);
          }
        } else {
          lines.push('No hay sub-agentes activos.');
        }

        if (recent.length > 0) {
          lines.push(`\n**Recientes:**`);
          for (const r of recent) {
            const duration = r.executionMs ? `${r.executionMs}ms` : 'en curso';
            lines.push(`  - [${r.status}] ${r.id.substring(0, 8)}... | ${r.task.substring(0, 50)} (${duration})`);
          }
        }

        return ok(lines.join('\n'));
      }

      default:
        return fail(`Accion desconocida: ${action}. Usa: spawn, status, collect, abort, list`);
    }
  }
}
