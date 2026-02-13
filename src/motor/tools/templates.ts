// ═══════════════════════════════════════
// ATLAS — Conversation Templates Tool
// Predefined conversation flows and templates
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import logger from '../../utils/logger';
import Database from 'better-sqlite3';

interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  prompt: string;
  variables: string; // JSON array of variable names
  created_at: string;
  usage_count: number;
}

export class TemplatesTool implements Tool {
  private db: Database.Database;

  definition: ToolDefinition = {
    name: 'templates',
    description: 'Gestiona plantillas de conversación predefinidas. Permite ejecutar flujos complejos con un solo comando. Acciones: run (ejecutar plantilla), list (ver disponibles), create (crear nueva), edit (modificar), remove (eliminar), categories (ver categorías).',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'list', 'create', 'edit', 'remove', 'categories'],
          description: 'Acción a realizar',
        },
        template_id: {
          type: 'string',
          description: 'ID o nombre de la plantilla (para run/edit/remove)',
        },
        name: {
          type: 'string',
          description: 'Nombre de la plantilla (para create/edit)',
        },
        description: {
          type: 'string',
          description: 'Descripción de la plantilla (para create/edit)',
        },
        category: {
          type: 'string',
          description: 'Categoría: finance, tech, business, communication, analysis, custom. Default: custom',
        },
        prompt: {
          type: 'string',
          description: 'Prompt template. Usa {{variable}} para variables dinámicas.',
        },
        variables: {
          type: 'object',
          description: 'Variables para reemplazar en el template al ejecutar (para run). Ej: {"month": "enero", "account": "personal"}',
        },
      },
      required: ['action'],
    },
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTable();
    this.seedDefaults();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'custom',
        prompt TEXT NOT NULL,
        variables TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        usage_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  private seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM conversation_templates').get() as any).c;
    if (count > 0) return;

    const defaults: Omit<Template, 'created_at' | 'usage_count'>[] = [
      {
        id: 'monthly-finance',
        name: 'Reporte Financiero Mensual',
        description: 'Genera un reporte completo de ingresos y gastos del mes',
        category: 'finance',
        prompt: 'Generá un reporte financiero completo del mes {{month}}. Usá la herramienta financial para obtener el resumen mensual de la cuenta {{account}}. Incluí: total ingresos, total gastos, balance, top 5 gastos, comparación con mes anterior si hay datos.',
        variables: JSON.stringify(['month', 'account']),
      },
      {
        id: 'server-audit',
        name: 'Auditoría de Servidores',
        description: 'Revisa estado de todos los servidores y servicios',
        category: 'tech',
        prompt: 'Hacé una auditoría completa de servidores. 1) Revisá el sistema local con system_info. 2) Hacé health_check de los servidores configurados. 3) Revisá uso de disco y memoria. 4) Verificá si hay actualizaciones pendientes. Presentá un reporte estructurado con status de cada servicio.',
        variables: JSON.stringify([]),
      },
      {
        id: 'whatsapp-digest',
        name: 'Resumen WhatsApp',
        description: 'Resumen de actividad de WhatsApp del día',
        category: 'communication',
        prompt: 'Dame un resumen completo de la actividad de WhatsApp de hoy. Usá la herramienta whatsapp con action=summary. Incluí: mensajes más importantes, conversaciones activas, temas principales discutidos. Si hay mensajes sin leer, listálos.',
        variables: JSON.stringify([]),
      },
      {
        id: 'market-research',
        name: 'Investigación de Mercado',
        description: 'Investiga un tema o producto en el mercado',
        category: 'business',
        prompt: 'Investigá "{{topic}}" en el mercado colombiano. Buscá en web: competencia, precios, tendencias, oportunidades. Presentá un análisis FODA y recomendaciones para {{company}}.',
        variables: JSON.stringify(['topic', 'company']),
      },
      {
        id: 'code-review',
        name: 'Code Review',
        description: 'Revisa código de un directorio o archivo',
        category: 'tech',
        prompt: 'Hacé un code review de {{path}}. Revisá: 1) Calidad del código. 2) Posibles bugs. 3) Seguridad (SQL injection, XSS, etc). 4) Performance. 5) Best practices. Presentá findings con severidad (critical/warning/info) y sugerencias de mejora.',
        variables: JSON.stringify(['path']),
      },
      {
        id: 'daily-briefing',
        name: 'Briefing del Día',
        description: 'Resumen matutino completo con todas las fuentes',
        category: 'analysis',
        prompt: 'Preparame el briefing del día. Incluí: 1) Estado del sistema (system_info). 2) Tareas programadas para hoy. 3) Resumen de WhatsApp overnight. 4) Hechos recientes guardados en memoria. 5) Clima para hoy. 6) Cualquier anomalía detectada.',
        variables: JSON.stringify([]),
      },
      {
        id: 'email-digest',
        name: 'Resumen de Emails',
        description: 'Lee y resume los emails no leídos',
        category: 'communication',
        prompt: 'Revisá mis emails no leídos de las últimas {{hours}} horas. Usá la herramienta email con action=read, folder=INBOX, unread_only=true. Presentá un resumen agrupado por remitente con: asunto, fecha, resumen de 1 línea, prioridad estimada (alta/media/baja).',
        variables: JSON.stringify(['hours']),
      },
    ];

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO conversation_templates (id, name, description, category, prompt, variables) VALUES (?, ?, ?, ?, ?, ?)`
    );

    for (const t of defaults) {
      insert.run(t.id, t.name, t.description, t.category, t.prompt, t.variables);
    }
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || 'list');

    try {
      switch (action) {
        case 'list': return this.listTemplates(String(params.category || ''));
        case 'run': return this.runTemplate(String(params.template_id || ''), params.variables as Record<string, string> || {});
        case 'create': return this.createTemplate(params);
        case 'edit': return this.editTemplate(params);
        case 'remove': return this.removeTemplate(String(params.template_id || ''));
        case 'categories': return this.getCategories();
        default: return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Templates error', { error: err, action });
      return { success: false, output: '', error: `Error templates: ${err.message}` };
    }
  }

  private listTemplates(category: string): ToolResult {
    const query = category
      ? 'SELECT * FROM conversation_templates WHERE category = ? ORDER BY usage_count DESC'
      : 'SELECT * FROM conversation_templates ORDER BY category, usage_count DESC';
    const templates = category
      ? this.db.prepare(query).all(category) as Template[]
      : this.db.prepare(query).all() as Template[];

    if (templates.length === 0) {
      return { success: true, output: category ? `No hay plantillas en categoría "${category}".` : 'No hay plantillas.' };
    }

    let currentCat = '';
    const lines: string[] = [`📋 Plantillas disponibles (${templates.length}):\n`];
    for (const t of templates) {
      if (t.category !== currentCat) {
        currentCat = t.category;
        lines.push(`\n── ${currentCat.toUpperCase()} ──`);
      }
      const vars = JSON.parse(t.variables || '[]');
      const varStr = vars.length > 0 ? ` [vars: ${vars.join(', ')}]` : '';
      lines.push(`  ${t.id} — ${t.name}${varStr}`);
      lines.push(`    ${t.description} (usado ${t.usage_count}x)`);
    }

    return { success: true, output: lines.join('\n') };
  }

  private runTemplate(templateId: string, variables: Record<string, string>): ToolResult {
    if (!templateId) return { success: false, output: '', error: 'Se requiere template_id' };

    const template = this.db.prepare(
      'SELECT * FROM conversation_templates WHERE id = ? OR name LIKE ?'
    ).get(templateId, `%${templateId}%`) as Template | undefined;

    if (!template) {
      return { success: false, output: '', error: `Plantilla "${templateId}" no encontrada` };
    }

    // Replace variables
    let prompt = template.prompt;
    const requiredVars = JSON.parse(template.variables || '[]') as string[];
    const missing: string[] = [];

    for (const varName of requiredVars) {
      if (variables[varName]) {
        prompt = prompt.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), variables[varName]);
      } else {
        missing.push(varName);
      }
    }

    if (missing.length > 0) {
      return {
        success: false, output: '',
        error: `Variables faltantes: ${missing.join(', ')}. Proporcionálas en el campo "variables".`,
      };
    }

    // Update usage count
    this.db.prepare('UPDATE conversation_templates SET usage_count = usage_count + 1 WHERE id = ?').run(template.id);

    return {
      success: true,
      output: `[TEMPLATE: ${template.name}]\n\n${prompt}`,
    };
  }

  private createTemplate(params: Record<string, unknown>): ToolResult {
    const name = String(params.name || '');
    const prompt = String(params.prompt || '');
    if (!name || !prompt) return { success: false, output: '', error: 'Se requiere name y prompt' };

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const description = String(params.description || '');
    const category = String(params.category || 'custom');

    // Extract variables from prompt
    const varMatches = prompt.match(/\{\{(\w+)\}\}/g) || [];
    const variables = [...new Set(varMatches.map(v => v.replace(/[{}]/g, '')))];

    this.db.prepare(
      `INSERT INTO conversation_templates (id, name, description, category, prompt, variables) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, name, description, category, prompt, JSON.stringify(variables));

    return {
      success: true,
      output: `Plantilla creada: ${id}\nNombre: ${name}\nCategoría: ${category}\nVariables: ${variables.length > 0 ? variables.join(', ') : 'ninguna'}`,
    };
  }

  private editTemplate(params: Record<string, unknown>): ToolResult {
    const id = String(params.template_id || '');
    if (!id) return { success: false, output: '', error: 'Se requiere template_id' };

    const existing = this.db.prepare('SELECT * FROM conversation_templates WHERE id = ?').get(id) as Template | undefined;
    if (!existing) return { success: false, output: '', error: `Plantilla "${id}" no encontrada` };

    const name = params.name ? String(params.name) : existing.name;
    const description = params.description ? String(params.description) : existing.description;
    const category = params.category ? String(params.category) : existing.category;
    const prompt = params.prompt ? String(params.prompt) : existing.prompt;

    const varMatches = prompt.match(/\{\{(\w+)\}\}/g) || [];
    const variables = [...new Set(varMatches.map(v => v.replace(/[{}]/g, '')))];

    this.db.prepare(
      `UPDATE conversation_templates SET name = ?, description = ?, category = ?, prompt = ?, variables = ? WHERE id = ?`
    ).run(name, description, category, prompt, JSON.stringify(variables), id);

    return { success: true, output: `Plantilla "${id}" actualizada.` };
  }

  private removeTemplate(id: string): ToolResult {
    if (!id) return { success: false, output: '', error: 'Se requiere template_id' };
    const result = this.db.prepare('DELETE FROM conversation_templates WHERE id = ?').run(id);
    return result.changes > 0
      ? { success: true, output: `Plantilla "${id}" eliminada.` }
      : { success: false, output: '', error: `Plantilla "${id}" no encontrada.` };
  }

  private getCategories(): ToolResult {
    const rows = this.db.prepare(
      'SELECT category, COUNT(*) as count FROM conversation_templates GROUP BY category ORDER BY count DESC'
    ).all() as { category: string; count: number }[];

    const lines = rows.map(r => `  ${r.category}: ${r.count} plantillas`);
    return { success: true, output: `Categorías:\n${lines.join('\n')}` };
  }
}
