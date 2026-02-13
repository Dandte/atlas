// ═══════════════════════════════════════
// ATLAS — Schedule Task Tool (Phase 5)
// Create, list, remove, toggle scheduled tasks
// Supports cron expressions and natural language
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { Scheduler } from '../../sentinel/scheduler';
import { ModelRouter } from '../../thalamus/model-router';
import logger from '../../utils/logger';

export class ScheduleTaskTool implements Tool {
  private scheduler: Scheduler;
  private modelRouter: ModelRouter;

  definition: ToolDefinition = {
    name: 'schedule_task',
    description: `Crear, listar, o eliminar tareas programadas. ATLAS puede programar tareas que se ejecutan automáticamente. Ejemplos: "Recordame en 2 horas revisar el deploy", "Todos los lunes a las 9am mandame el reporte de ventas", "Cada hora verificá que el servidor esté vivo"`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'remove', 'toggle'],
          description: 'Acción a realizar',
        },
        name: {
          type: 'string',
          description: 'Nombre de la tarea (para create)',
        },
        schedule: {
          type: 'string',
          description:
            'Cron expression o descripción legible. Ej: "0 9 * * 1" para lunes 9am, "every 30 minutes"',
        },
        task_description: {
          type: 'string',
          description: 'Qué debe hacer la tarea (para create). ATLAS generará el handler.',
        },
        channel: {
          type: 'string',
          description: 'Canal donde enviar resultados (telegram, whatsapp, web, cli)',
        },
        task_id: {
          type: 'string',
          description: 'ID o nombre de la tarea (para remove/toggle)',
        },
        enabled: {
          type: 'boolean',
          description: 'Habilitar (true) o deshabilitar (false) la tarea (para toggle)',
        },
      },
      required: ['action'],
    },
  };

  constructor(scheduler: Scheduler, modelRouter: ModelRouter) {
    this.scheduler = scheduler;
    this.modelRouter = modelRouter;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      switch (action) {
        case 'create':
          return await this.createTask(params);
        case 'list':
          return this.listTasks();
        case 'remove':
          return await this.removeTask(params);
        case 'toggle':
          return await this.toggleTask(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }

  private async createTask(params: Record<string, unknown>): Promise<ToolResult> {
    const name = params.name as string;
    const scheduleInput = params.schedule as string;
    const description = (params.task_description as string) || name;
    const channel = params.channel as string | undefined;

    if (!name || !scheduleInput) {
      return {
        success: false,
        output: '',
        error: 'Se requiere "name" y "schedule" para crear una tarea.',
      };
    }

    // Convert natural language to cron if needed
    const cronExpression = await this.parseToCron(scheduleInput);

    const id = await this.scheduler.addTask({
      name,
      description,
      schedule: cronExpression,
      handler: 'dynamic_task',
      params: { task_description: description },
      channel,
      enabled: true,
      createdBy: 'user',
    });

    return {
      success: true,
      output: `Tarea "${name}" creada con ID ${id}.\nSchedule: ${cronExpression}\nCanal: ${channel || 'ninguno'}\nEstado: habilitada`,
    };
  }

  private listTasks(): ToolResult {
    const tasks = this.scheduler.listTasks();

    if (tasks.length === 0) {
      return { success: true, output: 'No hay tareas programadas.' };
    }

    const lines = tasks.map((t) => {
      const status = t.enabled ? 'ON' : 'OFF';
      const lastRun = t.lastRun
        ? new Date(t.lastRun).toLocaleString('es-CO', { timeZone: 'America/Bogota' })
        : 'nunca';
      return `[${status}] ${t.name} (${t.schedule})\n  ${t.description}\n  Último: ${lastRun} · Runs: ${t.runCount} · Por: ${t.createdBy}\n  ID: ${t.id}`;
    });

    return {
      success: true,
      output: `Tareas programadas (${tasks.length}):\n\n${lines.join('\n\n')}`,
    };
  }

  private async removeTask(params: Record<string, unknown>): Promise<ToolResult> {
    const taskId = params.task_id as string;
    if (!taskId) {
      return { success: false, output: '', error: 'Se requiere "task_id" para eliminar.' };
    }

    // Try by ID first, then by name
    let removed = await this.scheduler.removeTask(taskId);
    if (!removed) {
      removed = await this.scheduler.removeTaskByName(taskId);
    }

    if (removed) {
      return { success: true, output: `Tarea eliminada: ${taskId}` };
    }
    return { success: false, output: '', error: `No se encontró tarea: ${taskId}` };
  }

  private async toggleTask(params: Record<string, unknown>): Promise<ToolResult> {
    const taskId = params.task_id as string;
    const enabled = params.enabled !== false; // default to enable

    if (!taskId) {
      return { success: false, output: '', error: 'Se requiere "task_id" para toggle.' };
    }

    // Find by ID or name
    let task = this.scheduler.listTasks().find((t) => t.id === taskId);
    if (!task) {
      task = this.scheduler.findByName(taskId);
    }

    if (!task) {
      return { success: false, output: '', error: `No se encontró tarea: ${taskId}` };
    }

    await this.scheduler.toggleTask(task.id, enabled);
    return {
      success: true,
      output: `Tarea "${task.name}" ${enabled ? 'habilitada' : 'deshabilitada'}.`,
    };
  }

  /** Convert natural language or shorthand to cron expression */
  private async parseToCron(input: string): Promise<string> {
    // If already a valid cron expression (5 fields separated by spaces)
    const parts = input.trim().split(/\s+/);
    if (parts.length === 5 && parts.every((p) => /^[\d*,/\-]+$/.test(p))) {
      return input.trim();
    }

    // Quick patterns
    const lower = input.toLowerCase().trim();

    if (lower.match(/^every\s+(\d+)\s*min/i) || lower.match(/^cada\s+(\d+)\s*min/i)) {
      const match = lower.match(/(\d+)/);
      if (match) return `*/${match[1]} * * * *`;
    }

    if (lower.match(/^every\s+(\d+)\s*hour/i) || lower.match(/^cada\s+(\d+)\s*hora/i)) {
      const match = lower.match(/(\d+)/);
      if (match) return `0 */${match[1]} * * *`;
    }

    if (lower.match(/^every\s*hour/i) || lower.match(/^cada\s*hora/i)) {
      return '0 * * * *';
    }

    // Use AI for complex natural language
    try {
      const response = await this.modelRouter.chat(
        `Convierte esta descripción a cron expression (5 campos: minuto hora día-mes mes día-semana).
Responde SOLO con la cron expression, nada más. Sin explicación.
Si es algo como "in 2 hours" (one-shot), genera una cron que se ejecute una sola vez lo más cercano posible.`,
        [
          {
            role: 'user',
            content: input,
          },
        ]
      );

      const cronResult = response.content.trim().replace(/[`"']/g, '');
      const cronParts = cronResult.split(/\s+/);
      if (cronParts.length === 5) {
        return cronResult;
      }
    } catch (err) {
      logger.debug('AI cron conversion failed', { error: err });
    }

    // Fallback: return the input as-is (will fail validation in scheduler)
    return input;
  }
}
