// ═══════════════════════════════════════
// ATLAS — Export Chat Tool
// Export conversations to Markdown or PDF
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import { config } from '../../config/config';
import logger from '../../utils/logger';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class ExportChatTool implements Tool {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  definition: ToolDefinition = {
    name: 'export_chat',
    description: 'Exportar conversaciones a Markdown o PDF. Puede exportar sesión actual, rango de fechas, o búsqueda.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['session', 'date_range', 'search', 'today'],
          description: 'session=exportar sesión específica, date_range=por fechas, search=buscar y exportar, today=conversaciones de hoy',
        },
        session_id: { type: 'string', description: 'ID de la sesión a exportar' },
        start_date: { type: 'string', description: 'Fecha inicio (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'Fecha fin (YYYY-MM-DD)' },
        query: { type: 'string', description: 'Texto a buscar en conversaciones' },
        format: {
          type: 'string',
          enum: ['markdown', 'pdf', 'html', 'txt'],
          description: 'Formato de exportación (default: markdown)',
        },
        output_path: { type: 'string', description: 'Ruta de salida (opcional, default: ~/Desktop)' },
        include_tools: { type: 'boolean', description: 'Incluir llamadas a herramientas (default: false)' },
      },
      required: ['action'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');
    const format = String(params.format || 'markdown');
    const includeTools = !!params.include_tools;

    try {
      let episodes: any[];
      let title: string;

      switch (action) {
        case 'session': {
          const sessionId = String(params.session_id || '');
          if (!sessionId) return { success: false, output: '', error: 'Se requiere session_id.' };
          episodes = this.getSessionEpisodes(sessionId);
          title = `Sesión ${sessionId.substring(0, 8)}`;
          break;
        }
        case 'date_range': {
          const start = String(params.start_date || '');
          const end = String(params.end_date || '');
          if (!start) return { success: false, output: '', error: 'Se requiere start_date.' };
          episodes = this.getDateRangeEpisodes(start, end || start);
          title = `Conversaciones ${start}${end && end !== start ? ` a ${end}` : ''}`;
          break;
        }
        case 'search': {
          const query = String(params.query || '');
          if (!query) return { success: false, output: '', error: 'Se requiere query.' };
          episodes = this.searchEpisodes(query);
          title = `Búsqueda: "${query}"`;
          break;
        }
        case 'today': {
          episodes = this.getTodayEpisodes();
          title = `Conversaciones de hoy (${new Date().toLocaleDateString('es-CO')})`;
          break;
        }
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }

      if (episodes.length === 0) {
        return { success: true, output: 'No se encontraron conversaciones para exportar.' };
      }

      // Filter out tool calls if not requested
      if (!includeTools) {
        episodes = episodes.filter((e: any) => e.role !== 'tool');
      }

      // Generate content
      let content: string;
      let ext: string;

      switch (format) {
        case 'html':
          content = this.generateHTML(episodes, title);
          ext = 'html';
          break;
        case 'txt':
          content = this.generatePlainText(episodes, title);
          ext = 'txt';
          break;
        case 'pdf':
          // Generate HTML first, then convert
          content = this.generateHTML(episodes, title);
          ext = 'html'; // PDF requires external tool, export as HTML
          break;
        case 'markdown':
        default:
          content = this.generateMarkdown(episodes, title);
          ext = 'md';
          break;
      }

      // Determine output path
      const outputDir = params.output_path
        ? String(params.output_path).replace('~', os.homedir())
        : path.join(os.homedir(), 'Desktop');

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const filename = `atlas-export-${timestamp}.${ext}`;
      const filePath = path.join(outputDir, filename);

      fs.writeFileSync(filePath, content, 'utf-8');

      return {
        success: true,
        output: `Exportado exitosamente.\nArchivo: ${filePath}\nFormato: ${format}\nMensajes: ${episodes.length}\nTítulo: ${title}`,
      };
    } catch (err: any) {
      logger.error('Export chat failed', { error: err });
      return { success: false, output: '', error: `Error de exportación: ${err.message}` };
    }
  }

  private getSessionEpisodes(sessionId: string): any[] {
    return this.db.prepare(
      `SELECT role, content, tools_used, model, tokens_used, timestamp
       FROM episodes WHERE session_id = ? ORDER BY timestamp ASC`
    ).all(sessionId);
  }

  private getDateRangeEpisodes(start: string, end: string): any[] {
    return this.db.prepare(
      `SELECT role, content, tools_used, model, tokens_used, timestamp, session_id
       FROM episodes WHERE date(timestamp) BETWEEN ? AND ? ORDER BY timestamp ASC`
    ).all(start, end);
  }

  private searchEpisodes(query: string): any[] {
    return this.db.prepare(
      `SELECT role, content, tools_used, model, tokens_used, timestamp, session_id
       FROM episodes WHERE content LIKE ? ORDER BY timestamp DESC LIMIT 200`
    ).all(`%${query}%`);
  }

  private getTodayEpisodes(): any[] {
    return this.db.prepare(
      `SELECT role, content, tools_used, model, tokens_used, timestamp, session_id
       FROM episodes WHERE date(timestamp) = date('now','localtime') ORDER BY timestamp ASC`
    ).all();
  }

  private generateMarkdown(episodes: any[], title: string): string {
    const lines: string[] = [];
    lines.push(`# ${title}`);
    lines.push(`> Exportado por ATLAS el ${new Date().toLocaleString('es-CO')}`);
    lines.push(`> ${episodes.length} mensajes\n`);
    lines.push('---\n');

    let currentSession = '';
    for (const ep of episodes) {
      if (ep.session_id && ep.session_id !== currentSession) {
        currentSession = ep.session_id;
        lines.push(`\n## Sesión ${currentSession.substring(0, 8)}\n`);
      }

      const time = new Date(ep.timestamp).toLocaleTimeString('es-CO', { timeStyle: 'short' });
      const role = ep.role === 'user' ? '👤 Jose' : ep.role === 'assistant' ? '🤖 ATLAS' : `🔧 ${ep.role}`;

      lines.push(`### ${role} — ${time}`);
      if (ep.model) lines.push(`*Modelo: ${ep.model}*`);
      lines.push('');

      // Parse content
      const content = this.parseContent(ep.content);
      lines.push(content);
      lines.push('');
    }

    return lines.join('\n');
  }

  private generateHTML(episodes: any[], title: string): string {
    const styles = `
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #0f0f1a; color: #e0e0e0; }
      h1 { color: #00d4ff; border-bottom: 2px solid #00d4ff33; padding-bottom: 10px; }
      .message { margin: 16px 0; padding: 12px 16px; border-radius: 12px; }
      .user { background: #1a2a3a; border-left: 3px solid #00d4ff; }
      .assistant { background: #1a1a2e; border-left: 3px solid #7b68ee; }
      .tool { background: #1a2a1a; border-left: 3px solid #4caf50; font-size: 0.85em; }
      .meta { font-size: 0.8em; color: #888; margin-bottom: 8px; }
      .content { white-space: pre-wrap; line-height: 1.6; }
      code { background: #2a2a3e; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
      pre { background: #2a2a3e; padding: 12px; border-radius: 8px; overflow-x: auto; }
    `;

    const messages = episodes.map(ep => {
      const time = new Date(ep.timestamp).toLocaleTimeString('es-CO', { timeStyle: 'short' });
      const roleClass = ep.role === 'user' ? 'user' : ep.role === 'assistant' ? 'assistant' : 'tool';
      const roleLabel = ep.role === 'user' ? '👤 Jose' : ep.role === 'assistant' ? '🤖 ATLAS' : `🔧 ${ep.role}`;
      const content = this.parseContent(ep.content).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const model = ep.model ? ` | ${ep.model}` : '';

      return `<div class="message ${roleClass}"><div class="meta">${roleLabel} — ${time}${model}</div><div class="content">${content}</div></div>`;
    }).join('\n');

    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${title}</title><style>${styles}</style></head><body><h1>${title}</h1><p style="color:#888">Exportado por ATLAS el ${new Date().toLocaleString('es-CO')} — ${episodes.length} mensajes</p>${messages}</body></html>`;
  }

  private generatePlainText(episodes: any[], title: string): string {
    const lines: string[] = [];
    lines.push(title);
    lines.push('='.repeat(title.length));
    lines.push(`Exportado: ${new Date().toLocaleString('es-CO')}`);
    lines.push(`Mensajes: ${episodes.length}`);
    lines.push('');

    for (const ep of episodes) {
      const time = new Date(ep.timestamp).toLocaleTimeString('es-CO', { timeStyle: 'short' });
      const role = ep.role === 'user' ? 'Jose' : ep.role === 'assistant' ? 'ATLAS' : ep.role;

      lines.push(`[${time}] ${role}:`);
      lines.push(this.parseContent(ep.content));
      lines.push('');
    }

    return lines.join('\n');
  }

  private parseContent(content: string): string {
    // Content could be JSON array (Anthropic format) or plain string
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      }
      return content;
    } catch {
      return content || '';
    }
  }
}
