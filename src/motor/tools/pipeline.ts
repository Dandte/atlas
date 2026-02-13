// ═══════════════════════════════════════
// ATLAS — Pipeline Tool
// v0.9 Feature 3: Create and manage pipelines
// ═══════════════════════════════════════

import { Tool, ToolResult, PipelineStep } from '../../types';
import { PipelineEngine } from '../../sentinel/pipeline-engine';

export class PipelineTool implements Tool {
  private engine: PipelineEngine;

  definition = {
    name: 'pipeline',
    description: 'Crear y gestionar pipelines de automatizacion. Un pipeline se activa con un evento y ejecuta una secuencia de pasos (tools, mensajes, guardar hechos, etc).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'delete', 'toggle', 'trigger', 'executions'],
          description: 'Accion a ejecutar',
        },
        name: { type: 'string', description: 'Nombre del pipeline' },
        description: { type: 'string', description: 'Descripcion' },
        trigger_event: {
          type: 'string',
          enum: ['tool_executed', 'agent_routed', 'channel_connected', 'channel_disconnected', 'schedule_triggered', 'webhook_received', 'device_state_changed'],
          description: 'Evento que dispara el pipeline',
        },
        trigger_filter: { type: 'object', description: 'Filtro opcional sobre el evento (JSON)' },
        steps: {
          type: 'array',
          description: 'Pasos del pipeline: [{type: "call_tool"|"send_message"|"save_fact"|"wait"|"condition"|"call_n8n", params: {...}}]',
        },
        id: { type: 'string', description: 'ID del pipeline (para delete/toggle/trigger/executions)' },
        enabled: { type: 'boolean', description: 'Estado (para toggle)' },
        data: { type: 'object', description: 'Datos para trigger manual' },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  constructor(engine: PipelineEngine) {
    this.engine = engine;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      switch (action) {
        case 'create': {
          const name = params.name as string;
          const trigger = params.trigger_event as string;
          const steps = params.steps as PipelineStep[];
          if (!name || !trigger || !steps) {
            return { success: false, output: '', error: 'Se requiere name, trigger_event y steps' };
          }
          const id = this.engine.createPipeline(
            name,
            (params.description as string) || '',
            trigger,
            steps,
            params.trigger_filter as Record<string, any>
          );
          return { success: true, output: `Pipeline "${name}" creado [${id}]. Trigger: ${trigger}, ${steps.length} pasos.` };
        }

        case 'list': {
          const pipelines = this.engine.listPipelines();
          if (pipelines.length === 0) return { success: true, output: 'No hay pipelines configurados.' };
          const lines = pipelines.map(p =>
            `- ${p.name} (${p.enabled ? 'activo' : 'inactivo'}): trigger=${p.triggerEvent}, ${p.steps.length} pasos, ${p.runCount} ejecuciones`
          );
          return { success: true, output: `Pipelines (${pipelines.length}):\n${lines.join('\n')}` };
        }

        case 'delete': {
          const id = params.id as string;
          if (!id) return { success: false, output: '', error: 'Se requiere id' };
          const deleted = this.engine.deletePipeline(id);
          return { success: true, output: deleted ? 'Pipeline eliminado.' : 'Pipeline no encontrado.' };
        }

        case 'toggle': {
          const id = params.id as string;
          const enabled = params.enabled as boolean;
          if (!id || enabled === undefined) return { success: false, output: '', error: 'Se requiere id y enabled' };
          this.engine.togglePipeline(id, enabled);
          return { success: true, output: `Pipeline ${enabled ? 'activado' : 'desactivado'}.` };
        }

        case 'trigger': {
          const id = params.id as string;
          if (!id) return { success: false, output: '', error: 'Se requiere id' };
          await this.engine.triggerManual(id, params.data);
          return { success: true, output: 'Pipeline ejecutado manualmente.' };
        }

        case 'executions': {
          const id = params.id as string;
          const execs = this.engine.getExecutions(id, 10);
          if (execs.length === 0) return { success: true, output: 'No hay ejecuciones.' };
          const lines = execs.map((e: any) =>
            `- ${e.executed_at}: ${e.steps_completed}/${e.total_steps} pasos, ${e.success ? 'OK' : 'ERROR'}, ${e.execution_ms}ms`
          );
          return { success: true, output: `Ejecuciones recientes:\n${lines.join('\n')}` };
        }

        default:
          return { success: false, output: '', error: `Accion desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }
}
