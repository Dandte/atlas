// ═══════════════════════════════════════
// ATLAS — Pin / Favorites Tool
// Save and recall important messages, links, notes
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult } from '../../types';
import logger from '../../utils/logger';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export class PinTool implements Tool {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  definition: ToolDefinition = {
    name: 'pin',
    description: 'Guardar y consultar favoritos/pins: mensajes importantes, links, notas, recordatorios. Los pins persisten permanentemente.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'search', 'remove', 'tags', 'get'],
          description: 'save=guardar pin, list=listar (opcionalmente por tag/categoría), search=buscar en contenido, remove=eliminar, tags=ver tags existentes, get=obtener un pin por ID',
        },
        content: { type: 'string', description: 'Contenido del pin (texto, link, nota)' },
        title: { type: 'string', description: 'Título corto del pin' },
        tags: { type: 'string', description: 'Tags separados por coma (ej: "trabajo,urgente,laravel")' },
        category: {
          type: 'string',
          enum: ['link', 'note', 'message', 'code', 'idea', 'task', 'reference', 'other'],
          description: 'Categoría del pin',
        },
        pin_id: { type: 'string', description: 'ID del pin (para get/remove)' },
        tag: { type: 'string', description: 'Filtrar por tag específico' },
        limit: { type: 'number', description: 'Máximo de resultados (default 20)' },
        query: { type: 'string', description: 'Texto a buscar en pins' },
      },
      required: ['action'],
    },
  };

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pins (
        id TEXT PRIMARY KEY,
        title TEXT,
        content TEXT NOT NULL,
        category TEXT DEFAULT 'note',
        tags TEXT DEFAULT '',
        channel TEXT,
        session_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pins_tags ON pins(tags);
      CREATE INDEX IF NOT EXISTS idx_pins_category ON pins(category);
      CREATE INDEX IF NOT EXISTS idx_pins_created ON pins(created_at);
    `);
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'save': return this.savePin(params);
        case 'list': return this.listPins(params);
        case 'search': return this.searchPins(params);
        case 'remove': return this.removePin(params);
        case 'tags': return this.listTags();
        case 'get': return this.getPin(params);
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      logger.error('Pin tool error', { action, error: err });
      return { success: false, output: '', error: `Error de pins: ${err.message}` };
    }
  }

  private savePin(params: Record<string, unknown>): ToolResult {
    const content = String(params.content || '');
    if (!content) return { success: false, output: '', error: 'Se requiere content.' };

    const id = uuid();
    const title = params.title ? String(params.title) : content.substring(0, 50) + (content.length > 50 ? '...' : '');
    const tags = params.tags ? String(params.tags).toLowerCase().split(',').map(t => t.trim()).filter(Boolean).join(',') : '';
    const category = String(params.category || 'note');

    this.db.prepare(
      `INSERT INTO pins (id, title, content, category, tags) VALUES (?, ?, ?, ?, ?)`
    ).run(id, title, content, category, tags);

    return {
      success: true,
      output: `📌 Pin guardado: "${title}"\nID: ${id}\nCategoría: ${category}${tags ? `\nTags: ${tags}` : ''}`,
    };
  }

  private listPins(params: Record<string, unknown>): ToolResult {
    const limit = Number(params.limit) || 20;
    const tag = params.tag ? String(params.tag).toLowerCase() : null;
    const category = params.category ? String(params.category) : null;

    let query = 'SELECT id, title, content, category, tags, created_at FROM pins WHERE 1=1';
    const queryParams: any[] = [];

    if (tag) {
      query += ' AND tags LIKE ?';
      queryParams.push(`%${tag}%`);
    }
    if (category) {
      query += ' AND category = ?';
      queryParams.push(category);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    queryParams.push(limit);

    const pins = this.db.prepare(query).all(...queryParams) as any[];

    if (pins.length === 0) {
      return { success: true, output: 'No hay pins guardados.' };
    }

    const formatted = pins.map((p: any) => {
      const date = new Date(p.created_at).toLocaleDateString('es-CO');
      const tags = p.tags ? ` [${p.tags}]` : '';
      const preview = p.content.length > 100 ? p.content.substring(0, 100) + '...' : p.content;
      return `📌 ${p.title}\n   ${p.category}${tags} | ${date} | ID: ${p.id.substring(0, 8)}\n   ${preview}`;
    });

    return {
      success: true,
      output: `📌 Pins (${pins.length}):\n\n${formatted.join('\n\n')}`,
    };
  }

  private searchPins(params: Record<string, unknown>): ToolResult {
    const query = String(params.query || '');
    if (!query) return { success: false, output: '', error: 'Se requiere query para buscar.' };

    const limit = Number(params.limit) || 20;
    const pins = this.db.prepare(
      `SELECT id, title, content, category, tags, created_at
       FROM pins WHERE content LIKE ? OR title LIKE ? OR tags LIKE ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as any[];

    if (pins.length === 0) {
      return { success: true, output: `No se encontraron pins con: "${query}"` };
    }

    const formatted = pins.map((p: any) => {
      const date = new Date(p.created_at).toLocaleDateString('es-CO');
      return `📌 ${p.title} (${p.category}) — ${date}\n   ${p.content.substring(0, 150)}`;
    });

    return {
      success: true,
      output: `🔍 "${query}" — ${pins.length} resultados:\n\n${formatted.join('\n\n')}`,
    };
  }

  private removePin(params: Record<string, unknown>): ToolResult {
    const pinId = String(params.pin_id || '');
    if (!pinId) return { success: false, output: '', error: 'Se requiere pin_id.' };

    // Support partial ID match
    const result = this.db.prepare('DELETE FROM pins WHERE id LIKE ?').run(`${pinId}%`);

    if (result.changes === 0) {
      return { success: false, output: '', error: `Pin no encontrado: ${pinId}` };
    }

    return { success: true, output: `Pin eliminado correctamente.` };
  }

  private listTags(): ToolResult {
    const rows = this.db.prepare(
      `SELECT tags FROM pins WHERE tags != '' AND tags IS NOT NULL`
    ).all() as any[];

    const tagCounts: Record<string, number> = {};
    for (const row of rows) {
      const tags = row.tags.split(',');
      for (const tag of tags) {
        const t = tag.trim();
        if (t) tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }

    const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

    if (sorted.length === 0) {
      return { success: true, output: 'No hay tags en los pins.' };
    }

    const formatted = sorted.map(([tag, count]) => `  ${tag} (${count})`);
    return {
      success: true,
      output: `🏷️ Tags (${sorted.length}):\n${formatted.join('\n')}`,
    };
  }

  private getPin(params: Record<string, unknown>): ToolResult {
    const pinId = String(params.pin_id || '');
    if (!pinId) return { success: false, output: '', error: 'Se requiere pin_id.' };

    const pin = this.db.prepare(
      'SELECT id, title, content, category, tags, created_at FROM pins WHERE id LIKE ?'
    ).get(`${pinId}%`) as any;

    if (!pin) {
      return { success: false, output: '', error: `Pin no encontrado: ${pinId}` };
    }

    return {
      success: true,
      output: `📌 ${pin.title}\nCategoría: ${pin.category}\nTags: ${pin.tags || '(ninguno)'}\nFecha: ${new Date(pin.created_at).toLocaleString('es-CO')}\nID: ${pin.id}\n\n${pin.content}`,
    };
  }
}
