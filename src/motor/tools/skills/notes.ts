// ═══════════════════════════════════════
// ATLAS — Skill: Quick Notes
// Persistent notepad in SQLite
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../../types';
import type Database from 'better-sqlite3';

export class NotesTool implements Tool {
  private db: Database.Database;

  definition = {
    name: 'notes',
    description: 'Guardar y buscar notas rápidas. Bloc de notas persistente. Usar cuando digan "anotá", "apuntá", "guardá esto", "mis notas", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'search', 'delete'],
          description: 'Acción a realizar',
        },
        content: {
          type: 'string',
          description: 'Contenido de la nota (para save)',
        },
        tag: {
          type: 'string',
          description: 'Etiqueta/categoría (ej: ideas, pendientes, reunión)',
        },
        query: {
          type: 'string',
          description: 'Texto a buscar (para search)',
        },
        id: {
          type: 'number',
          description: 'ID de la nota (para delete)',
        },
      },
      required: ['action'],
    },
    dangerous: false,
  };

  constructor(db: Database.Database) {
    this.db = db;

    // Ensure notes table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        tag TEXT,
        source TEXT DEFAULT 'manual',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    switch (action) {
      case 'save': {
        const content = params.content as string | undefined;
        if (!content) return { success: false, output: '', error: '¿Qué querés anotar?' };

        const tag = (params.tag as string) || null;
        this.db.prepare('INSERT INTO notes (content, tag, source) VALUES (?, ?, ?)').run(content, tag, 'manual');

        return {
          success: true,
          output: `Nota guardada${tag ? ` [${tag}]` : ''}: "${content.substring(0, 100)}"`,
        };
      }

      case 'list': {
        const tag = params.tag as string | undefined;
        const notes = tag
          ? this.db.prepare('SELECT * FROM notes WHERE tag = ? ORDER BY created_at DESC LIMIT 20').all(tag) as any[]
          : this.db.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT 20').all() as any[];

        if (notes.length === 0) {
          return { success: true, output: 'No hay notas guardadas.' };
        }

        const formatted = notes.map((n: any) => {
          const date = new Date(n.created_at).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
          const tagStr = n.tag ? ` [${n.tag}]` : '';
          return `#${n.id} (${date})${tagStr}: ${n.content}`;
        }).join('\n');

        return { success: true, output: `Notas:\n\n${formatted}` };
      }

      case 'search': {
        const query = params.query as string | undefined;
        if (!query) return { success: false, output: '', error: '¿Qué buscás?' };

        const results = this.db.prepare(
          'SELECT * FROM notes WHERE content LIKE ? ORDER BY created_at DESC LIMIT 10'
        ).all(`%${query}%`) as any[];

        if (results.length === 0) {
          return { success: true, output: `No encontré notas con "${query}".` };
        }

        const formatted = results.map((n: any) => {
          const date = new Date(n.created_at).toLocaleDateString('es-CO');
          return `#${n.id} (${date}): ${n.content}`;
        }).join('\n');

        return { success: true, output: `Resultados para "${query}":\n\n${formatted}` };
      }

      case 'delete': {
        const id = params.id as number | undefined;
        if (!id) return { success: false, output: '', error: 'Necesito el ID de la nota.' };

        this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
        return { success: true, output: `Nota #${id} eliminada.` };
      }

      default:
        return { success: false, output: '', error: `Acción no reconocida: ${action}` };
    }
  }
}
