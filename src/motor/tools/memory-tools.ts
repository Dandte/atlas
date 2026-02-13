// ═══════════════════════════════════════
// ATLAS — Memory Tools
// Save and recall facts from semantic memory
// ═══════════════════════════════════════

import { Tool, ToolResult } from '../../types';
import { SemanticMemory } from '../../hippocampus/semantic';
import logger from '../../utils/logger';

/**
 * Memory Save Tool — stores facts in semantic memory
 */
export class MemorySaveTool implements Tool {
  private semantic: SemanticMemory;

  definition = {
    name: 'memory_save',
    description: 'Save a fact or piece of information to permanent memory. Use this to remember things the user tells you about themselves, their preferences, servers, passwords-hints, people, or any important information. Facts are stored as key-value pairs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          description: 'A short, descriptive key for the fact (e.g., "servidor_produccion_ip", "color_favorito", "nombre_esposa")',
        },
        value: {
          type: 'string',
          description: 'The value/content of the fact',
        },
        category: {
          type: 'string',
          description: 'Category for organization (e.g., "personal", "negocio", "servidor", "preferencia", "contacto")',
        },
      },
      required: ['key', 'value'],
    },
    dangerous: false,
  };

  constructor(semantic: SemanticMemory) {
    this.semantic = semantic;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const key = params.key as string;
    const value = params.value as string;
    const category = (params.category as string) || 'general';

    try {
      this.semantic.save(key, value, { category, source: 'user' });
      return {
        success: true,
        output: `Hecho guardado: "${key}" = "${value}" [${category}]`,
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Memory Recall Tool — searches and retrieves facts
 */
export class MemoryRecallTool implements Tool {
  private semantic: SemanticMemory;

  definition = {
    name: 'memory_recall',
    description: 'Search and retrieve facts from permanent memory. Use this to remember things previously stored about the user, their systems, preferences, etc. Can search by keyword or get all facts in a category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query — will match against keys and values',
        },
        category: {
          type: 'string',
          description: 'Filter by category (optional)',
        },
        key: {
          type: 'string',
          description: 'Get exact fact by key (optional, takes priority over query)',
        },
      },
      required: [],
    },
    dangerous: false,
  };

  constructor(semantic: SemanticMemory) {
    this.semantic = semantic;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = params.query as string | undefined;
    const category = params.category as string | undefined;
    const key = params.key as string | undefined;

    try {
      // Exact key lookup
      if (key) {
        const fact = this.semantic.getByKey(key);
        if (fact) {
          return {
            success: true,
            output: `${fact.key}: ${fact.value} [${fact.category}] (referenciado ${fact.timesReferenced} veces)`,
          };
        }
        return { success: true, output: `No se encontró ningún hecho con key "${key}"` };
      }

      // Category search
      if (category && !query) {
        const facts = this.semantic.getByCategory(category);
        if (facts.length === 0) {
          return { success: true, output: `No hay hechos en la categoría "${category}"` };
        }
        const lines = facts.map(f => `• ${f.key}: ${f.value}`);
        return { success: true, output: `[${category}] ${facts.length} hechos:\n${lines.join('\n')}` };
      }

      // Text search
      if (query) {
        const facts = this.semantic.search(query);
        if (facts.length === 0) {
          return { success: true, output: `No se encontraron hechos para "${query}"` };
        }
        const lines = facts.map(f => `• ${f.key}: ${f.value} [${f.category}]`);
        return { success: true, output: `${facts.length} resultado(s):\n${lines.join('\n')}` };
      }

      // No filters — return all facts
      const facts = this.semantic.getAll(30);
      if (facts.length === 0) {
        return { success: true, output: 'La memoria está vacía. No hay hechos guardados aún.' };
      }
      const lines = facts.map(f => `• ${f.key}: ${f.value} [${f.category}]`);
      return { success: true, output: `${facts.length} hecho(s) en memoria:\n${lines.join('\n')}` };

    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
