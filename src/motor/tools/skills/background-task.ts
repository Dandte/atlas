// ═══════════════════════════════════════
// ATLAS — Skill: Background Task Runner
// Run long tasks in background, notify when done
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import logger from '../../../utils/logger';

interface RunningTask {
  id: string;
  description: string;
  startedAt: Date;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

type ProcessFn = (text: string) => Promise<string>;
type NotifyFn = (message: string) => Promise<void>;

export class BackgroundTaskTool implements Tool {
  private tasks = new Map<string, RunningTask>();
  private processFn: ProcessFn;
  private notifyFn: NotifyFn;
  private taskCounter = 0;

  constructor(processFn: ProcessFn, notifyFn: NotifyFn) {
    this.processFn = processFn;
    this.notifyFn = notifyFn;
  }

  definition = {
    name: 'background',
    description:
      'Ejecutar tareas largas en segundo plano sin bloquear la conversación. ' +
      'ATLAS te notifica cuando termina. ' +
      'Acciones: run (lanzar tarea), status (ver estado), list (listar tareas activas).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'status', 'list'],
          description: 'Acción: run (ejecutar en background), status (ver estado de una tarea), list (tareas activas)',
        },
        task: {
          type: 'string',
          description: 'Descripción de la tarea a ejecutar en background (para run)',
        },
        id: {
          type: 'string',
          description: 'ID de la tarea (para status)',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    switch (action) {
      case 'run': {
        const description = String(params.task || '');
        if (!description) return { success: false, output: '', error: 'Necesito la descripción de la tarea.' };

        const id = `bg-${++this.taskCounter}`;
        const task: RunningTask = {
          id,
          description,
          startedAt: new Date(),
          status: 'running',
        };

        this.tasks.set(id, task);

        // Fire and forget — runs in background
        this.runInBackground(task).catch((err) => {
          logger.error(`Background task ${id} failed`, { error: err });
        });

        return {
          success: true,
          output: `Tarea lanzada en background:\n  ID: ${id}\n  Tarea: ${description}\n\nTe notifico cuando termine.`,
        };
      }

      case 'status': {
        const id = String(params.id || '');
        if (!id) return { success: false, output: '', error: 'Necesito el ID de la tarea.' };

        const task = this.tasks.get(id);
        if (!task) return { success: false, output: '', error: `Tarea "${id}" no encontrada.` };

        const elapsed = Math.round((Date.now() - task.startedAt.getTime()) / 1000);
        let output = `Tarea ${task.id}:\n`;
        output += `  Estado: ${task.status}\n`;
        output += `  Descripción: ${task.description}\n`;
        output += `  Tiempo: ${elapsed}s\n`;

        if (task.status === 'completed' && task.result) {
          output += `\n  Resultado:\n${task.result.substring(0, 500)}`;
        }
        if (task.status === 'failed' && task.error) {
          output += `\n  Error: ${task.error}`;
        }

        return { success: true, output };
      }

      case 'list': {
        if (this.tasks.size === 0) return { success: true, output: 'No hay tareas en background.' };

        let output = `${this.tasks.size} tarea(s):\n\n`;
        for (const [, task] of this.tasks) {
          const elapsed = Math.round((Date.now() - task.startedAt.getTime()) / 1000);
          const icon = task.status === 'running' ? '⏳' : task.status === 'completed' ? '✅' : '❌';
          output += `${icon} ${task.id}: ${task.description.substring(0, 60)} (${elapsed}s)\n`;
        }

        return { success: true, output };
      }

      default:
        return { success: false, output: '', error: `Acción desconocida: ${action}. Usar: run, status, list` };
    }
  }

  private async runInBackground(task: RunningTask): Promise<void> {
    try {
      const result = await this.processFn(task.description);
      task.status = 'completed';
      task.result = result;

      // Notify owner
      await this.notifyFn(
        `✅ Tarea completada (${task.id}):\n${task.description}\n\nResultado:\n${result.substring(0, 500)}`
      ).catch(() => { /* non-fatal */ });

      logger.info(`Background task ${task.id} completed`);
    } catch (err: any) {
      task.status = 'failed';
      task.error = err.message;

      await this.notifyFn(
        `❌ Tarea falló (${task.id}):\n${task.description}\n\nError: ${err.message}`
      ).catch(() => { /* non-fatal */ });

      logger.error(`Background task ${task.id} failed`, { error: err.message });
    }

    // Cleanup old completed tasks after 1 hour
    setTimeout(() => {
      if (task.status !== 'running') {
        this.tasks.delete(task.id);
      }
    }, 60 * 60 * 1000);
  }
}
