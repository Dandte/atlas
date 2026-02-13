// ═══════════════════════════════════════
// ATLAS — Goals Tool
// v0.9 Feature 7: Manage autonomous goals
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { GoalEngine } from '../../sentinel/goal-engine';

export class GoalsTool implements Tool {
  private engine: GoalEngine;

  definition = {
    name: 'goals',
    description: 'Gestionar metas autonomas de largo plazo. ATLAS ejecuta pasos hacia la meta periodicamente. Ejemplos: "monitorear precios de la competencia", "aprender sobre un tema", "mejorar ventas".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'pause', 'resume', 'delete', 'status', 'executions'],
          description: 'Accion',
        },
        name: { type: 'string', description: 'Nombre de la meta' },
        description: { type: 'string', description: 'Descripcion detallada' },
        schedule: { type: 'string', description: 'Cron schedule. Ej: "0 9 * * *" (diario 9am), "0 */6 * * *" (cada 6h)' },
        channel: { type: 'string', description: 'Canal para reportar progreso (telegram, whatsapp, web)' },
        id: { type: 'string', description: 'ID de la meta' },
        status: { type: 'string', enum: ['active', 'paused', 'completed'], description: 'Filtrar por estado' },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  constructor(engine: GoalEngine) {
    this.engine = engine;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      switch (action) {
        case 'create': {
          const name = params.name as string;
          const description = params.description as string;
          const schedule = params.schedule as string || '0 9 * * *';
          if (!name || !description) return { success: false, output: '', error: 'Se requiere name y description' };
          const id = await this.engine.createGoal(name, description, schedule, params.channel as string);
          return { success: true, output: `Meta creada: "${name}" [${id}]\nSchedule: ${schedule}\nATLAS ejecutara pasos automaticamente segun el schedule.` };
        }

        case 'list': {
          const goals = this.engine.listGoals(params.status as string);
          if (goals.length === 0) return { success: true, output: 'No hay metas.' };
          const lines = goals.map(g =>
            `- ${g.name} [${g.id.substring(0, 8)}] (${g.status}) ${Math.round(g.progress * 100)}% — schedule: ${g.schedule}`
          );
          return { success: true, output: `Metas (${goals.length}):\n${lines.join('\n')}` };
        }

        case 'status': {
          const id = params.id as string;
          if (!id) return { success: false, output: '', error: 'Se requiere id' };
          const goal = this.engine.getGoal(id);
          if (!goal) return { success: false, output: '', error: 'Meta no encontrada' };
          let output = `Meta: ${goal.name}\n`;
          output += `Estado: ${goal.status}\n`;
          output += `Progreso: ${Math.round(goal.progress * 100)}%\n`;
          output += `Schedule: ${goal.schedule}\n`;
          output += `Proximo paso: ${goal.nextStep || 'Pendiente'}\n`;
          if (goal.stepsCompleted.length > 0) {
            output += `\nPasos completados:\n`;
            for (const step of goal.stepsCompleted.slice(-5)) {
              output += `  - ${step.substring(0, 100)}\n`;
            }
          }
          return { success: true, output };
        }

        case 'pause': {
          const id = params.id as string;
          if (!id) return { success: false, output: '', error: 'Se requiere id' };
          this.engine.pauseGoal(id);
          return { success: true, output: 'Meta pausada.' };
        }

        case 'resume': {
          const id = params.id as string;
          if (!id) return { success: false, output: '', error: 'Se requiere id' };
          this.engine.resumeGoal(id);
          return { success: true, output: 'Meta reactivada.' };
        }

        case 'delete': {
          const id = params.id as string;
          if (!id) return { success: false, output: '', error: 'Se requiere id' };
          const deleted = this.engine.deleteGoal(id);
          return { success: true, output: deleted ? 'Meta eliminada.' : 'Meta no encontrada.' };
        }

        case 'executions': {
          const id = params.id as string;
          if (!id) return { success: false, output: '', error: 'Se requiere id' };
          const execs = this.engine.getExecutions(id);
          if (execs.length === 0) return { success: true, output: 'No hay ejecuciones.' };
          const lines = execs.map((e: any) =>
            `- ${e.executed_at}: ${e.success ? 'OK' : 'ERROR'} — ${(e.step_description || '').substring(0, 80)}`
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
