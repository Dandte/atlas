// ═══════════════════════════════════════
// ATLAS — Skill: Workflow Chains
// Define reusable multi-step workflows (macros)
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import Database from 'better-sqlite3';

interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  steps: string;
  cron: string | null;
  enabled: number;
  run_count: number;
  last_run: string | null;
  created_at: string;
}

export class WorkflowTool implements Tool {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        steps TEXT NOT NULL,
        cron TEXT,
        enabled INTEGER DEFAULT 1,
        run_count INTEGER DEFAULT 0,
        last_run DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  definition = {
    name: 'workflow',
    description:
      'Crear y gestionar workflows (secuencias de pasos reutilizables). ' +
      'Ejemplo: "todos los lunes: revisá ventas, generá reporte PDF, mandálo por email". ' +
      'Acciones: create, list, run, delete, info.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'run', 'delete', 'info'],
          description: 'Acción a realizar',
        },
        name: {
          type: 'string',
          description: 'Nombre del workflow',
        },
        id: {
          type: 'string',
          description: 'ID del workflow',
        },
        description: {
          type: 'string',
          description: 'Descripción del workflow (qué hace)',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pasos del workflow como array de instrucciones en lenguaje natural. Cada paso se ejecuta en orden.',
        },
        cron: {
          type: 'string',
          description: 'Expresión cron para ejecución automática (opcional). Ej: "0 9 * * 1" = lunes 9am',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    switch (action) {
      case 'create': {
        const name = String(params.name || '');
        if (!name) return { success: false, output: '', error: 'Necesito un nombre para el workflow.' };

        const steps = params.steps as string[] | undefined;
        if (!steps || !Array.isArray(steps) || steps.length === 0) {
          return { success: false, output: '', error: 'Necesito al menos un paso (steps: ["paso 1", "paso 2", ...]).' };
        }

        const id = params.id ? String(params.id)
          : name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const description = String(params.description || '');
        const cron = params.cron ? String(params.cron) : null;

        try {
          this.db.prepare(`
            INSERT INTO workflows (id, name, description, steps, cron)
            VALUES (?, ?, ?, ?, ?)
          `).run(id, name, description, JSON.stringify(steps), cron);
        } catch (err: any) {
          if (err.message?.includes('UNIQUE')) {
            return { success: false, output: '', error: `Ya existe un workflow con ID "${id}".` };
          }
          throw err;
        }

        let output = `Workflow creado: ${name}\n`;
        output += `  ID: ${id}\n`;
        output += `  Pasos (${steps.length}):\n`;
        steps.forEach((s, i) => output += `    ${i + 1}. ${s}\n`);
        if (cron) output += `  Cron: ${cron}\n`;
        output += `\nPara ejecutarlo: workflow(action: "run", id: "${id}")`;

        return { success: true, output };
      }

      case 'list': {
        const workflows = this.db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all() as WorkflowDef[];
        if (workflows.length === 0) return { success: true, output: 'No hay workflows definidos.' };

        let output = `${workflows.length} workflow(s):\n\n`;
        for (const wf of workflows) {
          const steps = JSON.parse(wf.steps) as string[];
          const status = wf.enabled ? '✅' : '❌';
          output += `${status} ${wf.name} (${wf.id})\n`;
          output += `   ${steps.length} pasos | Ejecutado ${wf.run_count}x`;
          if (wf.cron) output += ` | Cron: ${wf.cron}`;
          if (wf.last_run) output += ` | Último: ${wf.last_run}`;
          output += '\n\n';
        }
        return { success: true, output };
      }

      case 'run': {
        const id = String(params.id || params.name || '');
        if (!id) return { success: false, output: '', error: 'Necesito el ID del workflow.' };

        const wf = this.db.prepare('SELECT * FROM workflows WHERE id = ? AND enabled = 1').get(id) as WorkflowDef | undefined;
        if (!wf) return { success: false, output: '', error: `Workflow "${id}" no encontrado o deshabilitado.` };

        const steps = JSON.parse(wf.steps) as string[];

        // Update run count
        this.db.prepare("UPDATE workflows SET run_count = run_count + 1, last_run = datetime('now') WHERE id = ?").run(id);

        // Return steps for the model to execute
        let output = `Ejecutando workflow "${wf.name}" (${steps.length} pasos):\n\n`;
        output += `INSTRUCCIONES: Ejecutá los siguientes pasos EN ORDEN. Cada paso puede requerir llamar a una o más tools. `;
        output += `Reportá el resultado de cada paso antes de continuar con el siguiente.\n\n`;

        steps.forEach((step, i) => {
          output += `PASO ${i + 1}: ${step}\n`;
        });

        output += `\nCuando termines todos los pasos, reportá un resumen del workflow completo.`;

        return { success: true, output };
      }

      case 'delete': {
        const id = String(params.id || params.name || '');
        if (!id) return { success: false, output: '', error: 'Necesito el ID del workflow.' };

        const result = this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
        return result.changes > 0
          ? { success: true, output: `Workflow "${id}" eliminado.` }
          : { success: false, output: '', error: `Workflow "${id}" no encontrado.` };
      }

      case 'info': {
        const id = String(params.id || params.name || '');
        if (!id) return { success: false, output: '', error: 'Necesito el ID del workflow.' };

        const wf = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowDef | undefined;
        if (!wf) return { success: false, output: '', error: `Workflow "${id}" no encontrado.` };

        const steps = JSON.parse(wf.steps) as string[];
        let output = `Workflow: ${wf.name}\n`;
        output += `  ID: ${wf.id}\n`;
        output += `  Descripción: ${wf.description || '(sin descripción)'}\n`;
        output += `  Habilitado: ${wf.enabled ? 'Sí' : 'No'}\n`;
        output += `  Ejecutado: ${wf.run_count} veces\n`;
        output += `  Último: ${wf.last_run || 'Nunca'}\n`;
        if (wf.cron) output += `  Cron: ${wf.cron}\n`;
        output += `\n  Pasos:\n`;
        steps.forEach((s, i) => output += `    ${i + 1}. ${s}\n`);

        return { success: true, output };
      }

      default:
        return { success: false, output: '', error: `Acción desconocida: ${action}. Usar: create, list, run, delete, info` };
    }
  }
}
